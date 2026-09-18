"""Artifact identity tests use real tar archives and synthetic Docker configs."""

import hashlib
import importlib.util
import io
import json
import tempfile
import tarfile
import unittest
from pathlib import Path

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
        arch="amd64",
        duplicate=False,
        bad_digest=False,
        tag=None,
    ):
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
        digest = hashlib.sha256(config).hexdigest()
        path = "blobs/sha256/" + ("f" * 64 if bad_digest else digest)
        manifest = [{"Config": path, "RepoTags": [tag or self.tag], "Layers": []}]
        target = Path(self.tmp.name) / "image.tar.gz"
        with tarfile.open(target, "w:gz") as tar:
            items = [("manifest.json", json.dumps(manifest).encode()), (path, config)]
            if duplicate:
                items.append((path, config))
            for name, data in items:
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        return target, "sha256:" + digest

    def test_returns_config_digest_not_local_manifest_id(self):
        archive, config_id = self.archive()
        result = self.module.inspect_archive(archive, self.sha, self.tag)
        self.assertEqual(result["config_digest"], config_id)
        self.assertEqual(result["revision"], self.sha)
        self.assertEqual(result["architecture"], "amd64")
        self.assertEqual(len(result["archive_sha256"]), 64)

    def test_rejects_wrong_revision_arch_tag_digest_and_duplicate(self):
        for args in [
            {"revision": "b" * 40},
            {"arch": "arm64"},
            {"tag": "elsewhere:latest"},
            {"bad_digest": True},
            {"duplicate": True},
        ]:
            with self.subTest(args=args):
                archive, _ = self.archive(**args)
                with self.assertRaises(ValueError):
                    self.module.inspect_archive(archive, self.sha, self.tag)

    def test_rejects_invalid_sha_before_loading_archive(self):
        archive, _ = self.archive()
        with self.assertRaises(ValueError):
            self.module.inspect_archive(archive, "main", self.tag)

    def test_refuses_symlink_config_in_tar(self):
        archive, _ = self.archive()
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
