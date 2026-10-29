"""Tests for scripts/install-stage-qa-browser.sh (installer of the browser half of the per-PR stage QA, #840).

HOME is a temp dir and the checkout a throw-away git repo whose `origin/main` ref is set by hand. The script is
run from a COPY with its fixed constants rewritten (browser lock wait 1s; FORBIDDEN_EUID for the root refusal).
The network toolchain part is played by fake `npm`, `uv`, `apt-get`, `dpkg-deb`, `ldd` and `uname` in a temp
bin dir that leads the PATH given to the installer (the installer runs with the caller's PATH); every fake logs
its call to $FAKE_LOG and its failures are switched by environment variables. The fake npm drops a fake
agent-browser binary whose `install` creates a fake Chrome. Nothing touches the network.
"""

import fcntl
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INSTALLER = ROOT / "scripts/install-stage-qa-browser.sh"
BROWSER = ROOT / "scripts/stage-qa-browser.py"
COMMON = ROOT / "scripts/stage_qa_common.py"

SHA = "a" * 40
USERNAME = "HyperCalendarStageBot"
REQUIRED = [
    "start",
    "ping",
    "today-read-only-calendar",
    "simple-intent-phrase",
    "validation-search-without-query",
]

STUB_SMOKE = """import json, os, sys
with open(os.environ["SMOKE_RECORD"], "w") as handle:
    json.dump({"argv": sys.argv[1:], "env": dict(os.environ)}, handle)
print("STAGE_SMOKE_PASSED sha=%s bot=@x cases=5 failed=0" % sys.argv[sys.argv.index("--sha") + 1], flush=True)
"""

FAKE_NPM = r"""#!/bin/sh
echo "npm $*" >> "$FAKE_LOG"
[ -z "$FAKE_NPM_FAIL" ] || { echo "npm ERR! fake failure" >&2; exit 1; }
prefix=""
while [ $# -gt 0 ]; do
  if [ "$1" = --prefix ]; then prefix=$2; fi
  shift
done
case "$(uname -m)" in aarch64) bin=agent-browser-linux-arm64 ;; *) bin=agent-browser-linux-x64 ;; esac
[ -z "$FAKE_NPM_NOBIN" ] || exit 0
mkdir -p "$prefix/node_modules/agent-browser/bin"
cat > "$prefix/node_modules/agent-browser/bin/$bin" <<'EOT'
#!/bin/sh
echo "agent-browser $*" >> "$FAKE_LOG"
if [ "$1" = install ]; then
  [ -z "$FAKE_AB_INSTALL_FAIL" ] || exit 1
  [ -z "$FAKE_AB_NOCHROME" ] || exit 0
  mkdir -p "$HOME/.agent-browser/browsers/chrome-1"
  printf '#!/bin/sh\nexit 0\n' > "$HOME/.agent-browser/browsers/chrome-1/chrome"
  chmod 755 "$HOME/.agent-browser/browsers/chrome-1/chrome"
fi
EOT
chmod 755 "$prefix/node_modules/agent-browser/bin/$bin"
"""

FAKE_UV = r"""#!/bin/sh
echo "uv $*" >> "$FAKE_LOG"
[ -z "$FAKE_UV_FAIL" ] || { echo "uv: fake failure" >&2; exit 1; }
if [ -z "$FAKE_UV_NOQA" ]; then
  mkdir -p "$HOME/.local/bin"
  printf '#!/bin/sh\nexit 0\n' > "$HOME/.local/bin/qa"
  chmod 755 "$HOME/.local/bin/qa"
fi
"""

FAKE_APT_GET = r"""#!/bin/sh
echo "apt-get $* (cwd=$(pwd))" >> "$FAKE_LOG"
[ -z "$FAKE_APT_FAIL" ] || { echo "E: fake failure" >&2; exit 100; }
[ "$1" = download ] || exit 64
shift
for pkg in "$@"; do echo "$pkg" > "${pkg}_1.0_amd64.deb"; done
"""

FAKE_DPKG_DEB = r"""#!/bin/sh
echo "dpkg-deb $*" >> "$FAKE_LOG"
[ "$1" = -x ] || exit 64
pkg=$(cat "$2")
dest=$3
arch=$(uname -m)
case "$pkg" in
  fonts-*)
    mkdir -p "$dest/usr/share/fonts/truetype/dejavu"
    : > "$dest/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    ;;
  *)
    if [ -z "$FAKE_DPKG_NOLIBS" ]; then
      mkdir -p "$dest/usr/lib/$arch-linux-gnu"
      : > "$dest/usr/lib/$arch-linux-gnu/lib-$pkg.so"
    fi
    ;;
esac
"""

# Reports one missing library until libnss3 has been unpacked into a directory of LD_LIBRARY_PATH.
FAKE_LDD = r"""#!/bin/sh
echo "ldd $*" >> "$FAKE_LOG"
echo "	libc.so.6 => /lib/libc.so.6 (0x0000)"
found=0
old_ifs=$IFS
IFS=:
for dir in $LD_LIBRARY_PATH; do
  [ -e "$dir/lib-libnss3.so" ] && found=1
done
IFS=$old_ifs
[ "$found" = 1 ] || echo "	libnss3.so => not found"
exit 0
"""

FAKE_UNAME = r"""#!/bin/sh
if [ "$1" = -m ]; then echo "${FAKE_UNAME:-x86_64}"; else exec /bin/uname "$@"; fi
"""


def write_exe(path, text):
    path.write_text(text)
    path.chmod(0o755)


def rewrite(text, replacements):
    for old, new in replacements:
        if old not in text:
            raise AssertionError(f"installer no longer contains {old!r}")
        text = text.replace(old, new)
    return text


def alive_lock_holder(path):
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o666)
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


class InstallerCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        for name, text in (
            ("npm", FAKE_NPM),
            ("uv", FAKE_UV),
            ("apt-get", FAKE_APT_GET),
            ("dpkg-deb", FAKE_DPKG_DEB),
            ("ldd", FAKE_LDD),
            ("uname", FAKE_UNAME),
        ):
            write_exe(self.bin / name, text)
        self.log = self.tmp / "calls.log"
        self.src = self.tmp / "checkout"
        (self.src / "scripts").mkdir(parents=True)
        self.base = self.home / "hypercal-stage-qa"
        self.lib = self.base / "lib"
        self.entry = self.base / "bin/stage-qa-browser"
        self.npm_dir = self.base / "npm"
        self.chrome_libs = self.base / "chrome-libs"
        self.fonts = self.base / "fonts.conf"
        self.tmp_dir = self.base / "tmp"
        self.config = self.home / ".config/hypercal-stage-qa/browser.json"
        self.lock = self.home / ".local/state/hypercal-stage-qa/qa.lock"
        self.ab = self.npm_dir / "node_modules/agent-browser/bin/agent-browser-linux-x64"
        self.write_checkout("one")
        self.git("init", "-q", "-b", "main")
        self.commit("initial")
        self.publish()
        self.script = self.make_script()
        self.extra_env = {}

    # ------------------------------------------------------------ helpers

    def make_script(self, forbidden_euid=None):
        replacements = [("readonly BROWSER_LOCK_WAIT=60\n", "readonly BROWSER_LOCK_WAIT=1\n")]
        if forbidden_euid is not None:
            replacements.append(
                ("readonly FORBIDDEN_EUID=0\n", f"readonly FORBIDDEN_EUID={forbidden_euid}\n")
            )
        script = self.tmp / "install-stage-qa-browser.sh"
        script.write_text(rewrite(INSTALLER.read_text(), replacements))
        script.chmod(0o755)
        return script

    def write_checkout(self, version):
        (self.src / "scripts/stage-qa-browser.py").write_text(
            BROWSER.read_text() + f"\n# {version}\n"
        )
        (self.src / "scripts/stage_qa_common.py").write_text(
            COMMON.read_text() + f"\n# {version}\n"
        )
        (self.src / "scripts/stage-smoke.py").write_text(
            STUB_SMOKE + f"\n# stage-smoke {version}\n"
        )

    def git(self, *args):
        # core.hooksPath: a machine-wide commit gate must not decide whether this throw-away repo can commit.
        subprocess.run(
            [
                "git",
                "-C",
                str(self.src),
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "core.hooksPath=/dev/null",
                *args,
            ],
            check=True,
            capture_output=True,
        )

    def publish(self):
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")

    def commit(self, message):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)

    def env(self, **extra):
        env = {
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "HOME": str(self.home),
            "FAKE_LOG": str(self.log),
        }
        env.update(self.extra_env)
        env.update(extra)
        return env

    def install(self, *args, script=None, **env):
        return subprocess.run(
            [str(script or self.script), *(args or (str(self.src),))],
            capture_output=True,
            text=True,
            env=self.env(**env),
            timeout=120,
            check=False,
        )

    def calls(self, tool=None):
        if not self.log.exists():
            return []
        lines = self.log.read_text().splitlines()
        if tool is None:
            return lines
        return [line[len(tool) + 1 :] for line in lines if line.startswith(tool + " ")]

    def rollback(self, result):
        command = re.search(r"(?m)^rollback: (.+)$", result.stdout).group(1)
        return subprocess.run(
            ["bash", "-c", command], capture_output=True, text=True, env=self.env(), check=False
        )

    def backups(self):
        return sorted(p.name for p in self.base.rglob("*") if ".bak-" in p.name)

    def strays(self):
        return sorted(
            str(p)
            for root in (self.base, self.config.parent)
            if root.exists()
            for p in root.rglob("*")
            if ".new" in p.name
        )

    def assert_nothing_installed(self):
        self.assertFalse(self.lib.exists())
        self.assertFalse(self.entry.exists())
        self.assertFalse(self.config.exists())
        self.assertEqual(self.strays(), [])

    def expected_entry(self, arch="x86_64", ab="agent-browser-linux-x64"):
        libs = self.chrome_libs
        return (
            "#!/usr/bin/env bash\n"
            f"export PATH={self.home}/.local/bin:/usr/local/bin:/usr/bin:/bin\n"
            f"export QA_BROWSER_BIN={self.npm_dir}/node_modules/agent-browser/bin/{ab}\n"
            "export AGENT_BROWSER_ARGS=--no-sandbox\n"
            f"export LD_LIBRARY_PATH={libs}/root/usr/lib/{arch}-linux-gnu:{libs}/root/lib/{arch}-linux-gnu\n"
            f"export FONTCONFIG_FILE={self.fonts}\n"
            f"export TMPDIR={self.tmp_dir}\n"
            f'exec python3 {self.lib}/stage-qa-browser.py "${{SSH_ORIGINAL_COMMAND-}}"\n'
        )

    def reset_home(self):
        shutil.rmtree(self.home)
        self.home.mkdir()
        self.log.unlink(missing_ok=True)


class FreshInstall(InstallerCase):
    def test_lays_out_lib_entry_config_fonts_and_toolchain(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            sorted(p.name for p in self.lib.iterdir()),
            ["stage-qa-browser.py", "stage-smoke.py", "stage_qa_common.py"],
        )
        for name in ("stage-qa-browser.py", "stage-smoke.py", "stage_qa_common.py"):
            self.assertEqual(stat.S_IMODE((self.lib / name).stat().st_mode), 0o755, name)
            self.assertEqual(
                (self.lib / name).read_text(), (self.src / "scripts" / name).read_text(), name
            )
        self.assertEqual(stat.S_IMODE(self.lib.stat().st_mode), 0o755)
        self.assertEqual(self.entry.read_text(), self.expected_entry())
        self.assertEqual(stat.S_IMODE(self.entry.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o600)
        self.assertEqual(
            json.loads(self.config.read_text()),
            {
                "username": USERNAME,
                "deny_usernames": ["HyperCalendarBot"],
                "qa_bin": "~/.local/bin/qa",
                "python": "python3",
                "lock_file": "~/.local/state/hypercal-stage-qa/qa.lock",
                "lock_max_wait": 2700,
                "state_dir": "~/.local/state/hypercal-stage-qa",
                "min_cases": 5,
                "required_cases": REQUIRED,
            },
        )
        self.assertIn("created", result.stdout)
        self.assertEqual(self.strays(), [])
        self.assertEqual(self.backups(), [])

    def test_fonts_conf_points_at_the_unpacked_fonts(self):
        self.assertEqual(self.install().returncode, 0)
        text = self.fonts.read_text()
        self.assertIn(f"<dir>{self.chrome_libs}/root/usr/share/fonts/truetype</dir>", text)
        self.assertIn(f"<cachedir>{self.base}/fontcache</cachedir>", text)
        for family, font in (
            ("sans-serif", "DejaVu Sans"),
            ("serif", "DejaVu Serif"),
            ("monospace", "DejaVu Sans Mono"),
        ):
            self.assertIn(
                f"<family>{family}</family><prefer><family>{font}</family></prefer>", text
            )

    def test_the_toolchain_is_fetched_with_the_pinned_versions_and_libs_are_unpacked(self):
        self.assertEqual(self.install().returncode, 0)
        self.assertEqual(
            self.calls("npm"),
            [f"install --prefix {self.npm_dir} --no-audit --no-fund agent-browser@0.39.1"],
        )
        self.assertEqual(self.calls("agent-browser"), ["install"])
        self.assertEqual(
            self.calls("uv"),
            [
                (
                    "tool install --force --python python3 "
                    "git+https://git.hyperide.ai/ultrabricks/qa-cli@875b11a0f3965de54e2015d525720008d8926f2f"
                )
            ],
        )
        apt = self.calls("apt-get")
        self.assertEqual(len(apt), 1)
        self.assertTrue(apt[0].startswith("download libnspr4 libnss3 "), apt[0])
        self.assertIn(" fonts-dejavu-core (", apt[0])
        self.assertTrue(apt[0].endswith(f"(cwd={self.chrome_libs}/debs)"), apt[0])
        debs = len(apt[0].split("(cwd=")[0].split()) - 1
        self.assertEqual(len(self.calls("dpkg-deb")), debs)
        self.assertTrue(
            all(
                call.startswith(f"-x {self.chrome_libs}/debs/")
                and call.endswith(f"{self.chrome_libs}/root")
                for call in self.calls("dpkg-deb")
            )
        )
        self.assertTrue(self.ab.is_file() and os.access(self.ab, os.X_OK))
        self.assertTrue((self.home / ".local/bin/qa").is_file())
        self.assertTrue((self.home / ".agent-browser/browsers/chrome-1/chrome").is_file())

    def test_prints_the_authorized_keys_line_and_the_rollback(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(
            f'restrict,command="{self.entry}" ssh-ed25519 AAAA... hypercal-stage-qa-odroid\n',
            result.stdout,
        )
        self.assertRegex(result.stdout, r"(?m)^rollback: .+")
        self.assertNotIn("PRIVATE KEY", result.stdout + result.stderr)

    def test_aarch64_uses_the_arm64_binary_and_library_dirs(self):
        result = self.install(FAKE_UNAME="aarch64")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            self.entry.read_text(), self.expected_entry("aarch64", "agent-browser-linux-arm64")
        )

    def test_unsupported_architecture_is_refused_before_anything_is_fetched(self):
        result = self.install(FAKE_UNAME="riscv64")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported architecture riscv64", result.stderr)
        self.assertEqual(self.calls(), [])
        self.assert_nothing_installed()

    def test_first_install_rollback_removes_what_it_created_and_keeps_config_and_toolchain(self):
        result = self.install()
        done = self.rollback(result)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertFalse(self.lib.exists())
        self.assertFalse(self.entry.exists())
        self.assertTrue(self.config.exists())
        self.assertTrue(self.ab.exists())


class Reinstall(InstallerCase):
    def test_second_install_reruns_only_what_is_cheap_and_pinned(self):
        self.assertEqual(self.install().returncode, 0)
        (self.tmp_dir / "leftover").write_text("x")
        self.assertEqual(stat.S_IMODE(self.tmp_dir.stat().st_mode), 0o700)
        unpacked = len(self.calls("dpkg-deb"))
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.calls("npm")), 1, "agent-browser is already there")
        self.assertEqual(self.calls("agent-browser"), ["install"], "Chrome is already there")
        self.assertEqual(len(self.calls("apt-get")), 1, "libraries and fonts are already there")
        self.assertEqual(len(self.calls("dpkg-deb")), unpacked, "nothing is unpacked twice")
        uv = self.calls("uv")
        self.assertEqual(len(uv), 2, "qa-cli is reinstalled at the pinned ref every time")
        self.assertEqual(uv[0], uv[1])
        self.assertEqual(stat.S_IMODE(self.tmp_dir.stat().st_mode), 0o700)
        self.assertEqual(
            (self.tmp_dir / "leftover").read_text(), "x", "the tmp dir survives a reinstall"
        )
        self.assertIn("--force", uv[1])
        self.assertIn("kept the existing", result.stdout)

    def test_missing_chrome_alone_reruns_only_the_agent_browser_install(self):
        self.assertEqual(self.install().returncode, 0)
        shutil.rmtree(self.home / ".agent-browser")
        self.assertEqual(self.install().returncode, 0)
        self.assertEqual(len(self.calls("npm")), 1)
        self.assertEqual(self.calls("agent-browser"), ["install", "install"])
        self.assertEqual(len(self.calls("apt-get")), 1)
        self.assertTrue((self.home / ".agent-browser/browsers/chrome-1/chrome").exists())

    def test_missing_agent_browser_binary_reruns_npm(self):
        self.assertEqual(self.install().returncode, 0)
        shutil.rmtree(self.npm_dir)
        self.assertEqual(self.install().returncode, 0)
        self.assertEqual(len(self.calls("npm")), 2)
        self.assertEqual(len(self.calls("agent-browser")), 1)
        self.assertTrue(self.ab.exists())

    # Two installs per test: backups are stamped to the second, so a third install in the same second is refused.
    def test_missing_fonts_rerun_the_apt_unpack(self):
        self.assertEqual(self.install().returncode, 0)
        shutil.rmtree(self.chrome_libs / "root/usr/share/fonts")
        self.assertEqual(self.install().returncode, 0)
        self.assertEqual(len(self.calls("apt-get")), 2)
        self.assertTrue((self.chrome_libs / "root/usr/share/fonts").is_dir())

    def test_missing_chrome_libs_rerun_the_apt_unpack(self):
        self.assertEqual(self.install().returncode, 0)
        shutil.rmtree(self.chrome_libs)
        self.assertEqual(self.install().returncode, 0)
        self.assertEqual(len(self.calls("apt-get")), 2)
        self.assertTrue(
            (self.chrome_libs / "root/usr/lib/x86_64-linux-gnu/lib-libnss3.so").exists()
        )

    def test_keeps_config_backs_up_lib_and_entry_and_the_rollback_restores_them(self):
        self.assertEqual(self.install().returncode, 0)
        self.config.write_text('{"edited": true}\n')
        old_entry = self.entry.read_text() + "# hand edited\n"
        self.entry.write_text(old_entry)
        self.write_checkout("two")
        self.commit("second")
        self.publish()
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_text(), '{"edited": true}\n')
        self.assertEqual(sorted(p.name for p in self.config.parent.iterdir()), ["browser.json"])
        self.assertTrue((self.lib / "stage-smoke.py").read_text().endswith("# stage-smoke two\n"))
        self.assertEqual(self.entry.read_text(), self.expected_entry())
        backups = self.backups()
        self.assertEqual(len(backups), 2, backups)
        lib_backup = next(p for p in self.base.iterdir() if p.name.startswith("lib.bak-"))
        entry_backup = next(p for p in (self.base / "bin").iterdir() if ".bak-" in p.name)
        self.assertTrue((lib_backup / "stage-smoke.py").read_text().endswith("# stage-smoke one\n"))
        self.assertEqual(entry_backup.read_text(), old_entry)
        self.assertEqual(stat.S_IMODE(entry_backup.stat().st_mode), 0o755)
        done = self.rollback(result)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue((self.lib / "stage-smoke.py").read_text().endswith("# stage-smoke one\n"))
        self.assertTrue((self.lib / "stage_qa_common.py").read_text().endswith("# one\n"))
        self.assertEqual(self.entry.read_text(), old_entry)
        self.assertEqual(self.backups(), [])

    def test_an_existing_config_is_never_overwritten_not_even_when_invalid(self):
        self.config.parent.mkdir(parents=True)
        self.config.write_text("not even json\n")
        self.config.chmod(0o640)
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_text(), "not even json\n")
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o640)
        self.assertIn(f"kept the existing {self.config}", result.stdout)


class Refusals(InstallerCase):
    def assert_refused(self, result, needle):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(needle, result.stderr)
        self.assertEqual(
            self.calls(), [], "no toolchain command may run before the checkout is accepted"
        )

    def test_dirty_listed_file_is_refused_and_the_old_install_stays(self):
        self.assertEqual(self.install().returncode, 0)
        self.log.unlink()
        (self.src / "scripts/stage-smoke.py").write_text("# tampered\n")
        result = self.install()
        self.assert_refused(result, "uncommitted")
        self.assertTrue((self.lib / "stage-smoke.py").read_text().endswith("# stage-smoke one\n"))
        self.assertEqual(self.backups(), [])

    def test_untracked_listed_file_is_refused(self):
        self.git("rm", "-q", "--cached", "scripts/stage_qa_common.py")
        self.git("commit", "-q", "-m", "forget the common helpers")
        self.publish()
        result = self.install()
        self.assert_refused(result, "uncommitted or untracked")
        self.assertIn("stage_qa_common.py", result.stderr)
        self.assertFalse(self.lib.exists())

    def test_missing_listed_file_is_refused(self):
        for name in ("stage-qa-browser.py", "stage_qa_common.py", "stage-smoke.py"):
            with self.subTest(name=name):
                (self.src / "scripts" / name).rename(self.tmp / "moved")
                result = self.install()
                self.assert_refused(result, f"{name} is missing")
                (self.tmp / "moved").rename(self.src / "scripts" / name)

    def test_head_must_be_on_origin_main(self):
        self.write_checkout("two")
        self.commit("not on main")
        result = self.install()
        self.assert_refused(result, "origin/main")
        self.assertFalse(self.lib.exists())
        self.git("update-ref", "-d", "refs/remotes/origin/main")
        result = self.install()
        self.assert_refused(result, "origin/main")

    def test_an_ancestor_of_origin_main_is_accepted(self):
        self.write_checkout("two")
        self.commit("later main commit")
        self.publish()
        self.git("checkout", "-q", "HEAD~1")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("(detached)", result.stdout)
        self.assertTrue((self.lib / "stage-smoke.py").read_text().endswith("# stage-smoke one\n"))

    def test_not_a_git_checkout_is_refused(self):
        shutil.rmtree(self.src / ".git")
        self.assert_refused(self.install(), "git checkout")

    def test_missing_checkout_directory_and_extra_arguments_are_refused(self):
        self.assert_refused(self.install(str(self.tmp / "absent")), "checkout directory not found")
        self.assert_refused(self.install(str(self.src), "extra"), "usage")

    def test_root_is_refused(self):
        script = self.make_script(forbidden_euid=os.getuid())
        result = self.install(script=script)
        self.assert_refused(result, "normal user")
        self.assert_nothing_installed()

    def test_a_running_qa_blocks_everything_with_75(self):
        self.lock.parent.mkdir(parents=True)
        fd = alive_lock_holder(self.lock)
        self.addCleanup(os.close, fd)
        result = self.install()
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertIn("a QA run holds", result.stderr)
        self.assertEqual(self.calls(), [], "nothing may be fetched or swapped under a running QA")
        self.assert_nothing_installed()
        self.assertFalse(self.base.exists())

    def test_a_running_qa_leaves_a_previous_install_untouched(self):
        self.assertEqual(self.install().returncode, 0)
        self.log.unlink()
        before = self.entry.read_text()
        fd = alive_lock_holder(self.lock)
        self.addCleanup(os.close, fd)
        self.write_checkout("two")
        self.commit("second")
        self.publish()
        result = self.install()
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertEqual(self.calls(), [])
        self.assertTrue((self.lib / "stage-smoke.py").read_text().endswith("# stage-smoke one\n"))
        self.assertEqual(self.entry.read_text(), before)
        self.assertEqual(self.backups(), [])

    def test_the_lock_is_free_again_after_an_install(self):
        self.assertEqual(self.install().returncode, 0)
        fd = os.open(self.lock, os.O_RDWR)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


class ToolchainFailures(InstallerCase):
    def test_each_failing_step_aborts_with_a_clear_message_and_leaves_nothing_half_installed(self):
        table = (
            ("npm fails", {"FAKE_NPM_FAIL": "1"}, "npm install of agent-browser failed"),
            ("npm leaves no binary", {"FAKE_NPM_NOBIN": "1"}, "agent-browser installed without"),
            (
                "agent-browser cannot fetch chrome",
                {"FAKE_AB_INSTALL_FAIL": "1"},
                "could not download its Chrome",
            ),
            (
                "agent-browser install leaves no chrome",
                {"FAKE_AB_NOCHROME": "1"},
                "no Chrome under ~/.agent-browser",
            ),
            ("uv fails", {"FAKE_UV_FAIL": "1"}, "uv tool install of qa-cli failed"),
            ("uv leaves no qa", {"FAKE_UV_NOQA": "1"}, "qa is not in ~/.local/bin"),
            (
                "apt-get download fails",
                {"FAKE_APT_FAIL": "1"},
                "apt-get download of the Chrome libraries failed",
            ),
            (
                "unpacked debs carry no libs",
                {"FAKE_DPKG_NOLIBS": "1"},
                "Chrome still has missing shared libraries",
            ),
        )
        for label, env, message in table:
            with self.subTest(label):
                self.reset_home()
                result = self.install(**env)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn(message, result.stderr)
                self.assertIn("install-stage-qa-browser:", result.stderr)
                self.assert_nothing_installed()
                self.assertFalse(self.fonts.exists())
                self.assertNotIn("rollback:", result.stdout)

    def test_a_failure_after_an_earlier_install_keeps_the_working_install_and_makes_no_backup(self):
        self.assertEqual(self.install().returncode, 0)
        before = self.entry.read_text()
        self.write_checkout("two")
        self.commit("second")
        self.publish()
        result = self.install(FAKE_UV_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("uv tool install of qa-cli failed", result.stderr)
        self.assertTrue((self.lib / "stage-smoke.py").read_text().endswith("# stage-smoke one\n"))
        self.assertEqual(self.entry.read_text(), before)
        self.assertEqual(self.backups(), [])
        self.assertEqual(self.strays(), [])

    def test_ldd_that_still_reports_missing_libraries_after_unpacking_names_the_check(self):
        result = self.install(FAKE_DPKG_NOLIBS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("LD_LIBRARY_PATH=", result.stderr)
        self.assertIn("ldd", result.stderr)
        self.assertGreaterEqual(len(self.calls("ldd")), 2, "checked before and after the unpack")
        self.assertFalse(self.lib.exists())


class InstalledEntry(InstallerCase):
    """The entry as the sshd forced command: SSH_ORIGINAL_COMMAND is the SHA, stdin the READY payload."""

    def setUp(self):
        super().setUp()
        self.assertEqual(self.install().returncode, 0)
        self.record = self.tmp / "smoke-record.json"

    def payload(self, sha=SHA):
        cases = [
            {"name": name, "send": "/x", "expect": {"text_contains": ["ok"]}} for name in REQUIRED
        ]
        return (
            json.dumps(
                {
                    "sha": sha,
                    "username": USERNAME,
                    "peer": "123456789",
                    "cases": cases,
                    "base_cases": 5,
                }
            )
            + "\n"
        )

    def run_entry(self, command, payload=None):
        env = {"PATH": "/usr/bin:/bin", "HOME": str(self.home), "SMOKE_RECORD": str(self.record)}
        if command is not None:
            env["SSH_ORIGINAL_COMMAND"] = command
        return subprocess.run(
            [str(self.entry)],
            input=payload if payload is not None else self.payload(),
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
            check=False,
        )

    def test_the_entry_runs_the_installed_browser_half_with_the_generated_config_and_environment(
        self,
    ):
        done = self.run_entry(SHA)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(
            done.stdout,
            "STAGE_BROWSER_LOCKED\n"
            + f"STAGE_QA_RESULT status=passed sha={SHA} cases=5 failed=0\n",
        )
        record = json.loads(self.record.read_text())
        env = record["env"]
        self.assertEqual(env["QA_BROWSER_BIN"], str(self.ab))
        self.assertEqual(env["AGENT_BROWSER_ARGS"], "--no-sandbox")
        self.assertEqual(env["FONTCONFIG_FILE"], str(self.fonts))
        self.assertEqual(env["TMPDIR"], str(self.tmp_dir))
        self.assertEqual(
            env["LD_LIBRARY_PATH"],
            f"{self.chrome_libs}/root/usr/lib/x86_64-linux-gnu:"
            f"{self.chrome_libs}/root/lib/x86_64-linux-gnu",
        )
        self.assertTrue(env["PATH"].startswith(f"{self.home}/.local/bin:"))
        argv = record["argv"]
        self.assertEqual(argv[argv.index("--username") + 1], USERNAME)
        self.assertEqual(argv[argv.index("--qa-bin") + 1], str(self.home / ".local/bin/qa"))

    def test_anything_but_a_bare_sha_in_the_ssh_command_is_refused_and_never_executed(self):
        pwned = self.tmp / "pwned"
        hostile = (
            f"$(touch {pwned})",
            f"`touch {pwned}`",
            f"{SHA}; touch {pwned}",
            f"{SHA} --config /tmp/evil",
            "",
            "--config=/tmp/evil",
            "g" * 40,
            SHA + "0",
        )
        for command in hostile:
            with self.subTest(command=command):
                done = self.run_entry(command)
                self.assertEqual(done.returncode, 2, done.stderr)
                self.assertEqual(
                    done.stdout, "STAGE_QA_RESULT status=refused sha=- cases=0 failed=0\n"
                )
                self.assertFalse(self.record.exists())
        self.assertFalse(pwned.exists())

    def test_an_interactive_login_without_a_command_is_refused(self):
        done = self.run_entry(None)
        self.assertEqual(done.returncode, 2, done.stderr)
        self.assertEqual(done.stdout, "STAGE_QA_RESULT status=refused sha=- cases=0 failed=0\n")
        self.assertFalse(self.record.exists())

    def test_a_payload_for_another_commit_is_refused_by_the_installed_config(self):
        done = self.run_entry(SHA, self.payload(sha="b" * 40))
        self.assertEqual(done.returncode, 2, done.stderr)
        self.assertEqual(
            done.stdout,
            "STAGE_BROWSER_LOCKED\n"
            + f"STAGE_QA_RESULT status=refused sha={SHA} cases=0 failed=0\n",
        )
        self.assertFalse(self.record.exists())


class Static(unittest.TestCase):
    def test_installer_never_talks_to_the_odroid_or_github_and_never_uses_sudo(self):
        text = INSTALLER.read_text()
        self.assertNotRegex(text, r"(?m)^\s*(ssh|scp|gh|curl|ssh-copy-id|sudo)\s")
        self.assertIn("set -euo pipefail", text)

    def test_script_parses(self):
        subprocess.run(["bash", "-n", str(INSTALLER)], check=True)

    def test_entry_passes_the_ssh_command_as_one_quoted_argument(self):
        self.assertIn('"${SSH_ORIGINAL_COMMAND-}"', INSTALLER.read_text())


if __name__ == "__main__":
    unittest.main()
