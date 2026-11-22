"""Bounded benign processes exercise the native supervisor and real recovery trap.

No Docker, credentials, network, archives, or production signals are used here.
"""
import contextlib
import fcntl
import io
import json
import os
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUTER = ROOT / "scripts/odroid-activate-release.sh"
INNER = ROOT / "scripts/deploy-prebuilt-image.sh"
SHA = "a" * 40


class NativeRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.stage = self.root / (".incoming-" + SHA + "-123-1")
        (self.stage / "scripts").mkdir(parents=True)
        (self.root / "logs").mkdir(mode=0o700)
        self.events = self.root / "events"
        self.ready = self.root / "ready"
        self.child = None
        # The real timeout execs a binary, not a Bash function. Keep every
        # inherited Docker/HTTP lookup inside this fixture even in child processes.
        self.command_bin = self.root / "mock-bin"
        self.command_bin.mkdir()
        for name in ("docker", "curl"):
            command = self.command_bin / name
            command.write_text("#!/bin/sh\nprintf 'unexpected fixture command\\n' >&2\nexit 97\n")
            command.chmod(0o755)
        command_path = patch.dict(os.environ, {"PATH": str(self.command_bin) + ":" + os.environ["PATH"]})
        command_path.start()
        self.addCleanup(command_path.stop)

    def protocol(self):
        source = INNER.read_text()
        self.assertTrue("# BEGIN ACTIVATION_RECOVERY" in source, "native recovery protocol missing")
        return source.split("# BEGIN ACTIVATION_RECOVERY\n", 1)[1].split(
            "# END ACTIVATION_RECOVERY", 1
        )[0]

    def inner(self, body, recovery="success"):
        protocol = self.protocol()
        (self.stage / "scripts/deploy-evidence.py").write_text("pass\n")
        restore = "return 0" if recovery == "success" else "return 1"
        allowed = "return 1" if recovery == "skipped" else "return 0"
        header = INNER.read_text().split("DEPLOY_PATH=", 1)[0]
        source = header + """DEPLOY_PATH="$1"; REMOTE_SRC="$2"; IMAGE="$3"; SHA="$4"
ARCHIVE_SUM="$5"; CONFIG_ID="$6"
SCRIPT_DIR="$REMOTE_SRC/scripts"
""" + protocol + f"""
old_image_may_run() {{ {allowed}; }}
restore_host_files() {{ printf 'host-files\\n' >> '{self.events}'; return 0; }}
restore_image() {{
    printf 'rollback-start\\n' >> '{self.events}'
    sleep 0.2
    printf 'rollback-complete\\n' >> '{self.events}'
    {restore}
}}
""" + body
        (self.stage / "scripts/deploy-prebuilt-image.sh").write_text(source)
        return self.stage / "scripts/deploy-prebuilt-image.sh"

    def runner(self, forward=2.0, recovery=4.0, elapsed=0, bypass_outer_hold=False):
        source = OUTER.read_text().split("3<<'PY'\n", 1)[1].split("\nPY\n", 1)[0]
        self.assertIn("def supervise_activation(", source)
        runner = self.root / "runner.py"
        # Execute the actual checked-in Python program, then call only its native
        # supervisor with a benign inner. The production constants have no env override.
        args = ["fixture", "repo", "workflow", "image", SHA, str(self.stage), "0"]
        runner.write_text(
            "import sys, time, signal\n"
            f"sys.argv = ['fixture', *{args!r}]\n"
            "scope = {'__name__': 'native_fixture'}\n"
            f"exec(compile({source!r}, 'native-wrapper', 'exec'), scope)\n"
            f"scope.update(FORWARD_BUDGET={forward!r}, RECOVERY_GRACE={recovery!r}, "
            f"STARTED=time.monotonic()-{elapsed!r})\n"
            "signal.signal(signal.SIGTERM, scope['request_stop'])\n"
            "signal.signal(signal.SIGINT, scope['request_stop'])\n"
            "signal.signal(signal.SIGHUP, scope['request_stop'])\n"
            # Short-lived benign process fixtures exercise recovery, not the
            # production 1500-second launch reserve (tested directly above).
            + ("scope['require_activation_budget'] = scope['remaining_budget']\n"
               if forward < 1500 else "")
            + ("scope['require_no_retained_activation'] = lambda: None\n" if bypass_outer_hold else "")
            + "raise SystemExit(scope['supervise_activation']('b'*64, 'sha256:'+'c'*64))\n"
        )
        self.child = subprocess.Popen(
            [sys.executable, str(runner)], stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, start_new_session=True,
            env=dict(os.environ, PATH=str(self.command_bin) + ":" + os.environ["PATH"]),
        )
        self.addCleanup(self.stop_child)
        return self.child

    def stop_child(self):
        if self.child and self.child.poll() is None:
            os.killpg(self.child.pid, signal.SIGKILL)
            self.child.communicate(timeout=3)

    def result(self):
        out, err = self.child.communicate(timeout=10)
        return self.child.returncode, out + err

    def wait_ready(self):
        until = time.monotonic() + 3
        while time.monotonic() < until:
            if self.ready.exists():
                return
            if self.child.poll() is not None:
                self.fail(self.result()[1])
            time.sleep(0.01)
        self.fail("benign inner did not start")

    def state(self):
        controls = list(self.root.glob(".activation-*"))
        self.assertEqual(len(controls), 1)
        proof = controls[0] / "supervisor.json"
        return json.loads((proof if proof.exists() else controls[0] / "state.json").read_text())


    def supervisor(self):
        source = OUTER.read_text().split("3<<'PY'\n", 1)[1].split("\nPY\n", 1)[0]
        scope = {"__name__": "native_fixture"}
        argv = ["fixture", "api", "repo", "workflow", "image", SHA, str(self.stage), "0"]
        with patch.object(sys, "argv", argv):
            exec(compile(source, "native-wrapper", "exec"), scope)
        scope["STARTED"] = time.monotonic()
        return scope

    def retained_hold(self):
        hold = self.root / (".activation-" + SHA + "-retained")
        hold.mkdir(mode=0o700)
        journal = hold / "supervisor.json"
        journal.write_text('{"outcome":"unknown"}\n')
        journal.chmod(0o600)
        return hold

    def test_failed_supervisor_exec_creates_no_stage(self):
        source = OUTER.read_text()
        marker = '# The activator\'s own guard accepts a stage only as'
        self.assertEqual(source.count(marker), 1)
        pre_exec = source.split(marker, 1)[1].split("\n", 1)[1].split("exec python3", 1)[0]
        before = sorted(self.root.glob(".incoming-*"))
        script = self.root / "exec-failure.sh"
        script.write_text(
            "set -euo pipefail\n" + f'DEPLOY_PATH="{self.root}"\nSHA="{SHA}"\n'
            + pre_exec + f'exec "{self.root}/missing-supervisor"\n'
        )
        result = subprocess.run(["bash", str(script)], capture_output=True, text=True, timeout=2)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sorted(self.root.glob(".incoming-*")), before)
        self.assertTrue((self.stage / "scripts").is_dir())
        scope = self.supervisor()
        prepared = self.root / (".incoming-" + SHA + "-456-2")
        scope["STAGE"] = str(prepared)

        def stop_preparation():
            self.assertTrue(prepared.is_dir())
            self.assertEqual(prepared.stat().st_mode & 0o777, 0o700)
            raise RuntimeError("benign preparation stop")

        scope["read_token"] = stop_preparation
        with patch.object(signal, "signal"), patch.object(signal, "setitimer"):
            with self.assertRaisesRegex(RuntimeError, "benign preparation stop"):
                scope["main"]()
            self.assertFalse(prepared.exists())
            scope["STAGE"] = str(self.stage)
            with self.assertRaises(FileExistsError):
                scope["main"]()
        self.assertTrue((self.stage / "scripts").is_dir())

    def test_startup_cancellation_waits_for_a_durable_forward_phase(self):
        scope = self.supervisor()
        scope["STOP_REQUESTED"] = signal.SIGTERM
        scope["group_has_live_descendants"] = lambda _pid: False
        observed, phase = [], []
        states = iter(({}, {}, {"phase": "forward"},
                       {"phase": "terminal", "outcome": "preflight_failed", "exit_code": 143}))

        def state(*_args):
            current = next(states)
            phase[:] = [current.get("phase")]
            return current

        scope["child_state"] = state
        scope["signal_owned_group"] = lambda _child, sig: observed.append((phase[0], sig))
        child = SimpleNamespace(pid=987654321, wait=lambda **_: 143)
        lock_path = self.root / "phase.lock"
        lock_path.touch(mode=0o600)
        with lock_path.open("r+") as lock, \
             patch.object(os, "waitid", side_effect=(None, None, None, object())), \
             patch.object(time, "sleep"):
            rc, terminal = scope["wait_for_activation"](child, self.root, {}, lock)
        self.assertEqual(observed, [("forward", signal.SIGTERM)])
        self.assertEqual(rc, 143)
        self.assertEqual(terminal["outcome"], "preflight_failed")

    def test_short_remaining_budget_refuses_before_control_or_child_launch(self):
        for remaining, control_expected in (((1499,), False), ((1501, 1499), True)):
            with self.subTest(remaining=remaining):
                self.stage.mkdir(exist_ok=True)
                (self.stage / "scripts").mkdir(exist_ok=True)
                scope = self.supervisor()
                room = iter(remaining)
                scope["remaining_budget"] = lambda: next(room, remaining[-1])
                scope["require_activation_protocol"] = lambda: None
                actual_mkdtemp = tempfile.mkdtemp
                with patch.object(tempfile, "mkdtemp", wraps=actual_mkdtemp) as created, \
                     patch.object(subprocess, "Popen", side_effect=AssertionError("child started")) as launch:
                    with self.assertRaises(SystemExit) as refused:
                        scope["supervise_activation"]("b" * 64, "sha256:" + "c" * 64)
                self.assertEqual(refused.exception.code, 75)
                self.assertEqual(bool(created.call_count), control_expected)
                launch.assert_not_called()
                self.assertFalse(self.stage.exists())
                self.assertEqual(list(self.root.glob(".activation-*")), [])

    def test_verified_terminal_exit_wins_over_postcommit_cancellation(self):
        scope = self.supervisor()
        scope["STOP_REQUESTED"] = signal.SIGTERM
        scope["group_has_live_descendants"] = lambda _pid: False
        scope["signal_owned_group"] = lambda *_: None
        states = iter(({"phase": "forward"},
                       {"phase": "terminal", "outcome": "verified", "exit_code": 0}))
        scope["child_state"] = lambda *_: next(states)
        child = SimpleNamespace(pid=987654321, wait=lambda **_: 0)
        lock_path = self.root / "phase.lock"
        lock_path.touch(mode=0o600)
        with lock_path.open("r+") as lock, \
             patch.object(os, "waitid", side_effect=(None, object())), \
             patch.object(time, "sleep"):
            rc, terminal = scope["wait_for_activation"](child, self.root, {}, lock)
        self.assertEqual(rc, 0)
        self.assertEqual(terminal["outcome"], "verified")

    def test_expired_recovery_health_clears_previous_verdict(self):
        source = INNER.read_text()
        function = "wait_for_bot() {" + source.split("wait_for_bot() {", 1)[1].split("\n}\n", 1)[0] + "\n}\n"
        script = self.root / "expired-health.sh"
        script.write_text(
            f'REMOTE_SRC="{self.stage}"\n'
            'HEALTH=ok; READY=ok; VERDICT_REASON=previous\n'
            'recovery_limit() { return 124; }\n'
            + function
            + 'rc=0; wait_for_bot health || rc=$?\n'
            'printf "%s|%s|%s|%s\\n" "$rc" "$HEALTH" "$READY" "$VERDICT_REASON"\n'
        )
        result = subprocess.run(["bash", str(script)], capture_output=True, text=True, timeout=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "124|||")

    def test_previous_control_version_refuses_before_service_lock(self):
        control = self.root / (".activation-" + SHA + "-previous")
        control.mkdir(mode=0o700)
        (control / "lock").touch(mode=0o600)
        for version in (1, 2):
            with self.subTest(version=version):
                request = {"version": version, "sha": SHA, "stage": str(self.stage),
                           "nonce": "f" * 32, "supervisor_pid": os.getpid(),
                           "forward_deadline": time.monotonic() + 2700,
                           "minimum_activation_seconds": 1500}
                if version == 2:
                    request["recovery_grace_seconds"] = 1500
                (control / "request.json").write_text(json.dumps(request))
                (control / "request.json").chmod(0o600)
                result = subprocess.run(
                    ["bash", str(INNER), str(self.root), str(self.stage), "image", SHA,
                     "b" * 64, "sha256:" + "c" * 64, str(control)],
                    capture_output=True, text=True, timeout=3,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.root / ".release.lock").exists(), result.stderr)
                self.assertTrue(self.stage.is_dir())

    def test_swap_admission_uses_remaining_trusted_deadline(self):
        source = INNER.read_text()
        final_guard = source.split(
            "# Image loading, backups and baseline probes consume the same absolute budget.\n", 1
        )[1].split("switched=1\n", 1)[0]
        started = self.root / "inner-started"
        for late in (False, True):
            with self.subTest(late=late):
                self.stage.mkdir(exist_ok=True)
                (self.stage / "scripts").mkdir(exist_ok=True)
                self.ready.unlink(missing_ok=True)
                started.unlink(missing_ok=True)
                path = self.inner(
                    f"touch '{started}'\n" + final_guard
                    + f"touch '{self.ready}'\nexit 19\n"
                )
                if late:
                    path.write_text(path.read_text().replace(
                        'if operation in {"lock_budget", "admit_swap"}:\n',
                        'if operation == "admit_swap":\n'
                        '    actual_now = time.monotonic\n'
                        '    time.monotonic = lambda: actual_now() + 600\n'
                        'if operation in {"lock_budget", "admit_swap"}:\n',
                        1,
                    ))
                self.runner(forward=2000)
                rc, output = self.result()
                self.assertTrue(started.exists(), "outer refusal did not exercise inner admission")
                self.assertEqual(self.ready.exists(), not late, output)
                self.assertEqual(rc, 75 if late else 19, output)
                self.assertFalse(self.stage.exists(), output)

    def test_post_lock_budget_refusal_precedes_image_work(self):
        source = INNER.read_text()
        locked = source[source.index("odroid_deploy_lock_acquire hcb"):].split(
            "# docker load", 1
        )[0]
        for late in (False, True):
            with self.subTest(late=late):
                self.stage.mkdir(exist_ok=True)
                (self.stage / "scripts").mkdir(exist_ok=True)
                self.ready.unlink(missing_ok=True)
                path = self.inner(
                    "odroid_deploy_lock_acquire() { return 0; }\n" + locked
                    + f"touch '{self.ready}'\nexit 19\n"
                )
                if late:
                    path.write_text(path.read_text().replace(
                        'if operation in {"lock_budget", "admit_swap"}:\n',
                        'if operation == "admit_swap":\n'
                        '    actual_now = time.monotonic\n'
                        '    time.monotonic = lambda: actual_now() + 600\n'
                        'if operation in {"lock_budget", "admit_swap"}:\n',
                    ))
                self.runner(forward=2000)
                rc, output = self.result()
                self.assertEqual(self.ready.exists(), not late, output)
                self.assertEqual(rc, 75 if late else 19, output)
                self.assertFalse(self.stage.exists(), output)

    def test_recovery_allowance_is_capped_by_the_private_absolute_deadline(self):
        observed = self.root / "recovery-budget"
        for advance, grace, low, high in ((0, 1500, 1500, 1500), (2200, 1500, 1298, 1300),
                                         (4000, 1500, 0, 0), (0, 37, 37, 37)):
            with self.subTest(advance=advance, grace=grace):
                self.stage.mkdir(exist_ok=True)
                (self.stage / "scripts").mkdir(exist_ok=True)
                path = self.inner(f"control_event recovery_budget > '{observed}'\nexit 19\n")
                path.write_text(path.read_text().replace(
                    'if operation == "recovery_budget":\n',
                    'if operation == "recovery_budget":\n'
                    '    actual_now = time.monotonic\n'
                    f'    time.monotonic = lambda: actual_now() + {advance}\n',
                    1,
                ))
                self.runner(forward=2000, recovery=grace)
                rc, output = self.result()
                self.assertEqual(rc, 19, output)
                self.assertLessEqual(low, int(observed.read_text()))
                self.assertLessEqual(int(observed.read_text()), high)

    def test_early_cancellation_shares_the_outer_recovery_deadline(self):
        # Run the actual controller and control reader with a deterministic clock.
        # The fake child has no process, and every signal/kill is an in-memory spy.
        scope = self.supervisor()
        scope.update(STARTED=0, FORWARD_BUDGET=3000, RECOVERY_GRACE=37,
                     STOP_REQUESTED=signal.SIGTERM)
        control = self.root / (".activation-" + SHA + "-clock")
        control.mkdir(mode=0o700)
        request = {
            "version": 3, "sha": SHA, "stage": str(self.stage),
            "nonce": "1" * 32, "supervisor_pid": 123,
            "forward_deadline": 3000, "minimum_activation_seconds": 1500,
            "recovery_grace_seconds": 37,
        }
        scope["write_record"](control, "request.json", request)
        lock_path = control / "lock"
        lock_path.touch(mode=0o600)
        clock, ticks, signals, killed = [1000.0], iter((1011.0, 1037.0)), [], []
        child = SimpleNamespace(pid=424242)
        scope["child_state"] = lambda *_: {
            **request, "child_pid": child.pid,
            "phase": "forward" if clock[0] == 1000 else "recovering",
            "at": 999 if clock[0] == 1000 else 1011,
        }
        scope["signal_owned_group"] = lambda *_: signals.append(clock[0])
        scope["kill_owned_group"] = lambda *_: killed.append(clock[0])
        scope["retain_unknown"] = lambda *_: None
        with patch.object(os, "waitid", return_value=None), \
             patch.object(time, "monotonic", side_effect=lambda: clock[0]), \
             patch.object(time, "sleep", side_effect=lambda _: clock.__setitem__(0, next(ticks))):
            with lock_path.open("r+") as lock:
                result, _ = scope["wait_for_activation"](child, control, request, lock)
        self.assertEqual(result, 124)
        self.assertEqual(signals, [1000])
        self.assertEqual(killed, [1037])
        reader = INNER.read_text().split("<<'CONTROL'\n", 1)[1].split("\nCONTROL\n", 1)[0]
        argv = ["control", str(control), str(self.root), str(self.stage), SHA,
                "123", str(child.pid), "recovery_budget"]
        output = io.StringIO()
        with patch.object(sys, "argv", argv), \
             patch.object(time, "monotonic", return_value=1011), \
             contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as done:
            exec(compile(reader, "actual-control-reader", "exec"), {})
        self.assertEqual(done.exception.code, 0)
        self.assertEqual(int(output.getvalue()), 26)

        # A failed handoff cannot deliver TERM with an unshared deadline.
        (control / "cancellation.json").unlink()
        clock[0], ticks = 1000.0, iter((1011.0, 1037.0))
        signals.clear()
        killed.clear()
        scope["child_state"] = lambda *_: {**request, "child_pid": child.pid,
                                            "phase": "forward", "at": 999}

        def fail_deadline(*_args):
            raise OSError("owned fixture write failure")

        scope["write_record"] = fail_deadline
        with patch.object(os, "waitid", return_value=None), \
             patch.object(time, "monotonic", side_effect=lambda: clock[0]), \
             patch.object(time, "sleep", side_effect=lambda _: clock.__setitem__(0, next(ticks))):
            with lock_path.open("r+") as lock:
                result, _ = scope["wait_for_activation"](child, control, request, lock)
        self.assertEqual(result, 124)
        self.assertEqual(signals, [])
        self.assertEqual(killed, [1037])
        self.assertTrue(control.is_dir())

    def test_recovery_commands_use_one_elapsed_budget_and_keep_reserve(self):
        self.inner(
            f"timeout() {{ printf '%s\\n' \"$*\" >> '{self.events}'; }}\n"
            "RECOVERY_BUDGET=150; recovery_started=$SECONDS\n"
            "recovery_run 300 20 fixture-one\n"
            "recovery_started=$((SECONDS-40))\n"
            "recovery_run 300 20 fixture-two\n"
            "recovery_started=$((SECONDS-140))\n"
            "recovery_run 300 0 fixture-expired\n"
        )
        self.runner()
        rc, output = self.result()
        self.assertEqual(rc, 124, output)
        calls = [line.split() for line in self.events.read_text().splitlines()]
        self.assertEqual(len(calls), 2, output)
        self.assertEqual(calls[0][:2], ["--foreground", "--kill-after=10"])
        self.assertEqual(calls[1][:2], ["--foreground", "--kill-after=10"])
        first, second = int(calls[0][2]), int(calls[1][2])
        self.assertIn(first, (99, 100))
        self.assertIn(second, (59, 60))
        self.assertEqual([call[3] for call in calls], ["fixture-one", "fixture-two"])
        self.assertFalse(self.stage.exists(), output)

    def test_actual_restore_steps_are_bounded_and_preserve_health_options(self):
        source = INNER.read_text()
        functions = source[source.index("wait_for_bot() {"):].split(
            "# Back up the live DB", 1
        )[0]
        guard = self.root / "rollback-guard"
        guard.write_text("fixture-migration\n")
        self.inner(
            f"CURRENT_IMAGE_ID=fixture-old; GATE='{self.root}/gate.py'\n"
            f"ROLLBACK_GUARD='{guard}'; HEALTH_URL=http://fixture.invalid\n"
            "HYPERCAL_HEALTH_HARD_CAP=53\n"
            f"timeout() {{ printf '%s\\n' \"$*\" >> '{self.events}'; shift 3; \"$@\"; }}\n"
            """docker() {
  if [[ "$1" == inspect && "$*" == *State.Running* ]]; then printf 'false\\n'
  elif [[ "$1" == inspect ]]; then printf 'fixture-old\\n'
  fi
}
python3() {
  if [[ "$1" == "$SCRIPT_DIR/deploy-health.py" ]]; then
    printf 'RESULT verdict=ok health=ok ready=ok elapsed=1s reason=fixture\\n'
  elif [[ "$1" == "$GATE" ]]; then
    return 0
  else command python3 "$@"; fi
}
""" + functions
            + "RECOVERY_BUDGET=600; recovery_started=$SECONDS\n"
            "old_image_may_run && restore_image\n"
            "recovery_started=$((SECONDS-590))\n"
            "if old_image_may_run; then exit 92; fi\n"
            "if restore_image; then exit 91; fi\nexit 19\n"
        )
        self.runner()
        rc, output = self.result()
        self.assertEqual(rc, 19, output)
        calls = [line.split() for line in self.events.read_text().splitlines()]
        self.assertEqual(len(calls), 6, output)
        self.assertEqual([call[3] for call in calls],
                         ["docker", "docker", "python3", "docker", "docker", "python3"])
        self.assertEqual([int(call[2]) for call in calls[:5]], [30, 30, 300, 120, 30])
        self.assertIn(int(calls[5][2]), (569, 570))
        self.assertIn("--no-build", calls[3])
        health = calls[5]
        self.assertEqual(health[health.index("--hard-cap") + 1], "53")
        self.assertIn("ROLLBACK image=fixture-old health=ok", output)
        self.assertIn("ROLLBACK_SKIPPED: recovery allowance exhausted", output)
        self.assertIn("ROLLBACK FAILED: rollback compose", output)
        self.assertFalse(self.stage.exists(), output)

    def test_current_control_accepts_canonical_parent_alias(self):
        alias = self.root / "same-root"
        alias.symlink_to(self.root, target_is_directory=True)
        path = self.inner("control_event no_retained\nexit 19\n")
        original = path.read_text()
        needle = 'CONTROL_DIR="${7:-}"'
        self.assertEqual(original.count(needle), 1)
        path.write_text(original.replace(needle, f'CONTROL_DIR="{alias}/$(basename "$7")"'))
        self.runner()
        rc, output = self.result()
        self.assertEqual(rc, 19, output)
        self.assertFalse(self.stage.exists(), output)
        self.assertEqual(list(self.root.glob(".activation-*")), [])

    def test_failed_recovery_record_shields_timeout_child_from_outer_term(self):
        interrupted = self.root / "recovery-interrupted"
        recovery = self.root / "benign-recovery.py"
        recovery.write_text(
            "import signal, time\nfrom pathlib import Path\n"
            f"signal.signal(signal.SIGTERM, lambda *_: Path({str(interrupted)!r}).touch())\n"
            f"Path({str(self.ready)!r}).touch()\n"
            "time.sleep(0.6)\n"
            f"with Path({str(self.events)!r}).open('a') as stream:\n"
            "    stream.write('rollback-complete\\n')\n"
        )
        path = self.inner(
            "restore_image() {\n"
            f"  recovery_run 20 0 python3 '{recovery}'\n"
            "}\nswitched=1\nexit 17\n"
        )
        path.write_text(path.read_text().replace(
            'if operation == "recovering":\n',
            'if operation == "recovering":\n        raise OSError("benign phase-write failure")\n',
            1,
        ))
        self.runner(forward=2000, recovery=1500)
        self.wait_ready()
        self.child.send_signal(signal.SIGTERM)
        rc, output = self.result()
        self.assertEqual(rc, 143, output)
        self.assertFalse(interrupted.exists(), "outer TERM reached an active recovery child")
        self.assertIn("rollback-complete", self.events.read_text())
        self.assertTrue(self.stage.is_dir())
        self.assertEqual(self.state()["outcome"], "recovery_required")
        self.assertIn("benign phase-write failure", output)

    def test_preflight_cleanup_ignores_repeated_cancellation(self):
        scope = self.supervisor()
        prepared = self.root / (".incoming-" + SHA + "-456-2")
        scope["STAGE"] = str(prepared)
        registered = {}

        def stopped_preparation():
            self.assertTrue(prepared.is_dir())
            raise SystemExit(143)

        scope["read_token"] = stopped_preparation
        original_rmtree = scope["shutil"].rmtree

        def cleanup_with_second_signal(path, **options):
            handler = registered.get(signal.SIGTERM)
            if callable(handler):
                handler(signal.SIGTERM, None)
            original_rmtree(path, **options)

        with patch.object(signal, "signal", side_effect=registered.__setitem__), \
             patch.object(signal, "setitimer"), \
             patch.object(scope["shutil"], "rmtree", side_effect=cleanup_with_second_signal):
            with self.assertRaises(SystemExit) as stopped:
                scope["main"]()
        self.assertEqual(stopped.exception.code, 143)
        self.assertFalse(prepared.exists())
        self.assertTrue(self.stage.is_dir())

    def test_failed_recovery_record_does_not_skip_runtime_restoration(self):
        path = self.inner("switched=1\nexit 17\n")
        path.write_text(path.read_text().replace(
            'if operation == "recovering":\n',
            'if operation == "recovering":\n        raise SystemExit("fixture I/O failure")\n',
        ))
        self.runner()
        rc, output = self.result()
        self.assertNotEqual(rc, 0)
        self.assertTrue(self.events.exists(), output)
        self.assertIn("rollback-complete", self.events.read_text())
        self.assertTrue(self.stage.is_dir())
        self.assertEqual(self.state()["outcome"], "recovery_required")

    def test_postreceipt_probe_and_alias_failure_preserve_verified_success(self):
        source = INNER.read_text()
        tail = source.split("# Runtime verification is the commit point.", 1)[1]
        tail = "# Runtime verification is the commit point." + tail.split(
            "# Every release keeps the previous image", 1
        )[0]
        (self.root / "releases").mkdir()
        observed = self.root / "probe-receipt"
        self.inner(
            "switched=1\nPUBLIC_DOMAIN_VALUE=example.invalid\n"
            "REVISION=$SHA; ACTUAL_IMAGE_ID=fixture; HEALTH=ok; READY=ok\n"
            "ROLLBACK_TAG=fixture-previous\n"
            "timeout() { shift 3; \"$@\"; }\n"
            f"curl() {{ if [[ -f \"$DEPLOY_PATH/releases/current.json\" ]]; then echo present; else echo missing; fi > '{observed}'; builtin printf 'ok'; }}\n"
            "docker() { return 18; }\n"
            "printf() { [[ \"$1\" != PUBLIC_PROBE* ]] || return 1; builtin printf \"$@\"; }\n"
            + tail
        )
        self.runner()
        rc, output = self.result()
        self.assertEqual(rc, 0, output)
        self.assertEqual(observed.read_text().strip(), "present")
        self.assertEqual(json.loads((self.root / "releases/current.json").read_text())["revision"], SHA)
        self.assertFalse(self.events.exists(), output)
        self.assertFalse(self.stage.exists(), output)
        self.assertIn("outcome=verified", output)

    def test_failed_evidence_path_has_a_complete_diagnostic_line(self):
        self.inner("switched=1\nexit 17\n")
        (self.stage / "scripts/deploy-evidence.py").write_text(
            "print('EVIDENCE_DIR=/fixture-evidence')\n"
        )
        self.runner(recovery=1500)
        rc, output = self.result()
        self.assertEqual(rc, 17, output)
        self.assertIn("FAILED_EVIDENCE /fixture-evidence", output.splitlines())

    def test_receipt_failure_retains_verified_runtime_without_rollback(self):
        source = INNER.read_text()
        tail = source.split("# Runtime verification is the commit point.", 1)[1]
        tail = "# Runtime verification is the commit point." + tail.split(
            "# Every release keeps the previous image", 1
        )[0]
        (self.root / "releases/current.json").mkdir(parents=True)
        self.inner(
            "switched=1\nPUBLIC_DOMAIN_VALUE=''\n"
            "REVISION=$SHA; ACTUAL_IMAGE_ID=fixture; HEALTH=ok; READY=ok\n"
            "ROLLBACK_TAG=fixture-previous\ndocker() { return 0; }\n" + tail
        )
        self.runner()
        rc, output = self.result()
        self.assertNotEqual(rc, 0, output)
        self.assertFalse(self.events.exists(), output)
        self.assertTrue(self.stage.is_dir(), output)
        self.assertEqual(self.state()["outcome"], "recovery_required")
        self.assertTrue((self.root / "releases/current.json").is_dir())

    def test_receipt_success_publishes_revision_before_cleanup(self):
        source = INNER.read_text()
        tail = source.split("# Runtime verification is the commit point.", 1)[1]
        tail = "# Runtime verification is the commit point." + tail.split(
            "# Every release keeps the previous image", 1
        )[0]
        (self.root / "releases").mkdir()
        commands = self.root / "docker-calls"
        (self.command_bin / "docker").write_text(
            f'#!/bin/sh\nprintf \'%s\\n\' "$*" > "{commands}"\n'
        )
        self.inner(
            "switched=1\nPUBLIC_DOMAIN_VALUE=''\n"
            "REVISION=$SHA; ACTUAL_IMAGE_ID=fixture; HEALTH=ok; READY=ok\n"
            "ROLLBACK_TAG=fixture-previous\n" + tail
        )
        self.runner()
        rc, output = self.result()
        self.assertEqual(rc, 0, output)
        self.assertFalse(self.events.exists(), output)
        self.assertFalse(self.stage.exists(), output)
        self.assertEqual(
            json.loads((self.root / "releases/current.json").read_text())["revision"], SHA
        )
        self.assertEqual(commands.read_text(), f"tag image:{SHA} image:latest\n")
        self.assertIn("outcome=verified", output)

    def test_failed_optional_install_keeps_the_previous_watchdog_bytes(self):
        source = INNER.read_text()
        receipt = source.split("# Runtime verification is the commit point.", 1)[1]
        receipt = "# Runtime verification is the commit point." + receipt.split(
            "# Every release keeps the previous image", 1
        )[0]
        optional = source.split("# The installed copy is what root cron runs", 1)[1]
        optional = optional.split("\n", 1)[1]
        target = self.root / "scripts/log-retention.py"
        target.parent.mkdir()
        (self.root / "releases").mkdir()
        for fails in (True, False):
            with self.subTest(fails=fails):
                (self.stage / "scripts").mkdir(parents=True, exist_ok=True)
                target.write_text("# previous watchdog\n")
                (self.stage / "scripts/log-retention.py").write_text("pass\n")
                (self.command_bin / "install").write_text(
                    f"#!{sys.executable}\nfrom pathlib import Path\nimport sys\n"
                    "source, target = map(Path, sys.argv[-2:])\n"
                    + ("target.write_text('partial')\nraise SystemExit(124)\n" if fails
                       else "target.write_bytes(source.read_bytes())\ntarget.chmod(0o755)\n")
                )
                (self.command_bin / "install").chmod(0o755)
                self.inner(
                    "switched=1\nPUBLIC_DOMAIN_VALUE=''\n"
                    "REVISION=$SHA; ACTUAL_IMAGE_ID=fixture; HEALTH=ok; READY=ok\n"
                    "ROLLBACK_TAG=fixture-previous\n" + receipt + optional
                )
                self.runner()
                rc, output = self.result()
                self.assertEqual(rc, 0, output)
                self.assertEqual(target.read_text(), "# previous watchdog\n" if fails else "pass\n")
                self.assertFalse(self.stage.exists(), output)

    def test_timed_optional_retention_reaps_its_owned_command(self):
        source = INNER.read_text()
        tail = source.split("# Runtime verification is the commit point.", 1)[1]
        tail = "# Runtime verification is the commit point." + tail.split(
            "# Log retention (owner requirement 7)", 1
        )[0]
        self.assertEqual(tail.count("120 python3 -I -"), 1)
        tail = tail.replace("120 python3 -I -", "0.2 python3 -I -", 1)
        (self.root / "releases").mkdir()
        command_started = self.root / "retention-command-started"
        (self.command_bin / "docker").write_text(
            f"#!{sys.executable}\nimport sys,time\nfrom pathlib import Path\n"
            "if sys.argv[1] == 'images': print('unused\\tsha256:unused')\n"
            "if sys.argv[1:3] == ['image', 'rm']:\n"
            f"    Path({str(command_started)!r}).write_text('started')\n"
            "    time.sleep(5)\n"
        )
        self.inner(
            "switched=1\nPUBLIC_DOMAIN_VALUE=''\n"
            "REVISION=$SHA; ACTUAL_IMAGE_ID=fixture; HEALTH=ok; READY=ok\n"
            "ROLLBACK_TAG=fixture-previous; CURRENT_IMAGE_ID=previous\n" + tail
        )
        self.runner()
        rc, output = self.result()
        self.assertTrue(command_started.exists(), output)
        self.assertEqual(rc, 0, output)
        self.assertFalse(self.stage.exists(), output)
        self.assertIn("outcome=verified", output)
        self.assertNotIn("unfinished_child_group", output)

    def test_terminal_writer_inherits_cancellation_shield(self):
        path = self.inner("activation_outcome=verified\nexit 0\n")
        observation = self.root / "terminal-signal"
        path.write_text(path.read_text().replace(
            'if operation == "validate":\n',
            'if operation == "terminal":\n    import signal\n'
            f'    Path({str(observation)!r}).write_text(str(signal.getsignal(signal.SIGTERM)))\n'
            'if operation == "validate":\n',
        ))
        self.runner()
        rc, output = self.result()
        self.assertEqual(rc, 0, output)
        self.assertEqual(observation.read_text(), str(signal.SIG_IGN))
        self.assertFalse(self.stage.exists())

    def test_retained_hold_refuses_before_starting_another_inner(self):
        hold = self.retained_hold()
        self.inner(f"touch '{self.ready}'\nexit 19\n")
        self.runner()
        rc, output = self.result()
        self.assertEqual(rc, 2, output)
        self.assertFalse(self.ready.exists(), output)
        self.assertTrue(hold.is_dir())
        self.assertFalse(self.stage.exists(), output)

    def test_inner_rechecks_retained_hold_under_service_lock(self):
        hold = self.retained_hold()
        source = INNER.read_text()
        admission = source.split("# END ACTIVATION_RECOVERY\n", 1)[1].split("SCRIPT_DIR=", 1)[0]
        self.inner(admission + f"touch '{self.ready}'\nexit 19\n")
        self.runner(bypass_outer_hold=True)
        rc, output = self.result()
        self.assertNotEqual(rc, 0)
        self.assertTrue((self.root / ".release.lock").exists(), output)
        self.assertFalse(self.ready.exists(), output)
        self.assertTrue(hold.is_dir())

    def test_launch_failure_cleans_only_new_preflight_state(self):
        self.inner("exit 0\n")
        scope = self.supervisor()
        scope["require_activation_protocol"] = lambda: None

        def refuse_launch(_command, **options):
            controls = list(self.root.glob(".activation-*"))
            self.assertEqual(len(controls), 1)
            self.assertTrue((controls[0] / "request.json").is_file())
            self.assertEqual(options.get("cwd"), "/")
            raise OSError("fixture launch refusal")

        with patch.object(subprocess, "Popen", side_effect=refuse_launch):
            with self.assertRaises(OSError):
                scope["supervise_activation"]("b" * 64, "sha256:" + "c" * 64)
        self.assertFalse(self.stage.exists())
        self.assertEqual(list(self.root.glob(".activation-*")), [])

    def test_protocol_probe_uses_trusted_working_directory(self):
        self.inner("exit 0\n")
        scope = self.supervisor()
        with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess(
            [], 0, "native-activation-control-v3\n", ""
        )) as called:
            scope["require_activation_protocol"]()
        self.assertEqual(called.call_args.kwargs.get("cwd"), "/")

    def test_transport_backpressure_does_not_block_supervisor_reporting(self):
        scope = self.supervisor()
        read_fd, write_fd = os.pipe()
        self.addCleanup(os.close, read_fd)
        self.addCleanup(os.close, write_fd)

        class StalledTransport:
            def fileno(self):
                return write_fd

            def write(self, _value):
                raise AssertionError("blocking transport write selected")

            def flush(self):
                raise AssertionError("blocking transport flush selected")

        before = fcntl.fcntl(write_fd, fcntl.F_GETFL)
        observed = []

        def blocked_write(descriptor, _data):
            observed.append(fcntl.fcntl(descriptor, fcntl.F_GETFL))
            raise BlockingIOError("fixture backpressure")

        with patch.object(sys, "stderr", StalledTransport()):
            with patch.object(os, "write", side_effect=blocked_write):
                scope["report"]("bounded status", error=True)
        self.assertEqual(len(observed), 1)
        self.assertTrue(observed[0] & os.O_NONBLOCK)
        self.assertEqual(fcntl.fcntl(write_fd, fcntl.F_GETFL), before)


    def test_child_output_is_a_private_regular_log_preserved_after_cleanup(self):
        observed = self.root / "output-kind"
        self.inner(
            "python3 - <<'OUTPUT'\nimport os, stat\nfrom pathlib import Path\n"
            f"Path({str(observed)!r}).write_text(str(stat.S_ISREG(os.fstat(1).st_mode)))\n"
            "OUTPUT\nprintf 'fixture activation output\\n'\nexit 19\n"
        )
        self.runner()
        rc, output = self.result()
        self.assertEqual(rc, 19, output)
        self.assertEqual(observed.read_text(), "True", output)
        logs = list((self.root / ".native-activation-logs").glob("activation-*.log"))
        self.assertEqual(len(logs), 1, output)
        self.assertEqual(logs[0].stat().st_mode & 0o777, 0o600)
        self.assertIn("fixture activation output", logs[0].read_text())
        self.assertFalse(self.stage.exists())

    def test_main_replaces_preflight_signal_handlers_before_supervision(self):
        scope = self.supervisor()
        registered = {}
        signames = ("SIGTERM", "SIGINT", "SIGHUP", "SIGALRM", "SIGUSR1", "SIGUSR2",
                    "SIGQUIT", "SIG_IGN", "ITIMER_REAL")
        fake_signal = SimpleNamespace(**{name: getattr(signal, name) for name in signames})
        fake_signal.signal = lambda signum, callback: registered.__setitem__(signum, callback)
        fake_signal.setitimer = lambda *_: None
        scope["signal"] = fake_signal
        scope["read_token"] = lambda: "fixture-only"
        scope["main_still_targets_release"] = lambda _: None
        scope["release_artifact"] = lambda _: (1, "fixture-digest")
        scope["download"] = lambda _token, _id, _digest, path: Path(path).touch()
        scope["extract_known_files"] = lambda _: {"image.tar.gz": "b" * 64}
        scope["release_config_digest"] = lambda _: "sha256:" + "c" * 64
        scope["require_activation_protocol"] = lambda: None

        def supervised(*_args):
            for sig in (signal.SIGALRM, signal.SIGUSR1, signal.SIGUSR2, signal.SIGQUIT):
                callback = registered.get(sig)
                if callable(callback):
                    callback(sig, None)
                self.assertEqual(callback, signal.SIG_IGN)
            registered[signal.SIGTERM](signal.SIGTERM, None)
            self.assertEqual(scope["STOP_REQUESTED"], signal.SIGTERM)
            return 0

        scope["supervise_activation"] = supervised
        self.assertEqual(scope["main"](), 0)

    def test_forced_reap_timeout_keeps_unknown_and_timeout_result(self):
        scope = self.supervisor()
        hold = self.retained_hold()
        lock_path = hold / "lock"
        lock_path.touch(mode=0o600)
        scope.update(STARTED=0, FORWARD_BUDGET=0, RECOVERY_GRACE=0)
        signalled = []
        scope["signal_owned_group"] = lambda child, sig: signalled.append(sig)

        class BlockedReap:
            pid = 987654321

            def wait(self, timeout):
                raise subprocess.TimeoutExpired("fixture", timeout)

        with lock_path.open("r+") as lock:
            with patch.object(os, "waitid", return_value=None):
                rc, state = scope["wait_for_activation"](BlockedReap(), hold, {}, lock)
        self.assertEqual(rc, 124)
        self.assertEqual(state, {})
        self.assertIn(signal.SIGKILL, signalled)
        self.assertTrue(self.stage.is_dir())
        self.assertEqual(json.loads((hold / "supervisor.json").read_text())["reason"],
                         "recovery_deadline")

    def test_completed_rollback_is_required_before_stage_cleanup(self):
        self.inner("switched=1\nexit 17\n")
        self.runner(forward=2)
        rc, output = self.result()
        self.assertEqual(rc, 17, output)
        self.assertFalse(self.stage.exists(), output)
        self.assertEqual(self.events.read_text().splitlines(),
                         ["host-files", "rollback-start", "rollback-complete"])
        self.assertIn("outcome=rolled_back", output)

    def test_skipped_rollback_retains_stage_and_private_control(self):
        self.inner("switched=1\nexit 17\n", recovery="skipped")
        self.runner()
        rc, output = self.result()
        self.assertEqual(rc, 17, output)
        self.assertTrue(self.stage.is_dir())
        self.assertEqual(self.state()["outcome"], "recovery_required")
        self.assertFalse(self.events.exists())

    def test_failed_rollback_retains_stage(self):
        self.inner(
            "printf 'fixture recovery diagnosis\\n' >&2\nswitched=1\nexit 17\n",
            recovery="failed",
        )
        self.runner()
        rc, output = self.result()
        self.assertNotEqual(rc, 0, output)
        self.assertTrue(self.stage.is_dir())
        self.assertEqual(self.state()["outcome"], "recovery_required")
        self.assertIn("fixture recovery diagnosis", output)
        controls = list(self.root.glob(".activation-*"))
        lines = (controls[0] / "activation.log").read_text().splitlines()
        self.assertIn(
            f"ACTIVATION_RETAINED stage={self.stage} outcome=recovery_required", lines
        )

    def test_timeout_allows_rollback_and_does_not_signal_unrelated_process(self):
        sentinel = subprocess.Popen(["sleep", "10"], start_new_session=True)
        def stop_sentinel():
            if sentinel.poll() is None:
                sentinel.kill()
            sentinel.wait(timeout=2)
        self.addCleanup(stop_sentinel)
        self.inner(f"switched=1\ntouch '{self.ready}'\nsleep 10\n")
        self.runner()
        rc, output = self.result()
        self.assertEqual(rc, 124, output)
        self.assertIsNone(sentinel.poll())
        self.assertFalse(self.stage.exists(), output)
        self.assertIn("rollback-complete", self.events.read_text())

    def test_repeated_outer_cancellation_does_not_interrupt_recovery(self):
        self.inner(f"switched=1\ntouch '{self.ready}'\nsleep 10\n")
        self.runner(forward=2)
        self.wait_ready()
        self.child.send_signal(signal.SIGTERM)
        until = time.monotonic() + 2
        while not self.events.exists() and time.monotonic() < until:
            time.sleep(0.01)
        self.child.send_signal(signal.SIGTERM)
        rc, output = self.result()
        self.assertEqual(rc, 143, output)
        self.assertFalse(self.stage.exists(), output)
        self.assertIn("rollback-complete", self.events.read_text())

    def test_grace_expiry_records_unknown_before_forced_exit_and_retains_stage(self):
        path = self.inner("switched=1\nexit 17\n")
        path.write_text(path.read_text().replace("sleep 0.2", "sleep 10"))
        self.runner(recovery=0.2)
        rc, output = self.result()
        self.assertEqual(rc, 124, output)
        self.assertTrue(self.stage.is_dir())
        self.assertEqual(self.state()["outcome"], "unknown")
        self.assertNotIn("rollback-complete", self.events.read_text() if self.events.exists() else "")

    def test_expired_forward_budget_does_not_start_inner(self):
        self.inner(f"touch '{self.ready}'\n")
        self.runner(forward=0.2, elapsed=1)
        rc, output = self.result()
        self.assertEqual(rc, 124, output)
        self.assertFalse(self.ready.exists())
        self.assertFalse(self.stage.exists(), output)

    def test_missing_terminal_proof_retains_stage_even_after_zero_exit(self):
        path = self.inner("exit 0\n")
        header = INNER.read_text().split("DEPLOY_PATH=", 1)[0]
        path.write_text(header + "exit 0\n")
        self.runner()
        rc, output = self.result()
        self.assertEqual(rc, 1, output)
        self.assertTrue(self.stage.is_dir())
        self.assertEqual(self.state()["reason"], "missing_terminal_proof")

    def test_busy_phase_lock_cannot_disable_the_hard_deadline(self):
        path = self.inner("exit 0\n")
        header = INNER.read_text().split("DEPLOY_PATH=", 1)[0]
        path.write_text(header + """python3 - "$7" <<'LOCK'
import fcntl, pathlib, sys, time
with (pathlib.Path(sys.argv[1]) / 'lock').open('r+') as stream:
    fcntl.flock(stream, fcntl.LOCK_EX)
    time.sleep(10)
LOCK
""")
        self.runner(forward=1, recovery=0.2)
        rc, output = self.result()
        self.assertEqual(rc, 124, output)
        self.assertTrue(self.stage.is_dir())
        self.assertEqual(self.state()["reason"], "recovery_deadline")

    def test_live_descendant_prevents_cleanup_after_leader_exit(self):
        path = self.inner("exit 0\n")
        header = INNER.read_text().split("DEPLOY_PATH=", 1)[0]
        path.write_text(header + "sleep 10 &\nexit 0\n")
        self.runner()
        rc, output = self.result()
        self.assertNotEqual(rc, 0, output)
        self.assertTrue(self.stage.is_dir())
        self.assertEqual(self.state()["reason"], "unfinished_child_group")

    def test_forward_deadline_does_not_interrupt_already_started_rollback(self):
        path = self.inner("switched=1\nexit 17\n")
        path.write_text(path.read_text().replace("sleep 0.2", "sleep 1.2"))
        self.runner(forward=1)
        rc, output = self.result()
        self.assertEqual(rc, 17, output)
        self.assertFalse(self.stage.exists(), output)
        self.assertIn("rollback-complete", self.events.read_text())

    def test_legacy_helper_is_refused_before_activation(self):
        for protocol in (None, "native-activation-control-v2"):
            with self.subTest(protocol=protocol):
                (self.stage / "scripts").mkdir(parents=True, exist_ok=True)
                path = self.inner("exit 0\n")
                probe = ("" if protocol is None else
                         f'if [[ "$1" == --activation-control-version ]]; then echo {protocol}; exit 0; fi\n')
                path.write_text(
                    "#!/bin/bash\nset -euo pipefail\n" + probe
                    + 'root="${1:?}"; stage="${2:?}"\n'
                    + f"touch '{self.ready}'\n"
                )
                self.runner()
                rc, output = self.result()
                self.assertEqual(rc, 2, output)
                self.assertFalse(self.ready.exists())
                self.assertIn("no activation started", output)

    def test_disconnected_log_reader_does_not_cancel_the_hard_deadline(self):
        path = self.inner("switched=1\nexit 17\n")
        path.write_text(path.read_text().replace("sleep 0.2", "sleep 10"))
        self.runner(recovery=0.2)
        self.child.stderr.close()
        rc = self.child.wait(timeout=5)
        self.assertNotEqual(rc, 0)
        self.assertTrue(self.stage.is_dir())
        self.assertEqual(self.state()["reason"], "recovery_deadline")
        self.child.stdout.close()

    def test_rollback_requires_the_actual_health_verdict_success(self):
        source = INNER.read_text()
        function = "restore_image() {" + source.split("restore_image() {", 1)[1].split("\n}\n", 1)[0] + "\n}\n"
        script = self.root / "health-result.sh"
        for health_rc in (1, 0):
            with self.subTest(health_rc=health_rc):
                script.write_text(
                    f'DEPLOY_PATH="{self.root}"; REMOTE_SRC="{self.stage}"\n'
                    'CURRENT_IMAGE_ID="sha256:previous"; HEALTH=ok; READY=ok\n'
                    'docker() { printf "sha256:previous\\n"; }\n'
                    'recovery_run() { shift 2; "$@"; }\n'
                    f'wait_for_bot() {{ printf "actual-health\\n"; return {health_rc}; }}\n'
                    + function + "restore_image\n"
                )
                result = subprocess.run(["bash", str(script)], text=True, capture_output=True, timeout=2)
                self.assertEqual(result.returncode, health_rc, result.stderr)
                self.assertEqual(result.stdout.count("actual-health"), 1)

    def test_old_six_argument_caller_refuses_before_any_mutation(self):
        result = subprocess.run(
            ["bash", str(INNER), str(self.root), str(self.stage), "image", SHA,
             "b" * 64, "sha256:" + "c" * 64],
            text=True, capture_output=True, timeout=3,
        )
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("no activation started", result.stderr)
        self.assertFalse((self.root / ".release.lock").exists())
        self.assertTrue(self.stage.is_dir())

    def test_verified_and_preflight_outcomes_allow_cleanup(self):
        for body, expected in (
            ("exit 19\n", "preflight_failed"),
            ("activation_outcome=verified\nexit 0\n", "verified"),
        ):
            with self.subTest(expected=expected):
                self.stage.mkdir(exist_ok=True)
                (self.stage / "scripts").mkdir(exist_ok=True)
                self.inner(body)
                self.runner()
                _, output = self.result()
                self.assertFalse(self.stage.exists(), output)
                self.assertIn("outcome=" + expected, output)

    def log_retention_tail(self):
        source = INNER.read_text()
        section = source.split("# Log retention (owner requirement 7):", 1)[1]
        start = section.index("timeout --foreground --kill-after=10 60 python3")
        return (
            "SCRIPT_DIR=" + shlex.quote(str(self.stage / "scripts")) + "\n"
            + "DEPLOY_PATH=" + shlex.quote(str(self.root)) + "\n"
            + section[start:]
        )

    def test_log_retention_soft_termination_preserves_retryable_original(self):
        from log_retention_support import load_module

        log = self.root / "logs" / "example.log"
        content = b"bounded benign retention fixture\n" * 64
        log.write_bytes(content)
        helper = self.stage / "scripts" / "log-retention.py"
        helper.write_text(
            "import importlib.util, os, pathlib, signal, sys\n"
            "sys.dont_write_bytecode = True\n"
            f"spec = importlib.util.spec_from_file_location('retention_fixture', {str(ROOT / 'scripts/log-retention.py')!r})\n"
            "module = importlib.util.module_from_spec(spec)\n"
            "spec.loader.exec_module(module)\n"
            "def paused_verify(target, source):\n"
            f"    pathlib.Path({str(self.ready)!r}).write_text(str(os.getpid()))\n"
            "    signal.pause()\n"
            "    return module._gz_matches_source(target, source)\n"
            f"module.gzip_in_place({str(log)!r}, verify=paused_verify)\n"
        )
        child = subprocess.Popen(
            ["bash", "-c", self.log_retention_tail()],
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            until = time.monotonic() + 5
            while not self.ready.exists() and child.poll() is None and time.monotonic() < until:
                time.sleep(0.01)
            self.assertTrue(self.ready.exists(), "owned verifier did not reach publication")
            verifier_pid = int(self.ready.read_text())
            self.assertEqual(os.getpgid(verifier_pid), child.pid)
            os.kill(verifier_pid, signal.SIGTERM)
            output, errors = child.communicate(timeout=3)
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
            child.communicate(timeout=3)
        self.assertEqual(child.returncode, 0, output + errors)
        self.assertIn("verified release stays in place", errors)
        self.assertEqual(log.read_bytes(), content)
        self.assertFalse(Path(str(log) + ".gz").exists())
        self.assertFalse(Path(str(log) + ".gz.tmp").exists())
        retention = load_module()
        target = retention.gzip_in_place(str(log))
        self.assertEqual(target, str(log) + ".gz")
        self.assertFalse(log.exists())

    def test_log_retention_entrypoint_preserves_arguments_and_success(self):
        argv_file = self.root / "retention-argv.json"
        helper = self.stage / "scripts" / "log-retention.py"
        helper.write_text(
            "import json, pathlib, sys\n"
            f"pathlib.Path({str(argv_file)!r}).write_text(json.dumps(sys.argv[1:]))\n"
        )
        result = subprocess.run(
            ["bash", "-c", self.log_retention_tail()],
            text=True, capture_output=True, timeout=3,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(argv_file.read_text()), [
            "--root", str(self.root / "logs"),
            "--env-file", str(self.root / ".env"), "--alert",
        ])
        self.assertNotIn("LOG_RETENTION reported", result.stderr)


if __name__ == "__main__":
    unittest.main()
