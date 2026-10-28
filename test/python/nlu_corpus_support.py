"""Shared loader of the NLU corpus tests: scripts/nlu_corpus.py is imported by path, like the CLI's other callers."""

import importlib.util
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("nlu_corpus", ROOT / "scripts" / "nlu_corpus.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
