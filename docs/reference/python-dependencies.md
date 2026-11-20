# Python dependency locks

The host's Python dependency declarations live in `pyproject.toml`. The generated
`requirements.lock` records the universal resolution, including exact versions,
environment markers, requested extras, the package index and artifact hashes.

## Install the host environment

```bash
uv venv --python 3.12 venv
uv pip sync --require-hashes --python venv/bin/python requirements.lock
uv pip check --python venv/bin/python
```

The application continues to launch `venv/bin/python`. Voice calls additionally
need the patched ntgcalls build from the [deployment runbook](deploy-runbook.md#ntgcalls--build-from-source-voice-calls-only)
after dependency installation. Reapply that patch after a dependency update that
reinstalls ntgcalls; its source build and editable-install procedure are unchanged.
Do not run dependency installation against a live process's environment.

The container's smaller Python environment continues to use
`requirements.docker.txt`; its Docker build is independent of the host voice stack.

The older [deployment specification](../specs/deployment.md#6-telegram-mtproto-optional)
retains its historical `uv pip install -r pyproject.toml` example. Use the hash-checked
installation sequence above for a current checkout; the operational
[deployment runbook](deploy-runbook.md) follows the same lock contract.

## Update the lock

Use the uv pip workflow for this project. uv 0.12.24 is the lock generator used by CI.
Run the wrapper with Python 3.12 or newer.
Its universal resolver reads the project's `requires-python = ">=3.12"` constraint.

```bash
python3 scripts/compile-python-lock.py
```

The wrapper retains the native universal, hash, index and extras flags. uv writes
the current project version into its generated command header with
`--custom-compile-command`; the recorded command's `--project-version` also rejects
a stale copied version. The version regression test detects a project version bump
without lock regeneration. This stamp is generated from the declared version only
during compilation, and the test reads the stored lock independently.

Existing pins remain preferred. Add `--upgrade-package <name>` to the wrapper only
when deliberately updating that dependency, and review the complete lock diff.
The header records the normal regeneration command, which preserves the resulting
pins. Commit declaration and lock changes together. The `python-lock` workflow first
requires `requirements.lock` to be tracked, then runs the same command and fails if
the generated version stamp, dependency graph or
environment markers differ from the committed lock.

Compilation reuses the existing artifact hash allowlists. It does not independently
authenticate every stored hash: the unchanged compiler output can retain a manually
corrupted hash. The `--require-hashes` install command checks the selected artifacts
against those allowlists. Review lock changes together with the declared dependencies.
A fresh resolution can add artifact hashes and increase the file's line count; the
same file-size check applies to that change. Do not compact or exempt the lock.

## Migration evidence for #860

At source revision `bb7a9d4765e406b3c2c258fc4ad55445643857ac`, the native TOML
`uv.lock` contained 1,343 physical lines. Native `uv export`, followed by universal
`uv pip compile`, initially produced the 942-line `requirements.lock` with uv's
header and dependency annotations. The version-aware wrapper retains all 942 lines
and every dependency-body byte; its native generated command header also records
the project version. No formatting was compacted by hand.

The migration preserves all 55 registry package versions, all 803 per-package
artifact hashes and the `https://pypi.org/simple` index. The ten direct dependency
requirements and the Python version requirement in `pyproject.toml` are unchanged.
The installed package sets and requested extras match across all 36 truth
partitions of the original marker expressions: Python boundaries 3.13 and 3.15,
the named operating systems and machine architectures, and their residual values.

The file-size policy still measures lockfiles with the same 1,200/2,400 thresholds.
The generated requirements lock replaces the TOML lock as the host install input.
