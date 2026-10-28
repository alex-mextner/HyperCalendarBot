#!/usr/bin/env python3
"""Inventory offline call prerequisites. Never authenticate, load secrets or dial."""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import shutil

REQUIRED_ENV = (
    "MTPROTO_API_ID", "MTPROTO_API_HASH", "MTPROTO_SERVICE_USER_ID",
    "DEEPGRAM_API_KEY", "REDIS_URL",
)
# pyrofork provides the pyrogram import used by the bridge.
PACKAGES = ("pyrofork", "py-tgcalls", "ntgcalls", "websockets", "torch", "numpy", "silero-vad")
UNVERIFIED = (
    "configuration_values", "service_identity", "voice_enabled", "redis_connectivity",
    "ntgcalls_network_patch", "bracho_tts", "streaming_stt", "agent_roundtrip",
    "recipient_binding", "blocker_call_policy", "test_call_consent",
    "received_non_silent_audio", "barge_in_and_hangup",
)


def package_present(name):
    # Metadata only: importing the bridge would load models and connect to Telegram.
    try:
        importlib.metadata.version(name)
        return True
    except importlib.metadata.PackageNotFoundError:
        return False


def collect(root, environment, has_package=package_present, which=shutil.which):
    """Presence is an inventory fact, never configuration or authorization proof.

    Empty values are reported as missing: src/config/env.ts maps "" to unset, so
    ServiceTier fails closed on them. Non-empty values are never examined."""
    env_status = {
        name: "absent" if name not in environment
        else "empty" if environment[name] == ""
        else "present_unvalidated"
        for name in REQUIRED_ENV
    }
    packages = {name: bool(has_package(name)) for name in PACKAGES}
    executables = {name: bool(which(name)) for name in ("bun", "ffmpeg")}
    try:
        session_file = (root / "data/voice_caller.session").is_file()
    except OSError:
        session_file = False
    missing = [name for name, status in env_status.items() if status != "present_unvalidated"]
    missing.extend(name for name, present in packages.items() if not present)
    missing.extend(name for name, present in executables.items() if not present)
    if not session_file:
        missing.append("session_file")
    return {
        "schema_version": 1,
        "mode": "offline_inventory",
        "live_call_ready": False,
        "environment": env_status,
        "packages": packages,
        "executables": executables,
        "session_file_present_unvalidated": session_file,
        "missing_prerequisites": missing,
        "unverified": list(UNVERIFIED),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1],
                        help="Repository/deployment root; only checks session file existence")
    args = parser.parse_args()
    report = collect(args.root, os.environ)
    print(json.dumps(report, indent=2))
    # Exit codes avoid argparse usage errors (2) and uncaught exceptions (1):
    # 3 = missing prerequisites; 4 = inventory complete, live readiness unproven.
    return 3 if report["missing_prerequisites"] else 4


if __name__ == "__main__":
    raise SystemExit(main())
