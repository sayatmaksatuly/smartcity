# AITU KEREK

- Work from this repository root; Python application lives in `backend`, Vite in `frontend`.
- Keep UI copy in `frontend/src/i18n/ru.ts`; Russian is the default language.
- POIs in production must come from the Overpass CLI. Never seed test fixtures into the default database.
- Ground all place facts in SQLite. Never call straight-line distance a walking route. Keep fallback visibly non-AI.
- Keep secrets on the backend. Do not log requests, user text, coordinates, or SDK exceptions containing credentials.
- Use `.venv/Scripts/python.exe -m pytest backend/tests`, Ruff, and `npm --prefix frontend run build` before handoff.
- Import is a local administrative CLI, never an HTTP route. Preserve data on failed refreshes.
