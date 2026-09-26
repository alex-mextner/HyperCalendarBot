#!/usr/bin/env python3
"""Convert an OCI image-layout tar into the archive format `docker save` writes.

The local deploy fallback builds with Apple's native `container` CLI, whose
`container image save` writes a plain OCI image layout (index.json + blobs,
gzip layers, a nested index that also carries a build attestation). The
release path expects what `docker save` writes: scripts/release-artifact.py
reads a top-level manifest.json naming exactly one image with its RepoTags and
a config blob named by its own sha256, and the server's `docker load` +
identity checks (scripts/deploy-prebuilt-image.sh) expect that same layout.

This selects the single image manifest for <tag> and the requested platform,
verifies the digest of every blob it reads, decompresses gzip layers (checking
each against the config's rootfs.diff_ids) and writes a docker-save archive:
manifest.json, the config blob byte-for-byte (so the image ID, i.e. the config
digest, is unchanged) and uncompressed layer tars under blobs/sha256/.
Nothing is extracted to disk except layer data streamed into temporary files
next to the output.
"""

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import tarfile
import tempfile
import zlib
from pathlib import Path, PurePosixPath
from typing import IO, Any

MAX_JSON_BYTES = 2 * 1024 * 1024  # same cap as release-artifact.py
CHUNK = 1024 * 1024
MAX_INDEX_DEPTH = 4
INDEX_TYPES = {
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
}
MANIFEST_TYPES = {
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
}
PLAIN_LAYER_TYPES = {
    "application/vnd.oci.image.layer.v1.tar",
    "application/vnd.docker.image.rootfs.diff.tar",
}
GZIP_LAYER_TYPES = {
    "application/vnd.oci.image.layer.v1.tar+gzip",
    "application/vnd.docker.image.rootfs.diff.tar.gzip",
}
NAME_ANNOTATIONS = ("io.containerd.image.name", "org.opencontainers.image.ref.name")


class ConversionError(ValueError):
    """The OCI archive is not a single, intact image for the requested tag/platform."""


def blob_path(digest: object) -> str:
    if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise ConversionError(f"Unsupported digest {digest!r}")
    return "blobs/sha256/" + digest.removeprefix("sha256:")


class _HashingReader(io.RawIOBase):
    def __init__(self, stream: IO[bytes]) -> None:
        self.stream = stream
        self.hasher = hashlib.sha256()

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: Any) -> int:
        data = self.stream.read(len(buffer))
        self.hasher.update(data)
        buffer[: len(data)] = data
        return len(data)

    def verify_whole_blob(self, digest: object) -> None:
        """Read whatever the consumer left unread, then compare the full-blob digest."""
        while self.read(CHUNK):
            pass
        if "sha256:" + self.hasher.hexdigest() != digest:
            raise ConversionError(f"Layer digest mismatch for {digest}")


class OciArchive:
    def __init__(self, archive: tarfile.TarFile) -> None:
        self.archive = archive
        self.members: dict[str, tarfile.TarInfo] = {}
        for member in archive.getmembers():
            posix = PurePosixPath(member.name)
            if posix.is_absolute() or ".." in posix.parts:
                raise ConversionError("Unsafe archive member path")
            name = str(posix)
            if not member.isfile():
                continue
            if name in self.members:
                raise ConversionError(f"Duplicate archive entry {name}")
            self.members[name] = member

    def open(self, name: str) -> tuple[IO[bytes], int]:
        member = self.members.get(name)
        if member is None:
            raise ConversionError(f"Missing archive member {name}")
        stream = self.archive.extractfile(member)
        if stream is None:
            raise ConversionError(f"Unreadable archive member {name}")
        return stream, member.size

    def read_small(self, name: str) -> bytes:
        stream, size = self.open(name)
        if not 0 < size <= MAX_JSON_BYTES:
            raise ConversionError(f"Unexpected size for {name}")
        return stream.read(MAX_JSON_BYTES + 1)

    def read_blob(self, digest: object) -> bytes:
        data = self.read_small(blob_path(digest))
        if "sha256:" + hashlib.sha256(data).hexdigest() != digest:
            raise ConversionError(f"Blob digest mismatch for {digest}")
        return data


def load_json(data: bytes, what: str) -> dict[str, Any]:
    try:
        value = json.loads(data)
    except ValueError as exc:
        raise ConversionError(f"Invalid JSON in {what}") from exc
    if not isinstance(value, dict):
        raise ConversionError(f"Expected a JSON object in {what}")
    return value


def select_image(
    oci: OciArchive, tag: str, os_name: str, arch: str
) -> tuple[dict[str, Any], bytes, dict[str, Any]]:
    """Return (image manifest, raw config bytes, parsed config) for tag + platform."""
    index = load_json(oci.read_small("index.json"), "index.json")
    roots = [
        descriptor
        for descriptor in index.get("manifests") or []
        if isinstance(descriptor, dict)
        and isinstance(descriptor.get("annotations"), dict)
        and any(descriptor["annotations"].get(key) == tag for key in NAME_ANNOTATIONS)
    ]
    if not roots:
        raise ConversionError(f"{tag} is not named in index.json")
    found: dict[str, tuple[dict[str, Any], bytes, dict[str, Any]]] = {}

    def walk(descriptor: dict[str, Any], depth: int) -> None:
        if depth > MAX_INDEX_DEPTH:
            raise ConversionError("Image index nesting is too deep")
        media_type = descriptor.get("mediaType")
        if media_type in INDEX_TYPES:
            nested = load_json(oci.read_blob(descriptor.get("digest")), "image index")
            for child in nested.get("manifests") or []:
                if isinstance(child, dict):
                    walk(child, depth + 1)
            return
        if media_type not in MANIFEST_TYPES:
            return
        platform = descriptor.get("platform")
        if isinstance(platform, dict) and (
            platform.get("os"),
            platform.get("architecture"),
        ) != (os_name, arch):
            return  # another platform, or an attestation (unknown/unknown)
        manifest = load_json(oci.read_blob(descriptor.get("digest")), "image manifest")
        config_descriptor = manifest.get("config")
        if not isinstance(config_descriptor, dict):
            raise ConversionError("Image manifest has no config descriptor")
        raw_config = oci.read_blob(config_descriptor.get("digest"))
        config = load_json(raw_config, "image config")
        if (config.get("os"), config.get("architecture")) == (os_name, arch):
            found[str(descriptor.get("digest"))] = (manifest, raw_config, config)

    for root in roots:
        walk(root, 0)
    if len(found) != 1:
        raise ConversionError(f"Expected exactly one {os_name}/{arch} image for {tag}, found {len(found)}")
    return next(iter(found.values()))


def _copy_layer(
    oci: OciArchive, descriptor: dict[str, Any], diff_id: object, directory: Path
) -> tuple[str, Path]:
    media_type = descriptor.get("mediaType")
    if media_type not in PLAIN_LAYER_TYPES | GZIP_LAYER_TYPES:
        raise ConversionError(f"Unsupported layer media type {media_type!r}")
    stream, _ = oci.open(blob_path(descriptor.get("digest")))
    compressed = _HashingReader(stream)
    source: IO[bytes] = (
        gzip.GzipFile(fileobj=io.BufferedReader(compressed), mode="rb")
        if media_type in GZIP_LAYER_TYPES
        else io.BufferedReader(compressed)
    )
    uncompressed = hashlib.sha256()
    handle, name = tempfile.mkstemp(dir=directory, prefix=".layer-")
    path = Path(name)
    with os.fdopen(handle, "wb") as out:
        try:
            while chunk := source.read(CHUNK):
                uncompressed.update(chunk)
                out.write(chunk)
        except (OSError, EOFError, zlib.error) as exc:  # corrupt gzip body
            raise ConversionError(f"Unreadable layer {descriptor.get('digest')}: {exc}") from exc
    compressed.verify_whole_blob(descriptor.get("digest"))
    if "sha256:" + uncompressed.hexdigest() != diff_id:
        raise ConversionError(f"Layer diff_id mismatch for {descriptor.get('digest')}")
    return blob_path(diff_id), path


def _add_bytes(out: tarfile.TarFile, name: str, data: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = 0o644
    out.addfile(info, io.BytesIO(data))


def convert(source: Path, target: Path, tag: str, os_name: str = "linux", arch: str = "amd64") -> str:
    """Write a docker-save archive for tag to target; return the config digest."""
    with tarfile.open(source, "r:*") as archive:
        oci = OciArchive(archive)
        manifest, raw_config, config = select_image(oci, tag, os_name, arch)
        layers = manifest.get("layers") or []
        rootfs = config.get("rootfs")
        diff_ids = rootfs.get("diff_ids") if isinstance(rootfs, dict) else None
        if (
            not isinstance(layers, list)
            or not isinstance(diff_ids, list)
            or len(layers) != len(diff_ids)
        ):
            raise ConversionError("Manifest layers do not match config rootfs.diff_ids")
        config_digest = "sha256:" + hashlib.sha256(raw_config).hexdigest()
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=target.parent, prefix=".oci-convert-") as work:
            layer_names: list[str] = []
            written: set[str] = set()
            partial = Path(work) / "image.tar"
            with tarfile.open(partial, "w", format=tarfile.PAX_FORMAT) as out:
                _add_bytes(out, blob_path(config_digest), raw_config)
                for descriptor, diff_id in zip(layers, diff_ids):  # lengths checked above
                    if not isinstance(descriptor, dict):
                        raise ConversionError("Invalid layer descriptor")
                    name, path = _copy_layer(oci, descriptor, diff_id, Path(work))
                    layer_names.append(name)
                    if name not in written:
                        info = out.gettarinfo(str(path), arcname=name)
                        info.mode, info.mtime = 0o644, 0
                        info.uid, info.gid, info.uname, info.gname = 0, 0, "", ""
                        with path.open("rb") as data:
                            out.addfile(info, data)
                        written.add(name)
                    path.unlink()
                entry = {
                    "Config": blob_path(config_digest),
                    "RepoTags": [tag],
                    "Layers": layer_names,
                }
                _add_bytes(out, "manifest.json", json.dumps([entry]).encode())
            os.replace(partial, target)
    return config_digest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", type=Path, help="OCI image-layout tar (container image save)")
    parser.add_argument("target", type=Path, help="docker-save tar to write")
    parser.add_argument("tag", help="image reference to select and record in RepoTags")
    parser.add_argument("--platform", default="linux/amd64", help="os/arch (default linux/amd64)")
    args = parser.parse_args()
    os_name, _, arch = args.platform.partition("/")
    try:
        digest = convert(args.source, args.target, args.tag, os_name, arch)
    except (ConversionError, OSError, tarfile.TarError, EOFError, zlib.error) as exc:
        raise SystemExit(f"oci-to-docker-archive: {exc}") from exc
    print(digest)


if __name__ == "__main__":
    main()
