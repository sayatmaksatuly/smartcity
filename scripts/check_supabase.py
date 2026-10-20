"""Non-mutating Supabase readiness check. Prints only fixed statuses, never keys/URLs."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from dotenv import dotenv_values


def public_key(value: str) -> bool:
    if value.startswith("sb_publishable_"):
        return True
    try:
        part = value.split(".")[1]
        payload = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
        return payload.get("role") == "anon"
    except (IndexError, ValueError, TypeError):
        return False


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    frontend = dotenv_values(root / "frontend" / ".env.local")
    backend = dotenv_values(root / "backend" / ".env")
    for label, values, fields in (
        ("frontend", frontend, ("VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY")),
        ("backend", backend, ("SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY")),
    ):
        for field in fields:
            print(f"{label}.{field}: {'present' if values.get(field) else 'missing'}")
    url = frontend.get("VITE_SUPABASE_URL") or ""
    key = frontend.get("VITE_SUPABASE_PUBLISHABLE_KEY") or ""
    parts = urlsplit(url)
    if not public_key(key) or parts.scheme != "https" or parts.username or parts.password:
        print("configuration: missing_or_not_public")
        return 1
    try:
        with httpx.Client(timeout=15, headers={"apikey": key}, follow_redirects=False) as client:
            settings = client.get(f"{url.rstrip('/')}/auth/v1/settings")
            print(f"auth_settings_http: {settings.status_code}")
            if settings.status_code == 200:
                config = settings.json()
                print(f"email_provider_enabled: {bool(config.get('external', {}).get('email'))}")
                print(f"signup_disabled: {bool(config.get('disable_signup'))}")
                print(f"email_autoconfirm: {bool(config.get('mailer_autoconfirm'))}")
            for table in ("profiles", "favorites", "saved_walks"):
                response = client.get(f"{url.rstrip('/')}/rest/v1/{table}", params={"select": "id", "limit": "1"})
                classification = "unexpected_response"
                if response.status_code in (401, 403):
                    classification = "anonymous_access_denied"
                elif response.status_code == 404:
                    classification = "table_missing_or_not_exposed"
                elif response.status_code == 200:
                    classification = "empty_anonymous_result" if response.json() == [] else "SECURITY_ANONYMOUS_DATA_VISIBLE"
                print(f"{table}: http={response.status_code} {classification}")
    except (httpx.HTTPError, ValueError):
        print("live_check: network_or_response_error")
        return 1
    print("live_auth_login_and_two_account_rls: not_tested")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
