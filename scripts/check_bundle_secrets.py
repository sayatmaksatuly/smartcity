"""Check built assets for configured private keys. Never print values or matching text."""

import base64
import json
import os
import re
from pathlib import Path

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]


def main():
    config = {**dotenv_values(ROOT / "backend" / ".env"), **os.environ}
    secrets = [config.get(name, "") for name in (
        "GEMINI_API_KEY", "ORS_API_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"
    )]
    files = list((ROOT / "frontend" / "dist").rglob("*.js"))
    if not files:
        raise SystemExit("Build frontend before running this check.")
    configured_leaks = 0
    privileged_tokens = 0
    for path in files:
        text = path.read_text(encoding="utf-8")
        configured_leaks += sum(1 for value in secrets if value and len(value) >= 12 and value in text)
        privileged_tokens += len(re.findall(r"sb_secret_[A-Za-z0-9_-]{20,}", text))
        for token in re.findall(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", text):
            try:
                payload = token.split(".")[1]
                decoded = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
                role = decoded.get("role") if isinstance(decoded, dict) else None
                privileged_tokens += role == "service_role"
            except (ValueError, UnicodeError):
                continue
    print(json.dumps({"assets_checked": len(files), "configured_private_key_leaks": configured_leaks,
                      "privileged_tokens": privileged_tokens}))
    if configured_leaks or privileged_tokens:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
