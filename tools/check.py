#!/usr/bin/env python3
"""The repo gate for the Hermes Notes plugin.

Runs in three tiers so it is useful in both places it has to work:

1. Always (stdlib only, no Hermes checkout needed):
   - every file the plugin needs exists, and the manifest is valid JSON
   - `desktop/plugin.js` imports only `@hermes/plugin-sdk` and `react*`
     (the runtime loader's own allowlist)
   - no `eval` / `new Function` / remote-scheme imports in the desktop surface
   - no em dash or en dash anywhere in shipped text (house style)
2. When node is present: `node --check` the desktop file as ESM.

Hermes' own admission lint (`hermes_cli.plugin_validate_desktop`) is a stronger
version of the import check, but importing it would make this gate depend on a
private module of a moving codebase. Run it by hand during release review, as
documented in AGENTS.md, instead of wiring it in here.

Exit 0 only when every check that ran is clean. A skipped check prints `SKIP`,
never a silent pass: the point is that the reader knows what did not run.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REQUIRED = [
    "plugin.yaml",
    "README.md",
    "LICENSE",
    "dashboard/manifest.json",
    "dashboard/plugin_api.py",
    "desktop/plugin.js",
    "tools/render-check.mjs",
]
TEXT_SUFFIXES = {".md", ".yaml", ".yml", ".json", ".py", ".js", ".mjs", ".sh", ""}
ALLOWED_IMPORT = re.compile(r"^(@hermes/plugin-sdk|react)(/[\w./-]+)?$")
IMPORT_RE = re.compile(r"(?:^|\n)\s*import\s+(?:[^'\"]*?from\s*)?['\"]([^'\"]+)['\"]")
FORBIDDEN = (
    ("dynamic code evaluation", re.compile(r"(?<![\w$.])eval\(|\bnew\s+Function\(")),
    ("remote import", re.compile(r"\bimport\s+(?:[^;'\"]*?\bfrom\s*)?['\"][a-zA-Z][\w+.-]*:")),
)

failures: list[str] = []
ran: list[str] = []
skipped: list[str] = []


def fail(message: str) -> None:
    failures.append(message)


def check_structure() -> None:
    for relative in REQUIRED:
        if not (ROOT / relative).is_file():
            fail(f"missing file: {relative}")
    manifest = ROOT / "dashboard" / "manifest.json"
    if manifest.is_file():
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except ValueError as exc:
            fail(f"dashboard/manifest.json is not valid JSON: {exc}")
            return
        for key in ("name", "label", "api"):
            if not data.get(key):
                fail(f"dashboard/manifest.json is missing '{key}'")
        if data.get("tab") and not data["tab"].get("hidden"):
            tab = data["tab"]
            entry = data.get("entry", "dist/index.js")
            if not (ROOT / "dashboard" / entry).is_file():
                fail(
                    "manifest declares a visible tab "
                    f"({tab.get('path')}) but ships no {entry}; "
                    "set tab.hidden or add the bundle"
                )
    ran.append("structure")


def check_imports() -> None:
    source = (ROOT / "desktop" / "plugin.js").read_text(encoding="utf-8")
    for specifier in IMPORT_RE.findall(source):
        if not ALLOWED_IMPORT.match(specifier):
            fail(f"desktop/plugin.js imports {specifier!r}; only '@hermes/plugin-sdk' and 'react*' load")
    for label, pattern in FORBIDDEN:
        if pattern.search(source):
            fail(f"desktop/plugin.js contains {label}")
    ran.append("import allowlist")


def check_dashes() -> None:
    bad = []
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file() or ".git" in path.parts or "__pycache__" in path.parts:
            continue
        if path.suffix not in TEXT_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if "\u2014" in text or "\u2013" in text:
            bad.append(str(path.relative_to(ROOT)))
    if bad:
        fail("em or en dash in: " + ", ".join(bad))
    ran.append("dash style")


def check_node() -> None:
    node = shutil.which("node")
    if not node:
        skipped.append("node --check (node not installed)")
        return
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "plugin.mjs"
        target.write_text((ROOT / "desktop" / "plugin.js").read_text(encoding="utf-8"), encoding="utf-8")
        result = subprocess.run([node, "--check", str(target)], capture_output=True, text=True)
    if result.returncode != 0:
        fail("node --check failed:\n" + (result.stderr or result.stdout).strip())
    ran.append("esm parse")


def check_render() -> None:
    """Exercise the markdown renderer and the title helpers in node."""
    node = shutil.which("node")
    if not node:
        skipped.append("render checks (node not installed)")
        return
    result = subprocess.run(
        [node, str(ROOT / "tools" / "render-check.mjs")],
        capture_output=True,
        text=True,
        cwd=str(ROOT),
    )
    if result.returncode != 0:
        fail("render checks failed:\n" + (result.stderr or result.stdout).strip())
    ran.append("markdown rendering")


def main() -> int:
    check_structure()
    check_imports()
    check_dashes()
    check_node()
    check_render()

    print("ran    : " + ", ".join(ran))
    for note in skipped:
        print("SKIP   : " + note)
    if failures:
        print("\nFAILED:")
        for item in failures:
            print("  - " + item)
        return 1
    print("\nOK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
