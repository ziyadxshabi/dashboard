import json
import re
from pathlib import Path

N8N_DIR = Path(__file__).resolve().parent.parent / "n8n"
ENV_RE = re.compile(r"\$env\['([A-Z0-9_]+)'\]")


def walk(obj, hits):
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key in ("jsCode", "code") and isinstance(value, str):
                for match in ENV_RE.finditer(value):
                    key_name = match.group(1)
                    start = match.start()
                    window = value[max(0, start - 60) : start + 80]
                    ok = f"$vars['{key_name}'] ?? $env['{key_name}']" in window
                    if not ok:
                        hits.append((key_name, window.replace("\n", " ")[:140]))
            else:
                walk(value, hits)
    elif isinstance(obj, list):
        for item in obj:
            walk(item, hits)


for path in sorted(N8N_DIR.glob("*.json")):
    data = json.loads(path.read_text(encoding="utf-8"))
    hits = []
    walk(data, hits)
    if hits:
        print(path.name)
        for key_name, ctx in hits:
            print(f"  {key_name}: {ctx}")
