#!/usr/bin/env python3
"""Inspect a Docker save archive without extraction or trusting a local image-store ID.

The archive names the image two ways, and Docker's image store decides which one `docker load`
turns into the image's `.Id` (and a container's `.Image`): the classic store uses the config
digest; the containerd store (Docker 29 on the odroid, #784) uses the digest of the manifest the
archive's OCI index.json names. Both are reported, read from the archive and checked against
each other, so the deploy compares the loaded image with the one its daemon uses.
"""

import argparse
import functools
import hashlib
import json
import re
import tarfile
from pathlib import Path, PurePosixPath

MAX_JSON_BYTES = 2 * 1024 * 1024
MANIFEST_TYPES = {
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
}


def read_archive_json(archive: tarfile.TarFile, name: str) -> tuple[object, bytes]:
    """Parse one small regular JSON member of the archive; returns (value, raw bytes)."""
    posix = PurePosixPath(name)
    if posix.is_absolute() or ".." in posix.parts:
        raise ValueError("Unsafe artifact member path")
    try:
        member = archive.getmember(name)
    except KeyError as exc:
        raise ValueError("Missing artifact member") from exc
    if not member.isfile() or not 0 < member.size <= MAX_JSON_BYTES:
        raise ValueError("Invalid JSON member")
    stream = archive.extractfile(member)
    if stream is None:
        raise ValueError("Unreadable JSON member")
    data = stream.read(MAX_JSON_BYTES + 1)
    return json.loads(data), data


def docker_config_path(read_json, tag: str) -> str:
    """Path of the config blob manifest.json names for the single image tagged tag."""
    manifests, _ = read_json("manifest.json")
    if not isinstance(manifests, list) or len(manifests) != 1:
        raise ValueError("Exactly one image is required")
    manifest = manifests[0]
    if not isinstance(manifest, dict) or manifest.get("RepoTags") != [tag]:
        raise ValueError("Artifact tag mismatch")
    config_path = manifest.get("Config")
    if type(config_path) is not str:
        raise ValueError("Missing config path")
    return config_path


def verify_config(config: object, raw: bytes, config_path: str, revision: str) -> str:
    """Check the image config is a Linux arm64 build of revision, named by its digest; returns the hex digest."""
    digest = hashlib.sha256(raw).hexdigest()
    if PurePosixPath(config_path).name.removesuffix(".json") != digest:
        raise ValueError("Image config digest mismatch")
    if (
        not isinstance(config, dict)
        or config.get("architecture") != "arm64"
        or config.get("os") != "linux"
    ):
        raise ValueError("Expected a Linux arm64 artifact")
    runtime = config.get("config") or {}
    if (
        not isinstance(runtime, dict)
        or (runtime.get("Labels") or {}).get("org.opencontainers.image.revision") != revision
    ):
        raise ValueError("Artifact revision mismatch")
    return digest


def file_sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def inspect_archive(path: Path, revision: str, tag: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("An exact commit SHA is required")
    with tarfile.open(path, "r:*") as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        if len(names) != len(set(names)):
            raise ValueError("Duplicate archive entries")
        read_json = functools.partial(read_archive_json, archive)
        config_path = docker_config_path(read_json, tag)
        config, raw = read_json(config_path)
        digest = verify_config(config, raw, config_path, revision)
        manifest_digest = indexed_manifest(read_json, tag, "sha256:" + digest)
    return {
        "revision": revision,
        "image_ref": tag,
        "config_digest": "sha256:" + digest,
        "manifest_digest": manifest_digest,
        "archive_sha256": file_sha256(path),
        # What docker load unpacks: the deploy refuses to start without twice this free.
        "image_bytes": sum(member.size for member in members if member.isfile()),
        "architecture": "arm64",
        "os": "linux",
    }


def indexed_descriptor(read_json, tag: str) -> dict:
    """The one single-image-manifest descriptor index.json names for tag, in an OCI-layout archive."""
    layout, _ = read_json("oci-layout")
    if not isinstance(layout, dict) or layout.get("imageLayoutVersion") != "1.0.0":
        raise ValueError("Missing OCI image layout")
    index, _ = read_json("index.json")
    descriptors = index.get("manifests") if isinstance(index, dict) else None
    if not isinstance(descriptors, list) or len(descriptors) != 1:
        raise ValueError("Exactly one indexed image is required")
    descriptor = descriptors[0]
    if type(descriptor) is not dict:
        raise ValueError("Invalid index descriptor")
    # containerd names the loaded image by this annotation; `docker save` writes it.
    annotations = descriptor.get("annotations")
    if not isinstance(annotations, dict) or annotations.get("io.containerd.image.name") != tag:
        raise ValueError("Indexed image tag mismatch")
    # A nested index would become the image ID instead; docker save of one platform writes none.
    if descriptor.get("mediaType") not in MANIFEST_TYPES:
        raise ValueError("Indexed image must be a single image manifest")
    return descriptor


def indexed_manifest(read_json, tag: str, config_digest: str) -> str:
    """Digest of the one image manifest index.json names for tag; it must describe config_digest."""
    descriptor = indexed_descriptor(read_json, tag)
    digest = descriptor.get("digest")
    if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise ValueError("Invalid manifest digest")
    manifest, raw = read_json("blobs/sha256/" + digest.removeprefix("sha256:"))
    if "sha256:" + hashlib.sha256(raw).hexdigest() != digest or len(raw) != descriptor.get("size"):
        raise ValueError("Image manifest digest mismatch")
    config = manifest.get("config") if isinstance(manifest, dict) else None
    if not isinstance(config, dict) or config.get("digest") != config_digest:
        raise ValueError("Image manifest does not describe the image config")
    return digest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("archive", type=Path)
    parser.add_argument("revision")
    parser.add_argument("tag")
    args = parser.parse_args()
    print(json.dumps(inspect_archive(args.archive, args.revision, args.tag), sort_keys=True))


if __name__ == "__main__":
    main()
