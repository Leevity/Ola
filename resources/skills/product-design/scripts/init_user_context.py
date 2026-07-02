#!/usr/bin/env python3
"""Create the Ola Product Design context file."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

PLUGIN_STATE_DIR = Path(".ola/state/plugins/product-design")

CONTEXT_TEMPLATE = """<!--
Product Design context for Ola.
Unresolved `status: not provided` entries are setup prompts, not saved facts.
Do not store secrets, credentials, API keys, private tokens, or customer data.
-->

# Product URLs

- Description: Production, staging, local app, docs, admin, or key flow URLs.

## Saved Links And Context

status: not provided

# Figma And Design Sources

- Description: Figma files, design-system files, component libraries, prototypes, or boards.

## Saved Links And Context

status: not provided

# Screenshots And Reference Images

- Description: Local screenshots and reference images saved under `assets/`.

## Saved Links And Context

status: not provided

# Codebase References

- Description: Repo roots, app packages, component folders, tokens, theme files, or CSS entrypoints.

## Saved Links And Context

status: not provided

# Storybook And Component Docs

- Description: Storybook URLs, component docs, design-system docs, or preview commands.

## Saved Links And Context

status: not provided

# Design Tokens And Theme Sources

- Description: Typography, spacing, color, radius, icon, motion, CSS variable, Tailwind, or theme sources.

## Saved Links And Context

status: not provided

# Brand And Asset Sources

- Description: Logos, app icons, illustration libraries, product imagery, icon sets, and brand guidelines.

## Saved Links And Context

status: not provided

# Tool And Sharing Preferences

- Description: Preferred browser, capture tool, share target, deployment target, and team workflow notes.

## Saved Links And Context

status: not provided
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Initialize Ola Product Design context.")
    parser.add_argument(
        "--home",
        type=Path,
        default=None,
        help="Home directory. Defaults to $HOME.",
    )
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=None,
        help="Override Product Design state directory.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing user-context.md.",
    )
    return parser.parse_args()


def resolve_state_dir(home: Path | None, state_dir: Path | None) -> Path:
    if state_dir is not None:
        return state_dir.expanduser().resolve()
    resolved_home = home or Path(os.environ.get("HOME", "~"))
    return (resolved_home.expanduser() / PLUGIN_STATE_DIR).resolve()


def main() -> int:
    args = parse_args()
    state_dir = resolve_state_dir(args.home, args.state_dir)
    assets_dir = state_dir / "assets"
    context_path = state_dir / "user-context.md"

    state_dir.mkdir(parents=True, exist_ok=True)
    assets_dir.mkdir(parents=True, exist_ok=True)

    existed = context_path.exists()
    if not existed or args.overwrite:
        context_path.write_text(CONTEXT_TEMPLATE, encoding="utf-8")

    result = "preserved" if existed and not args.overwrite else "created"
    if existed and args.overwrite:
        result = "overwritten"

    print(f"state_dir={state_dir}")
    print(f"context={context_path}")
    print(f"result={result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
