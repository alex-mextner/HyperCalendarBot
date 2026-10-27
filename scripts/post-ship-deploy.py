#!/usr/bin/env python3
"""Post-merge deployment using the existing locally verified image release path."""

import argparse
import contextlib
import datetime
import fcntl
import functools
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import time

SHA = re.compile(r"[a-f0-9]{40}")
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")


class DeploymentError(RuntimeError):
    pass


def run(args, cwd, *, input_text=None, live=False, keep_fds=()):
    result = subprocess.run(
        args,
        cwd=cwd,
        input=input_text,
        text=True,
        stdout=None if live else subprocess.PIPE,
        stderr=None if live else subprocess.PIPE,
        timeout=None if live else 60,
        pass_fds=keep_fds,
    )
    if result.returncode:
        raise DeploymentError(
            f"{Path(args[0]).name} command failed ({result.returncode})"
        )
    return result.stdout or ""


def decoded(text):
    if len(text) > 2_000_000:
        raise DeploymentError("oversized deployment metadata")
    try:
        return json.loads(text)
    except (ValueError, TypeError) as error:
        raise DeploymentError("invalid deployment metadata") from error


PENDING_STATUSES = ("queued", "in_progress", "waiting", "requested", "pending")


def runner_outcome(job):
    """What a failed run's job proves about the runner: "skipped" or "failed_without_runner".

    Anything else, including a job that ran steps or held a runner, refuses the local override.
    """
    if (
        not isinstance(job, dict)
        or not isinstance(job.get("steps"), list)
        or job.get("status") != "completed"
        or "runner_id" not in job
    ):
        raise DeploymentError("invalid job metadata")
    runner_id = job["runner_id"]
    # bool is an int subclass, but is never a valid GitHub runner identifier.
    zero_runner = type(runner_id) is int and runner_id == 0
    if job["steps"] or job.get("runner_name") not in (None, ""):
        raise DeploymentError("hosted executable steps ran; refusing local override")
    if job.get("conclusion") == "skipped" and (runner_id is None or zero_runner):
        return "skipped"
    if job.get("conclusion") == "failure" and zero_runner:
        return "failed_without_runner"
    raise DeploymentError("job did not establish runner unavailability")


def hosted_action(workflow, jobs):
    """A platform no-start is distinct from a step that actually ran and failed."""
    if workflow is None:
        return "local"
    if not isinstance(workflow, dict):
        raise DeploymentError("invalid workflow metadata")
    if workflow.get("status") in PENDING_STATUSES:
        return "hosted_pending"
    if workflow.get("status") != "completed":
        raise DeploymentError("unknown workflow state")
    if workflow.get("conclusion") == "success":
        return "hosted_success"
    if (
        workflow.get("conclusion") != "failure"
        or not isinstance(jobs, list)
        or not jobs
    ):
        raise DeploymentError("workflow did not establish runner unavailability")
    # Every job is checked: one that ran steps vetoes the override even after the proof was found.
    outcomes = [runner_outcome(job) for job in jobs]
    if "failed_without_runner" not in outcomes:
        raise DeploymentError(
            "skipped jobs alone do not establish runner unavailability"
        )
    return "local"


def runtime_matches(snapshot, sha):
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("receipt"), dict):
        return False
    receipt = snapshot["receipt"]
    image = snapshot.get("image")
    # The receipt's image_id is the container's .Image the activator verified: the config digest on
    # Docker's classic image store, the manifest digest on the containerd store (the odroid, #784).
    return (
        receipt.get("revision") == sha
        and snapshot.get("revision") == sha
        and isinstance(image, str)
        and DIGEST.fullmatch(image) is not None
        and receipt.get("image_id") == image
        and snapshot.get("running") is True
        and snapshot.get("health") == "ok"
        and snapshot.get("ready") in ("ok", "ok (unverified)")
    )


REMOTE_PROBE = r"""
import json, pathlib, subprocess, sys, urllib.request
p=pathlib.Path(sys.argv[1])/"releases/current.json"
receipt=json.loads(p.read_text()) if p.is_file() else {}
fmt='{{.Image}}|{{.State.Running}}|{{index .Config.Labels "org.opencontainers.image.revision"}}'
parts=subprocess.check_output(['docker','inspect','hypercal-bot','--format',fmt],text=True).strip().split('|')
def public_base_url():
 # https://$PUBLIC_DOMAIN from the live .env; without one the bot runs in polling mode and only its published port answers.
 # The last assignment wins and an inline "# comment" is dropped, as in docker compose's env_file.
 host=''
 try:
  for line in (pathlib.Path(sys.argv[1])/".env").read_text().splitlines():
   if line.startswith('PUBLIC_DOMAIN='):
    host=line.split('=',1)[1].split(' #',1)[0].split('\t#',1)[0].strip().strip('"\'')
 except OSError:
  pass
 return 'https://'+host if host else 'http://127.0.0.1:3001'
BASE=public_base_url()
def body(path):
 try:
  with urllib.request.urlopen(BASE+'/'+path,timeout=10) as r:
   return r.read(256).decode().strip()
 except Exception:
  return None
print(json.dumps({'receipt':receipt,'image':parts[0],'running':parts[1]=='true','revision':parts[2],
                  'health':body('health'),'ready':body('ready')}))
"""


def snapshot_remote(repo, host, directory, call=run):
    command = "python3 - " + shlex.quote(directory)
    return decoded(
        call(
            [
                "ssh",
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                host,
                command,
            ],
            repo,
            input_text=REMOTE_PROBE,
        )
    )


def save_status(path, data):
    fd, tmp = tempfile.mkstemp(prefix="release-status-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(data, stream, indent=2)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


@contextlib.contextmanager
def release_lock(git_dir):
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(git_dir / "post-ship-release.lock", flags, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield None
            return
        yield fd
    finally:
        os.close(fd)


def current_main(repo, call):
    call(["git", "fetch", "origin", "main"], repo)
    return call(["git", "rev-parse", "origin/main^{commit}"], repo).strip()


def hosted_runs(repo, name, sha, call, sleep):
    """The latest hosted CI/CD run of sha as a list; retried, since a push may not have started one yet."""
    workflows = []
    for attempt in range(3):
        workflows = decoded(
            call(
                [
                    "gh",
                    "run",
                    "list",
                    "--repo",
                    name,
                    "--workflow",
                    "CI/CD",
                    "--commit",
                    sha,
                    "--limit",
                    "1",
                    "--json",
                    "databaseId,headSha,status,conclusion",
                ],
                repo,
            )
        )
        if not isinstance(workflows, list):
            raise DeploymentError("invalid workflow collection")
        if workflows:
            break
        if attempt < 2:
            sleep(5)
    return workflows


def failed_run_jobs(repo, name, workflow, call):
    """Every job of a failed hosted run; a partial listing cannot prove the runner was unavailable."""
    run_id = workflow.get("databaseId")
    if type(run_id) is not int or run_id <= 0:
        raise DeploymentError("invalid workflow run identifier")
    payload = decoded(
        call(
            ["gh", "api", f"repos/{name}/actions/runs/{run_id}/jobs?per_page=100"],
            repo,
        )
    )
    if (
        not isinstance(payload, dict)
        or type(payload.get("total_count")) is not int
        or payload["total_count"] > 100
    ):
        raise DeploymentError("incomplete job metadata")
    jobs = payload.get("jobs")
    if not isinstance(jobs, list) or len(jobs) != payload["total_count"]:
        raise DeploymentError("incomplete job collection")
    return jobs


def inspect_hosted(repo, name, sha, call, sleep=time.sleep):
    workflows = hosted_runs(repo, name, sha, call, sleep)
    if not workflows:
        return "local"
    workflow = workflows[0]
    if not isinstance(workflow, dict) or workflow.get("headSha") != sha:
        raise DeploymentError("workflow SHA mismatch")
    jobs = None
    if (
        workflow.get("status") == "completed"
        and workflow.get("conclusion") == "failure"
    ):
        jobs = failed_run_jobs(repo, name, workflow, call)
    return hosted_action(workflow, jobs)


def merged_target(repo, pr, sha, call):
    """(repo path, git common dir, GitHub name) once PR `pr` is proven merged into main as `sha`."""
    if SHA.fullmatch(sha) is None or type(pr) is not int or pr <= 0:
        raise DeploymentError("full merged SHA and numeric PR required")
    repo = Path(repo).resolve()
    git_dir = Path(
        call(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], repo
        ).strip()
    )
    name = call(
        ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
        repo,
    ).strip()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", name):
        raise DeploymentError("invalid repository identity")
    merged = decoded(
        call(
            [
                "gh",
                "pr",
                "view",
                str(pr),
                "--repo",
                name,
                "--json",
                "state,baseRefName,mergeCommit",
            ],
            repo,
        )
    )
    if (
        not isinstance(merged, dict)
        or merged.get("state") != "MERGED"
        or merged.get("baseRefName") != "main"
    ):
        raise DeploymentError("PR is not merged into main")
    commit = merged.get("mergeCommit")
    if not isinstance(commit, dict) or commit.get("oid") != sha:
        raise DeploymentError("PR merge identity mismatch")
    return repo, git_dir, name


def deploy_destination():
    """(ssh host, install directory) from the environment; both end up in an ssh command line."""
    host = os.environ.get("HYPERCAL_DEPLOY_HOST", "root@odroidn2")
    directory = os.environ.get("HYPERCAL_DEPLOY_PATH", "/opt/hypercal")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+", host):
        raise DeploymentError("invalid deployment host")
    if (
        not re.fullmatch(r"/[A-Za-z0-9_/-]+", directory)
        or directory == "/"
        or ".." in directory
    ):
        raise DeploymentError("invalid deployment directory")
    return host, directory


def write_result(state_path, sha, state, **fields):
    """Record the release state for sha on disk and return it."""
    data = {
        "state": state,
        "target": sha,
        "pid": os.getpid(),
        "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        **fields,
    }
    save_status(state_path, data)
    return data


def live_fields(snapshot):
    """The status fields describing a live deployment that runtime_matches accepted."""
    return {
        "image": snapshot["image"],
        "ready": snapshot["ready"],
        "ai_verified": snapshot["ready"] == "ok",
    }


def verified_live(probe, sha, refusal):
    """Probe the host again; the status fields of a live deployment of sha, or DeploymentError(refusal)."""
    after = probe()
    if not runtime_matches(after, sha):
        raise DeploymentError(refusal)
    return live_fields(after)


def run_local_fallback(repo, sha, acquired, call):
    """Run the merged commit's own local verify-and-deploy script, not the working tree's copy."""
    source = call(["git", "show", f"{sha}:scripts/deploy-local-fallback.sh"], repo)
    with tempfile.TemporaryDirectory(prefix="hypercal-ship-") as temporary:
        script = Path(temporary) / "deploy-local-fallback.sh"
        script.write_text(source)
        call(
            ["bash", str(script), "--ref", sha],
            repo,
            live=True,
            keep_fds=(acquired,),
        )


def run_release(repo, name, sha, probe, acquired, state_path, call, sleep):
    """The release phases under the lock; every state, including failure, is recorded."""
    result = functools.partial(write_result, state_path, sha)
    try:
        if current_main(repo, call) != sha:
            return result("superseded")
        before = probe()
        if runtime_matches(before, sha):
            return result("already_deployed", **live_fields(before))
        action = inspect_hosted(repo, name, sha, call, sleep)
        if action == "hosted_pending":
            return result(action)
        if action == "hosted_success":
            return result(
                "verified",
                **verified_live(
                    probe, sha, "hosted success lacks matching live deployment evidence"
                ),
            )
        if current_main(repo, call) != sha:
            return result("superseded")
        result("local_verifying_and_deploying")
        run_local_fallback(repo, sha, acquired, call)
        return result(
            "verified",
            **verified_live(
                probe, sha, "fallback did not produce matching live deployment evidence"
            ),
        )
    except (DeploymentError, OSError, subprocess.TimeoutExpired) as error:
        result("failed", reason=str(error))
        raise


def deploy(repo, pr, sha, *, call=run, sleep=time.sleep):
    repo, git_dir, name = merged_target(repo, pr, sha, call)
    host, directory = deploy_destination()
    with release_lock(git_dir) as acquired:
        if acquired is None:
            return {"state": "busy", "target": sha}
        probe = functools.partial(snapshot_remote, repo, host, directory, call)
        state_path = git_dir / "post-ship-release.json"
        return run_release(repo, name, sha, probe, acquired, state_path, call, sleep)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--pr", required=True, type=int)
    parser.add_argument("--sha", required=True)
    args = parser.parse_args()
    try:
        outcome = deploy(args.repo, args.pr, args.sha)
    except (DeploymentError, OSError, subprocess.TimeoutExpired) as error:
        print(
            json.dumps({"state": "failed", "target": args.sha, "reason": str(error)}),
            file=sys.stderr,
        )
        return 1
    print(json.dumps(outcome))
    return 0 if outcome["state"] in ("verified", "already_deployed") else 75


if __name__ == "__main__":
    sys.exit(main())
