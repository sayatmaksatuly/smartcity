$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$pythonPath = Join-Path $projectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) { throw 'Run .\scripts\setup.ps1 first.' }
Push-Location (Join-Path $projectRoot 'backend')
try {
    & $pythonPath -m app.scripts.import_pois
    if ($LASTEXITCODE -ne 0) { throw 'Import failed; existing data was preserved. Retry later.' }
} finally { Pop-Location }
