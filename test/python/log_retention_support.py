"""Shared workspace fixture for the log-retention test modules."""

import hashlib
import importlib.util
import io
import os
import stat
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/log-retention.py"

HOUR = 3600
DAY = 86400
AMPLE = 10**12


def load_module():
    spec = importlib.util.spec_from_file_location("log_retention", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ample_free(_root):
    return AMPLE, AMPLE


class Workspace(unittest.TestCase):
    """A real temp --root plus helpers that stamp mtimes relative to a fixed NOW."""

    def setUp(self):
        self.lr = load_module()
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name).resolve()
        self.root = self.base / "logs"
        self.root.mkdir()
        self.now = time.time()

    def cfg(self, **overrides):
        # Every limit is off unless a test turns one on, so each test exercises one criterion.
        values = {
            "max_dir_bytes": AMPLE,
            "max_file_bytes": AMPLE,
            "max_files": 10**6,
            "min_free_bytes": 0,
            "min_free_percent": 0.0,
            "gzip_after_seconds": 10**9,
        }
        values.update(overrides)
        return self.lr.Config(**values)

    def stamp(self, path, age):
        moment = self.now - age
        os.utime(path, (moment, moment))

    def make_file(self, relative, size, age, content=None):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if content is not None else os.urandom(size))
        self.stamp(path, age)
        return path

    def make_dir(self, name, files, age):
        directory = self.root / name
        directory.mkdir()
        for file_name, size in files.items():
            self.make_file(f"{name}/{file_name}", size, age)
        self.stamp(directory, age)
        return directory

    def names(self):
        return sorted(p.name for p in self.root.iterdir())

    def snapshot(self):
        state = {}
        for path in sorted(self.root.rglob("*")):
            st = path.lstat()
            digest = (
                hashlib.sha256(path.read_bytes()).hexdigest()
                if path.is_file() and not path.is_symlink()
                else ""
            )
            state[str(path)] = (st.st_size, st.st_mtime_ns, stat.S_IMODE(st.st_mode), digest)
        return state

    def deleted(self, report):
        return [os.path.basename(a.path) for a in report.actions if a.kind == "deleted"]

    def run_main(self, *args, sender=None, free_fn=ample_free, now=None):
        out, err = io.StringIO(), io.StringIO()
        code = self.lr.main(
            # Compression is pushed out of the way unless a test passes its own --gzip-after-days (last one wins).
            ["--root", str(self.root), "--gzip-after-days", "100000", *args],
            free_fn=free_fn,
            sender=sender,
            now=self.now if now is None else now,
            out=out,
            err=err,
        )
        return code, out.getvalue(), err.getvalue()
