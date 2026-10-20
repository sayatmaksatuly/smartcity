param([switch]$Browser)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Push-Location $projectRoot
try {
    & .\.venv\Scripts\python.exe -m ruff check backend scripts
    if ($LASTEXITCODE -ne 0) { throw 'Ruff failed.' }
    & .\.venv\Scripts\python.exe -m pytest backend\tests -q
    if ($LASTEXITCODE -ne 0) { throw 'pytest failed.' }
    & npm.cmd --prefix frontend run lint
    if ($LASTEXITCODE -ne 0) { throw 'ESLint failed.' }
    & npm.cmd --prefix frontend run build
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript or production build failed.' }
    if ($Browser) {
        & npm.cmd --prefix frontend run test:e2e
        if ($LASTEXITCODE -ne 0) { throw 'Browser checks failed. Check Edge and free ports 8001/5174.' }
    }
    Write-Host 'All requested checks passed.'
} finally { Pop-Location }
