<#
.SYNOPSIS
    Push Heroku Config Vars across multiple Mini Bot worker apps (e.g., 130 servers)
    reading secrets ONLY from a local untracked .env file at runtime.

.EXAMPLE
    # From apps listed in servers.txt (one Heroku app name per line):
    .\scripts\sync-heroku-env.ps1 -AppsFile .\servers.txt

    # Or explicit range / app list:
    .\scripts\sync-heroku-env.ps1 -Apps @('mini-bot-1', 'mini-bot-2') -SetAppUrl
#>
param(
    [string]$EnvFile = "$PSScriptRoot\..\.env",
    [string[]]$Apps = @(),
    [string]$AppsFile = "",
    [switch]$SetAppUrl,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command heroku -ErrorAction SilentlyContinue)) {
    throw "Heroku CLI ('heroku') PATH mein nahi mila. Pehle Heroku CLI install aur login ('heroku login') karein."
}

if (-not (Test-Path $EnvFile)) {
    throw "Local .env file nahi mili: $EnvFile (secrets sirf local .env mein rakhein, Git mein nahi)."
}

if ($AppsFile) {
    if (-not (Test-Path $AppsFile)) {
        throw "AppsFile nahi mili: $AppsFile"
    }
    $Apps += Get-Content $AppsFile | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') }
}

$Apps = $Apps | Where-Object { $_ } | Select-Object -Unique
if (-not $Apps -or $Apps.Count -eq 0) {
    throw "Koi Heroku app name nahi diya gaya. -Apps @('app1','app2') ya -AppsFile .\servers.txt pass karein."
}

# Parse only needed keys from local .env (non-secret defaults already exist in code)
$allowedKeys = @(
    'MONGODB_URI',
    'CLUSTER_SECRET',
    'PORTAL_URL',
    'MINI_CLUSTER_NODES',
    'MAX_SESSIONS',
    'RAM_SOFT_LIMIT_MB',
    'MASTER_OWNER_NUMBERS'
)

$envVars = [ordered]@{}
foreach ($line in Get-Content $EnvFile) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $idx = $trimmed.IndexOf('=')
    if ($idx -lt 1) { continue }
    $k = $trimmed.Substring(0, $idx).Trim()
    $v = $trimmed.Substring($idx + 1).Trim().Trim('"').Trim("'")
    if ($allowedKeys -contains $k -and $v) {
        $envVars[$k] = $v
    }
}

if (-not $envVars.Contains('MONGODB_URI')) {
    throw "MONGODB_URI local .env file mein missing hai."
}

Write-Host "Loaded $($envVars.Count) shared config key(s) from $EnvFile for $($Apps.Count) Heroku app(s)." -ForegroundColor Cyan

foreach ($app in $Apps) {
    $pairs = @()
    foreach ($kv in $envVars.GetEnumerator()) {
        $pairs += "$($kv.Key)=$($kv.Value)"
    }
    $pairs += "WORKER_ID=$app"
    if ($SetAppUrl) {
        $pairs += "APP_URL=https://$app.herokuapp.com"
    }

    if ($DryRun) {
        Write-Host "[DRY-RUN] Would update $app ($($pairs.Count) keys: WORKER_ID=$app$(if ($SetAppUrl) { ", APP_URL=https://$app.herokuapp.com" }))" -ForegroundColor Yellow
        continue
    }

    Write-Host "Syncing config vars -> $app ..." -ForegroundColor Green
    & heroku config:set @pairs -a $app | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Failed to update $app (exit $LASTEXITCODE)"
    }
}

Write-Host "Done! Config sync finished for $($Apps.Count) server(s)." -ForegroundColor Cyan
