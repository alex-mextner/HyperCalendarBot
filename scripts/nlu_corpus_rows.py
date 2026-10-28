"""Row-level helpers of the NLU corpus tool: user-text decoding, tool-name extraction, conversation placement and row identity."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import re

NAME_RE = re.compile("[a-z_]{1,80}")  # a tool name or a chat_history role


def _is_id(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_name(value: object) -> bool:
    return isinstance(value, str) and NAME_RE.fullmatch(value) is not None


def _is_tool_result(value: object) -> bool:
    return (
        isinstance(value, (list, tuple))
        and len(value) == 2
        and _is_name(value[0])
        and value[1] in ("OK", "ERROR")
    )


def user_text(content: str) -> tuple[str, str]:
    try:
        parsed = json.loads(content)
    except (ValueError, TypeError):
        return content, "text"
    if isinstance(parsed, dict):
        kind = parsed.get("kind", "text")
        if kind == "command":
            return str(parsed.get("name", "")) + " " + str(parsed.get("args", "")), kind
        if kind == "button":
            return str(parsed.get("label", "")), kind
        if isinstance(parsed.get("text"), str):
            return parsed["text"], str(kind)
    return content, "structured_unknown"


def _tool_call_names(value: dict) -> list[object]:
    """The tool names one JSON object declares, as an OpenAI `function` call or an Anthropic `tool_use` block."""
    names = []
    if value.get("type") == "function" and isinstance(value.get("function"), dict):
        names.append(value["function"].get("name", ""))
    if value.get("type") == "tool_use":
        names.append(value.get("name", ""))
    return names


def observed_tools(content: str) -> list[str]:
    try:
        parsed = json.loads(content)
    except (ValueError, TypeError):
        return []
    stack = [parsed]
    names = []
    while stack:
        value = stack.pop()
        if isinstance(value, list):
            stack.extend(value)
        elif isinstance(value, dict):
            names.extend(_tool_call_names(value))
            stack.extend(v for v in value.values() if isinstance(v, (dict, list)))
    return [name for name in names if _is_name(name)]


def place_rows(rows: list[dict]) -> tuple[list[dict], int]:
    """The rows with their conversation scope, instant and text, sorted by conversation and time, and
    the number of rows whose timestamp or ids cannot be read."""
    placed = []
    unplaced = 0
    for row in rows:
        try:
            value = row["created_at"].replace(" ", "T")
            instant = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
            if instant.tzinfo is None:
                instant = instant.replace(tzinfo=dt.timezone.utc)
            scope = f"{row['user_id']}:{row.get('chat_id') or row['user_id']}"
            placed.append(
                dict(row, scope=scope, at=instant.timestamp(), text=row.get("content", ""))
            )
        except (ValueError, KeyError, TypeError, AttributeError):
            unplaced += 1
    placed.sort(key=lambda row: (row["scope"], row["at"], row.get("id", 0)))
    return placed, unplaced


def row_key(row: dict) -> str:
    selected = {
        k: row.get(k) for k in ("id", "user_id", "chat_id", "role", "content", "created_at")
    }
    return hashlib.sha256(
        json.dumps(selected, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()
