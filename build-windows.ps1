$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Set-Location -LiteralPath $PSScriptRoot

$logFile = Join-Path $PSScriptRoot 'build-windows.log'
$releaseDirectory = Join-Path $PSScriptRoot 'release'
$exitCode = 0

try {
    Start-Transcript -Path $logFile -Force | Out-Null
    Write-Host 'ProfileDesk Windows Builder' -ForegroundColor Cyan
    Write-Host "Working directory: $PSScriptRoot"
    Write-Host "Build log: $logFile"

    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        throw 'Node.js 24 is required. Install it from https://nodejs.org/ first.'
    }
    if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
        throw 'Git for Windows is required. Install it from https://git-scm.com/download/win first.'
    }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw 'npm.cmd was not found. Repair the Node.js installation and enable Add to PATH.'
    }

    $nodeVersion = (& node.exe --version).Trim()
    $nodeMajor = [int]($nodeVersion -replace '^v(\d+).*$','$1')
    if ($nodeMajor -lt 24) {
        throw "Node.js 24 or newer is required. Current version: $nodeVersion"
    }
    Write-Host "Node.js: $nodeVersion"

    Write-Host "`n[1/3] Installing dependencies..." -ForegroundColor Cyan
    & npm.cmd ci --allow-git=all
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }

    Write-Host "`n[2/3] Running checks..." -ForegroundColor Cyan
    & npm.cmd run verify
    if ($LASTEXITCODE -ne 0) { throw "npm run verify failed with exit code $LASTEXITCODE" }

    Write-Host "`n[3/3] Building installer and portable package..." -ForegroundColor Cyan
    & npm.cmd run dist:win
    if ($LASTEXITCODE -ne 0) { throw "npm run dist:win failed with exit code $LASTEXITCODE" }

    $executables = @(Get-ChildItem -LiteralPath $releaseDirectory -Filter 'ProfileDesk*.exe' -File | Where-Object {
        $_.Name -match '^ProfileDesk( Setup)? \d+\.\d+\.\d+\.exe$'
    })
    if ($executables.Count -ne 2) { throw 'Installer or portable executable is missing from release.' }
    $hashLines = $executables | Sort-Object Name | ForEach-Object {
        $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash *$($_.Name)"
    }
    $hashLines | Set-Content -LiteralPath (Join-Path $releaseDirectory 'SHA256SUMS.txt') -Encoding ascii

    $unsigned = @($executables | Where-Object { (Get-AuthenticodeSignature -LiteralPath $_.FullName).Status -ne 'Valid' })
    if ($unsigned.Count -gt 0) {
        Write-Warning 'Windows packages are not code-signed. Chrome and SmartScreen may block public downloads.'
    }

    Write-Host "`nBuild completed: $releaseDirectory" -ForegroundColor Green
    if (Test-Path -LiteralPath $releaseDirectory) {
        Start-Process explorer.exe -ArgumentList $releaseDirectory
    }
}
catch {
    $exitCode = 1
    Write-Host "`nBUILD FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Full log: $logFile" -ForegroundColor Yellow
}
finally {
    try { Stop-Transcript | Out-Null } catch {}
}

exit $exitCode
