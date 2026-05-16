param(
  [string]$VpsHost = $env:VPS_HOST,
  [string]$VpsUser = $(if ($env:VPS_USER) { $env:VPS_USER } else { "root" }),
  [string]$RemoteDir = $(if ($env:VPS_APP_DIR) { $env:VPS_APP_DIR } else { "/opt/proxy" }),
  [switch]$SkipEnv,
  [switch]$SkipChecks
)

$ErrorActionPreference = "Stop"

function Step($message) {
  Write-Host ""
  Write-Host "==> $message" -ForegroundColor Cyan
}

function RequireCommand($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Missing command: $name"
  }
}

if (-not $VpsHost) {
  throw "VPS host is required. Pass -VpsHost 82.29.155.252 or set VPS_HOST."
}

if ($RemoteDir.Contains("'")) {
  throw "RemoteDir cannot contain a single quote."
}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PackagePath = Join-Path $Root "proxy-deploy.tar.gz"
$Remote = "$VpsUser@$VpsHost"
$RemotePackage = "/tmp/proxy-deploy.tar.gz"

Set-Location $Root

RequireCommand "git"
RequireCommand "ssh"
RequireCommand "scp"
RequireCommand "tar"

Step "Changed files"
$changedFiles = git status --short
if ($changedFiles) {
  $changedFiles
} else {
  Write-Host "No git changes detected."
}

if (-not $SkipChecks) {
  RequireCommand "node"
  RequireCommand "docker"

  Step "Local syntax checks"
  node --check server.js
  node --check Routes\realtime.js

  Step "Local Docker Compose config check"
  docker compose config | Out-Null
}

Step "Creating deploy package"
if (Test-Path $PackagePath) {
  Remove-Item -LiteralPath $PackagePath -Force
}

$excludeArgs = @(
  "--exclude=.git",
  "--exclude=node_modules",
  "--exclude=uploads",
  "--exclude=proxy-deploy.tar.gz",
  "--exclude=npm-debug.log",
  "--exclude=.env.local"
)

if ($SkipEnv) {
  $excludeArgs += "--exclude=.env"
} elseif (-not (Test-Path (Join-Path $Root ".env"))) {
  Write-Host "Warning: local .env was not found. The VPS must already have $RemoteDir/.env." -ForegroundColor Yellow
}

& tar @excludeArgs -czf $PackagePath .

Step "Uploading package to VPS"
ssh $Remote "mkdir -p '$RemoteDir'"
scp $PackagePath "${Remote}:$RemotePackage"

Step "Deploying on VPS"
$remoteCommand = "cd '$RemoteDir' && tar -xzf '$RemotePackage' && rm -f '$RemotePackage' && if docker compose version >/dev/null 2>&1; then COMPOSE='docker compose'; elif command -v docker-compose >/dev/null 2>&1; then COMPOSE='docker-compose'; else echo 'Docker Compose is not installed on the VPS.'; exit 1; fi && `$COMPOSE config >/dev/null && `$COMPOSE up -d --build && docker image prune -f && `$COMPOSE ps"
ssh $Remote $remoteCommand

Step "Done"
Write-Host "HTTP realtime:        http://$VpsHost`:3000/realtime/{matchId}"
Write-Host "HTTP tablestandings: http://$VpsHost`:3000/tablestandings/{matchId}"
Write-Host "WS realtime:          ws://$VpsHost`:3000/ws/realtime/{matchId}"
Write-Host "WS tablestandings:   ws://$VpsHost`:3000/ws/tablestandings/{matchId}"
