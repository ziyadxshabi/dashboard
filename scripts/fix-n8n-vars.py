#!/usr/bin/env python3
"""Standardize n8n Code node variable references: $vars with $env fallback."""
import json
import re
from pathlib import Path

N8N_DIR = Path(__file__).resolve().parent.parent / "n8n"

ENV_STRING_RE = re.compile(
    r"String\(\$env\['([^']+)'\]\s*\?\?\s*''\)"
)
VARS_ONLY_RE = re.compile(
    r"String\(\$vars\['([^']+)'\]\s*\?\?\s*''\)"
)


def standardize_js(code: str) -> str:
    if not code:
        return code

    def env_repl(match: re.Match[str]) -> str:
        key = match.group(1)
        return f"String($vars['{key}'] ?? $env['{key}'] ?? '')"

    def vars_repl(match: re.Match[str]) -> str:
        key = match.group(1)
        return f"String($vars['{key}'] ?? $env['{key}'] ?? '')"

    code = ENV_STRING_RE.sub(env_repl, code)
    code = VARS_ONLY_RE.sub(vars_repl, code)
    return code


def walk_fix(obj) -> int:
    changes = 0
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key in ("jsCode", "code") and isinstance(value, str):
                fixed = standardize_js(value)
                if fixed != value:
                    obj[key] = fixed
                    changes += 1
            else:
                changes += walk_fix(value)
    elif isinstance(obj, list):
        for item in obj:
            changes += walk_fix(item)
    return changes


def main() -> None:
    total = 0
    for path in sorted(N8N_DIR.glob("*.json")):
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
        changes = walk_fix(data)
        if changes:
            path.write_text(
                json.dumps(data, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            print(f"{path.name}: {changes} code block(s)")
            total += changes
    print(f"Total: {total}")


if __name__ == "__main__":
    main()
