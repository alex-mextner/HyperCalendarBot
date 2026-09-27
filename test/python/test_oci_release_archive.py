"""OCI layout -> docker-save conversion feeding the release artifact checks.

Builds real OCI image-layout tars shaped like Apple's `container image save`
output (a named outer index, a nested index with the linux/amd64 manifest plus
an unknown/unknown attestation manifest, gzip layers), converts them, and runs
the converted archive through scripts/release-artifact.py.
"""

import gzip
import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def layer_tar(files):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class OciConversionTests(unittest.TestCase):
    def setUp(self):
        self.convert = load("oci_to_docker_archive", "scripts/oci-to-docker-archive.py")
        self.artifact = load("release_artifact", "scripts/release-artifact.py")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.sha = "a" * 40
        self.tag = "ghcr.io/alex-mextner/hypercalendarbot:" + self.sha

    def oci(
        self,
        *,
        arch="amd64",
        name=None,
        tamper_layer=False,
        wrong_diff_id=False,
        layer_type="application/vnd.oci.image.layer.v1.tar+gzip",
        extra_member=None,
        duplicate_layer=False,
        corrupt_gzip=False,
        rootfs=None,
    ):
        blobs = {}

        def put(data):
            blobs[digest(data)] = data
            return digest(data)

        layers = [layer_tar({"app/one.txt": b"one"}), layer_tar({"app/two.txt": b"two"})]
        if duplicate_layer:
            layers[1] = layers[0]
        if "gzip" in layer_type:
            compressed = [gzip.compress(layer, mtime=0) for layer in layers]
        else:
            compressed = list(layers)
        if corrupt_gzip:  # valid gzip header, broken deflate body, digest still consistent
            compressed[0] = gzip.compress(layers[0], mtime=0)[:10] + b"\x00" * 64
        diff_ids = [digest(layer) for layer in layers]
        if wrong_diff_id:
            diff_ids[1] = "sha256:" + "0" * 64
        config = json.dumps(
            {
                "architecture": arch,
                "os": "linux",
                "config": {"Labels": {"org.opencontainers.image.revision": self.sha}},
                "rootfs": rootfs if rootfs is not None else {"type": "layers", "diff_ids": diff_ids},
            }
        ).encode()
        manifest = json.dumps(
            {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": {
                    "mediaType": "application/vnd.oci.image.config.v1+json",
                    "digest": put(config),
                    "size": len(config),
                },
                "layers": [
                    {"mediaType": layer_type, "digest": put(blob), "size": len(blob)}
                    for blob in compressed
                ],
            }
        ).encode()
        attestation_config = json.dumps({"architecture": "unknown", "os": "unknown"}).encode()
        attestation = json.dumps(
            {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": {
                    "mediaType": "application/vnd.oci.image.config.v1+json",
                    "digest": put(attestation_config),
                    "size": len(attestation_config),
                },
                "layers": [],
            }
        ).encode()
        nested = json.dumps(
            {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.index.v1+json",
                "manifests": [
                    {
                        "mediaType": "application/vnd.oci.image.manifest.v1+json",
                        "digest": put(manifest),
                        "size": len(manifest),
                        "platform": {"architecture": arch, "os": "linux"},
                    },
                    {
                        "mediaType": "application/vnd.oci.image.manifest.v1+json",
                        "digest": put(attestation),
                        "size": len(attestation),
                        "platform": {"architecture": "unknown", "os": "unknown"},
                    },
                ],
            }
        ).encode()
        ref = name or self.tag
        index = json.dumps(
            {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.index.v1+json",
                "manifests": [
                    {
                        "mediaType": "application/vnd.oci.image.index.v1+json",
                        "digest": put(nested),
                        "size": len(nested),
                        "annotations": {
                            "io.containerd.image.name": ref,
                            "org.opencontainers.image.ref.name": ref,
                        },
                    }
                ],
            }
        ).encode()
        if tamper_layer:
            blobs[digest(compressed[0])] = gzip.compress(layers[0] + b"x", mtime=0)
        path = self.dir / "image.oci.tar"
        with tarfile.open(path, "w") as tar:
            members = [("oci-layout", b'{"imageLayoutVersion":"1.0.0"}'), ("index.json", index)]
            members += [("blobs/sha256/" + d.removeprefix("sha256:"), b) for d, b in blobs.items()]
            if extra_member:
                members.append(extra_member)
            for member_name, data in members:
                info = tarfile.TarInfo(member_name)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        return path, digest(config)

    def converted(self, source):
        target = self.dir / "image.tar"
        config_id = self.convert.convert(source, target, self.tag)
        packed = self.dir / "image.tar.gz"
        packed.write_bytes(gzip.compress(target.read_bytes(), mtime=0))
        return target, packed, config_id

    def test_apple_style_layout_becomes_a_valid_release_artifact(self):
        source, config_id = self.oci()
        target, packed, converted_id = self.converted(source)
        self.assertEqual(converted_id, config_id)
        result = self.artifact.inspect_archive(packed, self.sha, self.tag)
        self.assertEqual(result["config_digest"], config_id)
        self.assertEqual((result["os"], result["architecture"]), ("linux", "amd64"))
        with tarfile.open(target) as tar:
            manifest = json.load(tar.extractfile("manifest.json"))
            self.assertEqual(manifest[0]["RepoTags"], [self.tag])
            # Layers are stored uncompressed, named by their diff_id, as `docker save` does.
            for layer in manifest[0]["Layers"]:
                data = tar.extractfile(layer).read()
                self.assertEqual("blobs/sha256/" + hashlib.sha256(data).hexdigest(), layer)

    def test_uncompressed_oci_and_docker_layer_types_convert_too(self):
        for layer_type in (
            "application/vnd.oci.image.layer.v1.tar",
            "application/vnd.docker.image.rootfs.diff.tar.gzip",
        ):
            with self.subTest(layer_type=layer_type):
                source, config_id = self.oci(layer_type=layer_type)
                _, packed, _ = self.converted(source)
                result = self.artifact.inspect_archive(packed, self.sha, self.tag)
                self.assertEqual(result["config_digest"], config_id)

    def test_repeated_layer_is_stored_once_but_listed_in_order(self):
        source, config_id = self.oci(duplicate_layer=True)
        target, packed, _ = self.converted(source)
        with tarfile.open(target) as tar:
            layers = json.load(tar.extractfile("manifest.json"))[0]["Layers"]
            names = tar.getnames()
        self.assertEqual(len(layers), 2)
        self.assertEqual(layers[0], layers[1])
        self.assertEqual(names.count(layers[0]), 1)
        self.assertEqual(
            self.artifact.inspect_archive(packed, self.sha, self.tag)["config_digest"], config_id
        )

    def test_rejects_wrong_platform_tag_integrity_and_unsupported_layers(self):
        cases = [
            ({"arch": "arm64"}, "Expected exactly one linux/amd64"),
            ({"name": "ghcr.io/other/image:latest"}, "is not named in index.json"),
            ({"tamper_layer": True}, "Layer digest mismatch"),
            ({"wrong_diff_id": True}, "diff_id mismatch"),
            (
                {"layer_type": "application/vnd.oci.image.layer.v1.tar+zstd"},
                "Unsupported layer media type",
            ),
            ({"extra_member": ("../escape", b"x")}, "Unsafe archive member path"),
            ({"extra_member": ("index.json", b"{}")}, "Duplicate archive entry"),
            ({"corrupt_gzip": True}, "Unreadable layer"),
            ({"rootfs": ["x"]}, "do not match config rootfs.diff_ids"),
        ]
        for kwargs, message in cases:
            with self.subTest(kwargs=kwargs):
                source, _ = self.oci(**kwargs)
                with self.assertRaisesRegex(self.convert.ConversionError, message):
                    self.convert.convert(source, self.dir / "image.tar", self.tag)
                self.assertFalse((self.dir / "image.tar").exists())


if __name__ == "__main__":
    unittest.main()
