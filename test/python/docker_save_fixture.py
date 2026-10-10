"""Members of a minimal archive in the layout `docker save` (Docker 25+) writes.

manifest.json names the config blob (the image ID on Docker's classic image store); oci-layout and
index.json name one OCI image manifest, whose digest is the image ID on the containerd image store
(the odroid, #784). The real release artifact for 11bb45f7 has exactly this shape.
"""

import hashlib
import io
import json
import tarfile


def digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def docker_save_members(tag: str, config: bytes, layers: tuple[bytes, ...] = ()) -> tuple[list[tuple[str, bytes]], str]:
    """(archive members as (name, bytes), manifest digest) for one image tagged tag."""
    config_path = "blobs/sha256/" + digest(config)[7:]
    layer_paths = ["blobs/sha256/" + digest(layer)[7:] for layer in layers]
    image_manifest = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": digest(config), "size": len(config)},
            "layers": [
                {"mediaType": "application/vnd.oci.image.layer.v1.tar", "digest": digest(layer), "size": len(layer)}
                for layer in layers
            ],
        }
    ).encode()
    manifest_id = digest(image_manifest)
    index = {
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.index.v1+json",
        "manifests": [
            {
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "digest": manifest_id,
                "size": len(image_manifest),
                "annotations": {"io.containerd.image.name": tag, "org.opencontainers.image.ref.name": tag.rpartition(":")[2]},
            }
        ],
    }
    members = [
        ("manifest.json", json.dumps([{"Config": config_path, "RepoTags": [tag], "Layers": layer_paths}]).encode()),
        (config_path, config),
        *zip(layer_paths, layers),
        ("blobs/sha256/" + manifest_id[7:], image_manifest),
        ("index.json", json.dumps(index).encode()),
        ("oci-layout", b'{"imageLayoutVersion": "1.0.0"}'),
    ]
    return members, manifest_id


def add_members(tar: tarfile.TarFile, members: list[tuple[str, bytes]]) -> None:
    for name, data in members:
        info = tarfile.TarInfo(name)
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
