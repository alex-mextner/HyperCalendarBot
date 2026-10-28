import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "post_ship_deploy", ROOT / "scripts/post-ship-deploy.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
SHA = "a" * 40
IMAGE = "sha256:" + "b" * 64
CONFIG = "sha256:" + "d" * 64


def snapshot(sha=SHA, image=IMAGE, ready="ok", config=CONFIG):
    # The odroid's containerd image store reports the manifest digest as the container's .Image,
    # so image_id and config_digest differ there (#784); the classic store makes them equal.
    return {
        "receipt": {"revision": sha, "config_digest": config, "image_id": image},
        "revision": sha,
        "image": image,
        "running": True,
        "health": "ok",
        "ready": ready,
    }


def unavailable_jobs():
    # Reduced actual GitHub run35431103705 metadata; no annotations or secrets.
    return [
        {
            "name": "test",
            "status": "completed",
            "conclusion": "failure",
            "runner_id": 0,
            "steps": [],
        },
        {
            "name": "Notify on failure",
            "status": "completed",
            "conclusion": "failure",
            "runner_id": 0,
            "steps": [],
        },
        {
            "name": "build",
            "status": "completed",
            "conclusion": "skipped",
            "runner_id": None,
            "steps": [],
        },
        {
            "name": "deploy",
            "status": "completed",
            "conclusion": "skipped",
            "runner_id": None,
            "steps": [],
        },
    ]


class FakeCommands:
    # Command prefix -> handler method; each handler gets (args, kw) and answers like the real tool.
    ROUTES = (
        (("git", "rev-parse"), "rev_parse"),
        (("git", "fetch"), "fetch"),
        (("gh", "repo", "view"), "repo_view"),
        (("gh", "pr", "view"), "pr_view"),
        (("ssh",), "probe"),
        (("gh", "run", "list"), "run_list"),
        (("gh", "api"), "run_jobs"),
        (("git", "show"), "show_fallback"),
        (("bash",), "build"),
    )

    def __init__(self, root, mode="none", already=False):
        self.root = root
        self.mode = mode
        self.deployed = already
        self.calls = []
        self.main = SHA

    def __call__(self, args, cwd, **kw):
        self.calls.append((args, kw))
        for prefix, handler in self.ROUTES:
            if tuple(args[: len(prefix)]) == prefix:
                return getattr(self, handler)(args, kw)
        raise AssertionError(args)

    def rev_parse(self, args, kw):
        return str(self.root / ".git") if "--git-common-dir" in args else self.main

    def fetch(self, args, kw):
        return ""

    def repo_view(self, args, kw):
        return "test/repo"

    def pr_view(self, args, kw):
        return json.dumps({"state": "MERGED", "baseRefName": "main", "mergeCommit": {"oid": SHA}})

    def probe(self, args, kw):
        return json.dumps(snapshot() if self.deployed else snapshot("c" * 40))

    def run_list(self, args, kw):
        if self.mode == "metadata-error":
            raise module.DeploymentError("metadata unavailable")
        if self.mode == "none":
            return json.dumps([])
        return json.dumps(
            [
                {
                    "databaseId": 1,
                    "headSha": SHA,
                    "status": "in_progress" if self.mode == "active" else "completed",
                    "conclusion": "success" if self.mode == "success" else "failure",
                }
            ]
        )

    def run_jobs(self, args, kw):
        jobs = {
            "unavailable": [
                {
                    "name": "test",
                    "status": "completed",
                    "conclusion": "failure",
                    "runner_id": 0,
                    "steps": [],
                }
            ],
            "unavailable-with-skipped": unavailable_jobs(),
        }.get(
            self.mode,
            [
                {
                    "name": "test",
                    "runner_id": 1,
                    "steps": [{"name": "test", "conclusion": "failure"}],
                }
            ],
        )
        return json.dumps({"jobs": jobs, "total_count": len(jobs)})

    def show_fallback(self, args, kw):
        return "# exact merged fallback source\n"

    def build(self, args, kw):
        assert Path(args[1]).read_text() == "# exact merged fallback source\n"
        assert args[2:] == ["--ref", SHA] and kw.get("live") is True
        self.deployed = True
        return ""


def executable(path, text):
    path.write_text("#!/bin/bash\nset -eu\n" + text)
    path.chmod(0o755)


class Scripted:
    """Answers commands that start with a registered prefix; anything else goes to `fallback`.

    A reply is a str, an exception to raise, or a callable (args, kw) -> str.
    """

    def __init__(self, fallback=None):
        self.fallback = fallback
        self.rules = []
        self.calls = []

    def on(self, prefix, reply):
        self.rules.append((tuple(prefix), reply))
        return self

    def __call__(self, args, cwd, **kw):
        for prefix, reply in self.rules:
            if tuple(args[: len(prefix)]) == prefix:
                self.calls.append((args, kw))
                return self.answer(reply, args, kw)
        if self.fallback is None:
            raise AssertionError(args)
        self.calls.append((args, kw))
        return self.fallback(args, cwd, **kw)

    @staticmethod
    def answer(reply, args, kw):
        if isinstance(reply, BaseException):
            raise reply
        return reply(args, kw) if callable(reply) else reply


def in_order(*replies):
    """A reply that answers its successive calls with `replies` in turn."""
    queue = list(replies)
    return lambda args, kw: Scripted.answer(queue.pop(0), args, kw)


def completed(conclusion="failure", **fields):
    return {
        "databaseId": 7,
        "headSha": SHA,
        "status": "completed",
        "conclusion": conclusion,
        **fields,
    }
