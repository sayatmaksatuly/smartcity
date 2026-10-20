$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Push-Location $projectRoot
try {
    if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw 'Install Python 3.11+ and enable Add Python to PATH.' }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24 LTS, then reopen PowerShell.' }
    & python -c 'import sys; assert sys.version_info >= (3, 11), "Python 3.11+ required"'
    if ($LASTEXITCODE -ne 0) { throw 'Unsupported Python version.' }
    if (-not (Test-Path '.venv\Scripts\python.exe')) {
        & python -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw 'Could not create .venv. Check Python installation and directory access.' }
    }
    & .\.venv\Scripts\python.exe -m pip install -r backend\requirements-lock.txt
    if ($LASTEXITCODE -ne 0) { throw 'Backend dependency installation failed. Check internet access.' }
    & npm.cmd --prefix frontend ci --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed. Check Node.js version and internet access.' }
    if (-not (Test-Path 'backend\.env')) { Copy-Item -LiteralPath 'backend\.env.example' -Destination 'backend\.env' }
    Write-Host 'Setup complete. Optional: edit backend/.env to set GEMINI_API_KEY.'
    Write-Host 'Next: .\scripts\import-pois.ps1 then .\scripts\start.ps1'
} finally { Pop-Location }
