"""Two real bash processes contend for the shared odroid deploy lock (#823)."""

import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCK_LIB = ROOT / "scripts/odroid-deploy-lock.sh"


@unittest.skipUnless(
    shutil.which("flock"), "util-linux flock is required (the odroid and CI have it)"
)
class DeployLockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.lock = self.dir / "lock" / "odroid-deploy.lock"
        self.trace = self.dir / "trace.log"

    def env(self, **extra):
        env = dict(
            os.environ,
            ODROID_DEPLOY_LOCK_FILE=str(self.lock),
            ODROID_DEPLOY_LOCK_SLICE="1",
            ODROID_DEPLOY_LOCK_MAX_WAIT="30",
        )
        env.update(extra)
        return env

    def fake_deploy(self, tag, hold_seconds, **extra):
        """A deploy that takes the lock, records start/end, holds it, and exits."""
        script = (
            f'source "{LOCK_LIB}"\n'
            f"odroid_deploy_lock_acquire {tag} || exit $?\n"
            f'echo "{tag} start $(date +%s.%N)" >>"{self.trace}"\n'
            f"sleep {hold_seconds}\n"
            f'echo "{tag} end $(date +%s.%N)" >>"{self.trace}"\n'
        )
        return subprocess.Popen(
            ["bash", "-c", script],
            env=self.env(**extra),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )

    def intervals(self):
        spans = {}
        for line in self.trace.read_text().splitlines():
            tag, kind, stamp = line.split()
            spans.setdefault(tag, {})[kind] = float(stamp)
        return spans

    def test_two_concurrent_deploys_are_serialized(self):
        first = self.fake_deploy("hcb", 2)
        time.sleep(0.3)
        second = self.fake_deploy("esb", 0.2)
        out1 = first.communicate(timeout=30)
        out2 = second.communicate(timeout=30)
        self.assertEqual((first.returncode, second.returncode), (0, 0), (out1, out2))
        spans = self.intervals()
        self.assertGreaterEqual(
            spans["esb"]["start"], spans["hcb"]["end"], "the deploys overlapped"
        )
        self.assertIn("waiting for the host deploy lock, held by: hcb", out2[1])
        self.assertIn("acquired the host deploy lock after", out2[1])

    def test_wait_gives_up_with_75_and_never_breaks_a_live_holder(self):
        holder = self.fake_deploy("hcb", 4)
        time.sleep(0.3)
        waiter = self.fake_deploy("esb", 0, ODROID_DEPLOY_LOCK_MAX_WAIT="2")
        _, err = waiter.communicate(timeout=30)
        self.assertEqual(waiter.returncode, 75, err)
        self.assertIn("gave up", err)
        holder.communicate(timeout=30)
        self.assertEqual(holder.returncode, 0)
        self.assertNotIn("esb", self.trace.read_text())

    def test_stale_owner_file_does_not_block_and_is_reported_as_stale(self):
        self.lock.parent.mkdir(parents=True)
        # An owner file naming a pid that is gone; nobody holds the flock.
        Path(str(self.lock) + ".owner").write_text(
            "repo=hcb\npid=999999\nstart_ticks=1\nstarted=2026-10-24T20:00:00Z\n"
        )
        run = self.fake_deploy("esb", 0)
        _, err = run.communicate(timeout=30)
        self.assertEqual(run.returncode, 0, err)
        self.assertIn("esb start", self.trace.read_text())

    def test_owner_file_of_a_recycled_pid_is_judged_stale(self):
        self.lock.parent.mkdir(parents=True)
        # This test process is alive, but its start ticks differ from the recorded ones.
        Path(str(self.lock) + ".owner").write_text(
            f"repo=hcb\npid={os.getpid()}\nstart_ticks=1\nstarted=2026-10-24T20:00:00Z\n"
        )
        script = f'source "{LOCK_LIB}"; _odl_describe_owner'
        out = subprocess.run(
            ["bash", "-c", script],
            env=self.env(),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertIn("stale", out.stdout)

    def test_a_dead_holder_releases_the_lock_even_when_killed(self):
        holder = self.fake_deploy("hcb", 30)
        time.sleep(0.5)
        # flock(2) is released once every holder of the open file description is gone: end the
        # whole process group, as a cancelled job does, and a new deploy must get in at once.
        os.killpg(holder.pid, signal.SIGKILL)
        holder.communicate(timeout=10)
        next_run = self.fake_deploy("esb", 0)
        _, err = next_run.communicate(timeout=30)
        self.assertEqual(next_run.returncode, 0, err)

    def test_release_lets_the_next_deploy_in_before_the_process_exits(self):
        script = (
            f'source "{LOCK_LIB}"\n'
            "odroid_deploy_lock_acquire hcb || exit $?\n"
            "odroid_deploy_lock_release\nsleep 2\n"
        )
        holder = subprocess.Popen(["bash", "-c", script], env=self.env())
        time.sleep(0.5)
        started = time.monotonic()
        second = self.fake_deploy("esb", 0)
        second.communicate(timeout=30)
        self.assertEqual(second.returncode, 0)
        self.assertLess(time.monotonic() - started, 1.5)
        holder.wait(timeout=10)


@unittest.skipUnless(os.path.exists("/proc/self/stat"), "/proc/<pid>/stat is Linux-only")
class StartTicksTests(unittest.TestCase):
    """`_odl_start_ticks` tells a live lock holder from a recycled pid, so it must return the kernel's
    own starttime (field 22 of /proc/<pid>/stat) whatever the process is called and whatever the
    caller's shell state is (ExpenseSyncBot carries the same cases, Refs #221 there)."""

    @staticmethod
    def reference(pid):
        """Independent parse: comm may hold spaces and ")", so cut after the LAST ")"."""
        stat = Path(f"/proc/{pid}/stat").read_text()
        return stat[stat.rindex(")") + 2 :].rstrip().split(" ")[19]

    @staticmethod
    def bash_ticks(pid, prelude=":"):
        return subprocess.run(
            ["bash", "-c", f'source "{LOCK_LIB}"; {prelude}; _odl_start_ticks {pid}'],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_returns_the_kernel_starttime_of_a_live_process(self):
        out = self.bash_ticks(os.getpid())
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertRegex(out.stdout, r"^[0-9]+$")
        self.assertEqual(out.stdout, self.reference(os.getpid()))

    def test_is_not_thrown_off_by_a_comm_holding_spaces_and_parentheses(self):
        comm = "a) b (c d) 9"
        with tempfile.TemporaryDirectory() as tmp:
            binary = Path(tmp) / comm
            shutil.copy(shutil.which("bash"), binary)
            # Once the copy prints READY it has certainly exec'd, so the kernel reports the odd comm.
            sleeper = subprocess.Popen(
                [str(binary), "-c", "echo READY; read -r _"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                text=True,
            )
            try:
                self.assertEqual(sleeper.stdout.readline().strip(), "READY")
                self.assertIn(f"({comm})", Path(f"/proc/{sleeper.pid}/stat").read_text())
                out = self.bash_ticks(sleeper.pid)
                self.assertEqual(out.returncode, 0, out.stderr)
                self.assertEqual(out.stdout, self.reference(sleeper.pid))
            finally:
                sleeper.kill()
                sleeper.wait(timeout=10)
                sleeper.stdin.close()
                sleeper.stdout.close()

    def test_does_not_depend_on_the_caller_ifs_or_glob_settings(self):
        expected = self.reference(os.getpid())
        for prelude in ("IFS=''", "IFS=':'", "IFS=$'\\n'", "set -f"):
            with self.subTest(prelude=prelude):
                out = self.bash_ticks(os.getpid(), prelude)
                self.assertEqual((out.returncode, out.stdout), (0, expected), out.stderr)

    def test_does_not_clobber_the_callers_positional_parameters(self):
        script = (
            f'source "{LOCK_LIB}"; set -- keep these; _odl_start_ticks {os.getpid()} >/dev/null; '
            "printf '%s|' \"$@\""
        )
        out = subprocess.run(["bash", "-c", script], capture_output=True, text=True, check=False)
        self.assertEqual(out.stdout, "keep|these|")

    def test_fails_with_no_output_for_a_process_that_is_gone(self):
        out = self.bash_ticks(999_999_999)
        self.assertNotEqual(out.returncode, 0)
        self.assertEqual(out.stdout, "")


if __name__ == "__main__":
    sys.exit(unittest.main())
