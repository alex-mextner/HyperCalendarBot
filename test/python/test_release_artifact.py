"""Artifact identity tests use real tar archives and synthetic Docker configs."""

import gzip
import importlib.util
import io
import json
import tempfile
import tarfile
import unittest
from pathlib import Path

from docker_save_fixture import add_members, digest, docker_save_members

ROOT = Path(__file__).resolve().parents[2]


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location(
            "release_artifact", ROOT / "scripts/release-artifact.py"
        )
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.sha = "a" * 40
        self.tag = "hypercalendarbot:" + self.sha

    def archive(
        self,
        *,
        revision=None,
        arch="arm64",
        duplicate=False,
        bad_digest=False,
        tag=None,
        edit=None,
    ):
        """A docker-save archive; edit(members) may rewrite its (name, bytes) members first."""
        config = json.dumps(
            {
                "architecture": arch,
                "os": "linux",
                "config": {
                    "Labels": {
                        "org.opencontainers.image.revision": revision or self.sha
                    }
                },
                "rootfs": {"type": "layers", "diff_ids": ["sha256:" + "c" * 64]},
            }
        ).encode()
        members, manifest_id = docker_save_members(tag or self.tag, config)
        if bad_digest:
            members = [
                (name.replace(digest(config)[7:], "f" * 64), data.replace(digest(config)[7:].encode(), b"f" * 64))
                for name, data in members
            ]
        if duplicate:
            members.append(members[1])
        if edit:
            members = edit(members)
        target = Path(self.tmp.name) / "image.tar.gz"
        with tarfile.open(target, "w:gz") as tar:
            add_members(tar, members)
        return target, digest(config), manifest_id

    def test_returns_config_and_containerd_manifest_digests(self):
        archive, config_id, manifest_id = self.archive()
        result = self.module.inspect_archive(archive, self.sha, self.tag)
        self.assertEqual(result["config_digest"], config_id)
        # What a containerd-store `docker load` reports as the image's .Id (the odroid, #784).
        self.assertEqual(result["manifest_digest"], manifest_id)
        self.assertNotEqual(manifest_id, config_id)
        self.assertEqual(result["revision"], self.sha)
        self.assertEqual(result["architecture"], "arm64")
        self.assertEqual(len(result["archive_sha256"]), 64)

    def test_real_release_archive_reports_the_id_the_odroid_containerd_store_gave_it(self):
        # The metadata members (layers dropped) of the CI `docker save` artifact for 11bb45f7, whose
        # first odroid deploy (run 38018033717) failed: Docker 29's containerd store reported the
        # loaded image's .Id as sha256:f0828776…, the manifest index.json names (#784).
        revision = "11bb45f709a2669dd86d65a0df0ab6dfb77eb5fc"
        target = Path(self.tmp.name) / "image.tar.gz"
        target.write_bytes(gzip.compress((ROOT / "test/python/fixtures/release-11bb45f7-metadata.tar").read_bytes()))
        result = self.module.inspect_archive(target, revision, "ghcr.io/alex-mextner/hypercalendarbot:" + revision)
        self.assertEqual(result["config_digest"], "sha256:37e137874b54ddd9d3f77006dbf94a0b7b8fcb591ddf0de50b97fbf5429631a2")
        self.assertEqual(result["manifest_digest"], "sha256:f082877686a7f43cb915a9a265ba3aa23a4bdb6f1a1433f9a786b52d8f6b266a")

    def test_rejects_wrong_revision_arch_tag_digest_and_duplicate(self):
        for args in [
            {"revision": "b" * 40},
            {"arch": "amd64"},
            {"tag": "elsewhere:latest"},
            {"bad_digest": True},
            {"duplicate": True},
        ]:
            with self.subTest(args=args):
                archive, _, _ = self.archive(**args)
                with self.assertRaises(ValueError):
                    self.module.inspect_archive(archive, self.sha, self.tag)

    def test_rejects_an_oci_index_that_does_not_name_this_image_manifest(self):
        def is_image_manifest(member):
            # Only the image manifest names the config media type (the config's rootfs says "layers").
            return b"application/vnd.oci.image.config" in member[1]

        def drop(name):
            return lambda members: [m for m in members if m[0] != name]

        def rewrite_index(change):
            def edit(members):
                out = []
                for name, data in members:
                    if name == "index.json":
                        index = json.loads(data)
                        change(index)
                        data = json.dumps(index).encode()
                    out.append((name, data))
                return out

            return edit

        def rewrite_manifest(members):
            # A manifest blob, correctly named by its own digest, for some other config.
            other = json.dumps({"schemaVersion": 2, "config": {"digest": "sha256:" + "e" * 64}}).encode()
            index_at = next(i for i, m in enumerate(members) if m[0] == "index.json")
            index = json.loads(members[index_at][1])
            index["manifests"][0].update(digest=digest(other), size=len(other))
            members[index_at] = ("index.json", json.dumps(index).encode())
            return members + [("blobs/sha256/" + digest(other)[7:], other)]

        def tamper_manifest(members):
            # Same name and size, different bytes: the indexed digest no longer matches.
            return [
                (name, data.replace(b'"schemaVersion": 2', b'"schemaVersion": 3')) if is_image_manifest((name, data)) else (name, data)
                for name, data in members
            ]

        def second(index):
            index["manifests"].append(dict(index["manifests"][0]))

        def nested(index):
            index["manifests"][0]["mediaType"] = "application/vnd.oci.image.index.v1+json"

        def other_name(index):
            index["manifests"][0]["annotations"]["io.containerd.image.name"] = "elsewhere:latest"

        def no_annotations(index):
            del index["manifests"][0]["annotations"]

        def wrong_size(index):
            index["manifests"][0]["size"] += 1

        # Each case must fail for its own reason, not an earlier unrelated one.
        cases = {
            "no oci-layout": (drop("oci-layout"), "Missing artifact member"),
            "no index.json": (drop("index.json"), "Missing artifact member"),
            "manifest blob missing": (lambda members: [m for m in members if not is_image_manifest(m)], "Missing artifact member"),
            "two indexed images": (rewrite_index(second), "Exactly one indexed image"),
            "indexed image is an index": (rewrite_index(nested), "single image manifest"),
            "indexed for another tag": (rewrite_index(other_name), "Indexed image tag mismatch"),
            "unnamed indexed image": (rewrite_index(no_annotations), "Indexed image tag mismatch"),
            "indexed size mismatch": (rewrite_index(wrong_size), "Image manifest digest mismatch"),
            "manifest bytes tampered": (tamper_manifest, "Image manifest digest mismatch"),
            "manifest for another config": (rewrite_manifest, "does not describe the image config"),
        }
        for label, (edit, reason) in cases.items():
            with self.subTest(label):
                archive, _, _ = self.archive(edit=edit)
                with self.assertRaisesRegex(ValueError, reason):
                    self.module.inspect_archive(archive, self.sha, self.tag)

    def test_rejects_invalid_sha_before_loading_archive(self):
        archive, _, _ = self.archive()
        with self.assertRaises(ValueError):
            self.module.inspect_archive(archive, "main", self.tag)

    def test_refuses_symlink_config_in_tar(self):
        archive, _, _ = self.archive()
        config_path = "blobs/sha256/" + "f" * 64
        with tarfile.open(archive, "w:gz") as tar:
            data = json.dumps(
                [{"Config": config_path, "RepoTags": [self.tag], "Layers": []}]
            ).encode()
            info = tarfile.TarInfo("manifest.json")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
            info = tarfile.TarInfo(config_path)
            info.type = tarfile.SYMTYPE
            info.linkname = "/etc/passwd"
            tar.addfile(info)
        with self.assertRaises(ValueError):
            self.module.inspect_archive(archive, self.sha, self.tag)


if __name__ == "__main__":
    unittest.main()
