#!/usr/bin/env python3
"""Silero TTS bridge. Generates speech audio from stressed Russian text.

Usage: python scripts/silero-tts.py <text> <output_path> [speaker] [sample_rate]

Text should contain + before stressed vowels: "Прив+ет! Как дел+а?"
Output is OGG Opus (Telegram voice message format).
"""

import subprocess
import sys
import tempfile

import torch


def ensure_model():
    model, _ = torch.hub.load(
        repo_or_dir="snakers4/silero-models",
        model="silero_tts",
        language="ru",
        speaker="v5_ru",
        trust_repo=True,
    )
    return model


def text_to_ogg(model, text, output_path, speaker="xenia", sample_rate=48000):
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = tmp.name

    model.save_wav(text=text, speaker=speaker, sample_rate=sample_rate, audio_path=wav_path)

    # Convert WAV to OGG Opus (Telegram requires this for voice messages)
    subprocess.run(
        ["ffmpeg", "-y", "-i", wav_path, "-c:a", "libopus", "-b:a", "64k", output_path],
        capture_output=True,
        check=True,
    )

    import os
    os.unlink(wav_path)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: silero-tts.py <text> <output_path> [speaker] [sample_rate]", file=sys.stderr)
        sys.exit(1)

    text = sys.argv[1]
    output_path = sys.argv[2]
    speaker = sys.argv[3] if len(sys.argv) > 3 else "xenia"
    sample_rate = int(sys.argv[4]) if len(sys.argv) > 4 else 48000

    model = ensure_model()
    text_to_ogg(model, text, output_path, speaker, sample_rate)
    print("OK")
