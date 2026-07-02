#!/usr/bin/env python3
"""Print compact JSON for saved Ola Product Design context."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PLUGIN_STATE_DIR = Path(".ola/state/plugins/product-design")
DEFAULT_MAX_BYTES = 2_000_000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read Ola Product Design context.")
    parser.add_argument("--home", type=Path, default=None, help="Home directory. Defaults to $HOME.")
    parser.add_argument("--state-dir", type=Path, default=None, help="Override state directory.")
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    return parser.parse_args()


def resolve_state_dir(home: Path | None, state_dir: Path | None) -> Path:
    if state_dir is not None:
        return state_dir.expanduser().resolve()
    resolved_home = home or Path(os.environ.get("HOME", "~"))
    return (resolved_home.expanduser() / PLUGIN_STATE_DIR).resolve()


def file_mtime(path: Path) -> str | None:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
    except OSError:
        return None


def parse_reference(line: str) -> dict[str, str]:
    link = re.match(r"^\[(.+?)\]\((.+?)\)$", line)
    if link:
        return {"name": link.group(1).strip(), "url": link.group(2).strip()}
    if re.match(r"^https?://\S+$", line):
        return {"name": line, "url": line}
    return {"name": line}


def summarize(markdown: str) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    unresolved_categories: list[str] = []
    category: str | None = None
    in_saved = False
    current: dict[str, Any] | None = None

    def flush() -> None:
        nonlocal current
        if current:
            entries.append(current)
            current = None

    for raw_line in markdown.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("<!--") or line.startswith("-->"):
            continue

        category_match = re.match(r"^# ([^#].+)$", line)
        if category_match:
            flush()
            category = category_match.group(1).strip()
            in_saved = False
            continue

        if line == "## Saved Links And Context":
            flush()
            in_saved = True
            continue

        if not category or not in_saved:
            continue

        if line.lower().rstrip(".") == "status: not provided":
            flush()
            unresolved_categories.append(category)
            continue

        if not line.startswith("- "):
            flush()
            current = {"category": category, **parse_reference(line)}
            continue

        if current is None:
            continue

        bullet = line[2:].strip()
        for prefix, key in (
            ("Date Added:", "date_added"),
            ("File:", "file"),
            ("Useful Context:", "useful_context"),
            ("Future Use:", "future_use"),
        ):
            if bullet.startswith(prefix):
                current[key] = bullet[len(prefix) :].strip().rstrip(".")
                break
        else:
            current.setdefault("notes", []).append(bullet)

    flush()
    return {"entries": entries, "unresolved_categories": unresolved_categories}


def main() -> int:
    args = parse_args()
    state_dir = resolve_state_dir(args.home, args.state_dir)
    context_path = state_dir / "user-context.md"

    payload: dict[str, Any] = {
        "plugin": "product-design",
        "state_dir": str(state_dir),
        "assets_dir": str(state_dir / "assets"),
        "user_context": {
            "path": str(context_path),
            "exists": context_path.exists(),
        },
    }

    if not context_path.exists():
        payload["user_context"].update(
            {"status": "missing", "entries": [], "unresolved_categories": []}
        )
        print(json.dumps(payload, indent=2))
        return 0

    size = context_path.stat().st_size
    if size > args.max_bytes:
        payload["user_context"].update(
            {
                "status": "too_large",
                "size_bytes": size,
                "max_bytes": args.max_bytes,
                "entries": [],
                "unresolved_categories": [],
            }
        )
        print(json.dumps(payload, indent=2))
        return 0

    markdown = context_path.read_text(encoding="utf-8")
    payload["user_context"].update(
        {
            "status": "present",
            "sha256": hashlib.sha256(markdown.encode("utf-8")).hexdigest(),
            "modified_at": file_mtime(context_path),
            **summarize(markdown),
        }
    )
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
