$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$pythonPath = Join-Path $projectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) { throw 'Run .\scripts\setup.ps1 first.' }
foreach ($port in @(8000, 5173)) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
        throw "Port $port is already in use. Stop the existing server or use its running app."
    }
}
$runtimePath = Join-Path $projectRoot '.runtime'
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
$backendProcess = $null
Push-Location $projectRoot
try {
    $backendProcess = Start-Process -FilePath $pythonPath -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000', '--no-access-log') -WorkingDirectory (Join-Path $projectRoot 'backend') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimePath 'backend.log') -RedirectStandardError (Join-Path $runtimePath 'backend-error.log')
    $ready = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/api/health' -TimeoutSec 2
            if ($health.status -eq 'ok') { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 250 }
    }
    if (-not $ready) { throw 'Backend did not start. See .runtime/backend-error.log.' }
    Write-Host 'App: http://localhost:5173 | API docs: http://localhost:8000/docs'
    Write-Host 'Press Ctrl+C to stop both servers. No user request/access logging is enabled.'
    & npm.cmd --prefix frontend run dev
} finally {
    if ($backendProcess -and -not $backendProcess.HasExited) {
        # Stop only the process tree started by this script (venv launcher may create a child).
        & taskkill.exe /PID $backendProcess.Id /T /F 2>$null | Out-Null
    }
    Pop-Location
}
