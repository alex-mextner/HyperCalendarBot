#!/usr/bin/env python3
"""Inspect a Docker save archive without extraction or trusting a local image-store ID."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import tarfile

MAX_JSON_BYTES = 2 * 1024 * 1024


def inspect_archive(path: Path, revision: str, tag: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("An exact commit SHA is required")
    with tarfile.open(path, "r:*") as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        if len(names) != len(set(names)):
            raise ValueError("Duplicate archive entries")

        def read_json(name: str) -> tuple[object, bytes]:
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

        manifests, _ = read_json("manifest.json")
        if not isinstance(manifests, list) or len(manifests) != 1:
            raise ValueError("Exactly one image is required")
        manifest = manifests[0]
        if not isinstance(manifest, dict) or manifest.get("RepoTags") != [tag]:
            raise ValueError("Artifact tag mismatch")
        config_path = manifest.get("Config")
        if not isinstance(config_path, str):
            raise ValueError("Missing config path")
        config, raw = read_json(config_path)
        digest = hashlib.sha256(raw).hexdigest()
        if PurePosixPath(config_path).name.removesuffix(".json") != digest:
            raise ValueError("Image config digest mismatch")
        if (
            not isinstance(config, dict)
            or config.get("architecture") != "amd64"
            or config.get("os") != "linux"
        ):
            raise ValueError("Expected a Linux amd64 artifact")
        runtime = config.get("config") or {}
        if (
            not isinstance(runtime, dict)
            or (runtime.get("Labels") or {}).get("org.opencontainers.image.revision")
            != revision
        ):
            raise ValueError("Artifact revision mismatch")
    hasher = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return {
        "revision": revision,
        "image_ref": tag,
        "config_digest": "sha256:" + digest,
        "archive_sha256": hasher.hexdigest(),
        "architecture": "amd64",
        "os": "linux",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("revision")
    parser.add_argument("tag")
    args = parser.parse_args()
    print(
        json.dumps(
            inspect_archive(args.archive, args.revision, args.tag), sort_keys=True
        )
    )


if __name__ == "__main__":
    main()
