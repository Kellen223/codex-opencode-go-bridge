param(
  [switch]$RegisterStartup
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$BridgeDir = Join-Path $env:USERPROFILE ".codex\opencode-go-bridge"
$CodexDir = Join-Path $env:USERPROFILE ".codex"
$ConfigPath = Join-Path $CodexDir "config.toml"
$StartupShortcutPath = Join-Path ([Environment]::GetFolderPath("Startup")) "Codex OpenCode Go Bridge.lnk"

function Set-TopLevelSetting {
  param(
    [string]$Text,
    [string]$Key,
    [AllowNull()][string]$Value
  )

  $pattern = "(?m)^$Key = `"[^`"]*`"\r?\n?"
  if ($null -eq $Value) {
    return ($Text -replace $pattern, "")
  }

  $line = "$Key = `"$Value`""
  if ($Text -match $pattern) {
    return ($Text -replace $pattern, "$line`n")
  }

  return "$line`n$Text"
}

function Ensure-Block {
  param(
    [string]$Text,
    [string]$Header,
    [string]$Block
  )

  if ($Text -match [regex]::Escape($Header)) {
    return $Text
  }

  return ($Text.TrimEnd() + "`n`n" + $Block.Trim() + "`n")
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js was not found in PATH. Install Node.js LTS from https://nodejs.org/ and rerun this script."
}

New-Item -ItemType Directory -Force $BridgeDir | Out-Null
New-Item -ItemType Directory -Force $CodexDir | Out-Null

Copy-Item -Force (Join-Path $ProjectRoot "server.mjs") (Join-Path $BridgeDir "server.mjs")
Copy-Item -Force (Join-Path $PSScriptRoot "start-opencode-go-bridge.ps1") (Join-Path $CodexDir "start-opencode-go-bridge.ps1")
Copy-Item -Force (Join-Path $PSScriptRoot "use-deepseek.ps1") (Join-Path $CodexDir "use-deepseek.ps1")
Copy-Item -Force (Join-Path $PSScriptRoot "use-deepseek-pro.ps1") (Join-Path $CodexDir "use-deepseek-pro.ps1")
Copy-Item -Force (Join-Path $PSScriptRoot "use-gpt55.ps1") (Join-Path $CodexDir "use-gpt55.ps1")

if (-not (Test-Path $ConfigPath)) {
  New-Item -ItemType File -Force $ConfigPath | Out-Null
}

$config = Get-Content $ConfigPath -Raw
$config = Set-TopLevelSetting -Text $config -Key "model" -Value "deepseek-v4-flash"
$config = Set-TopLevelSetting -Text $config -Key "model_provider" -Value "opencode-go-bridge"

if ($config -notmatch '(?m)^model_reasoning_effort = ') {
  $config = Set-TopLevelSetting -Text $config -Key "model_reasoning_effort" -Value "medium"
}

$config = Ensure-Block -Text $config -Header "[profiles.opencode-go]" -Block @"
[profiles.opencode-go]
model = "deepseek-v4-flash"
model_provider = "opencode-go-bridge"
"@

$config = Ensure-Block -Text $config -Header "[profiles.opencode-go-pro]" -Block @"
[profiles.opencode-go-pro]
model = "deepseek-v4-pro"
model_provider = "opencode-go-bridge"
"@

$config = Ensure-Block -Text $config -Header "[model_providers.opencode-go-bridge]" -Block @"
[model_providers.opencode-go-bridge]
name = "OpenCode Go Bridge"
base_url = "http://127.0.0.1:41425/v1"
api_key = "local-bridge"
wire_api = "responses"
"@

Set-Content -Path $ConfigPath -Value $config -NoNewline

if ($RegisterStartup) {
  $script = Join-Path $CodexDir "start-opencode-go-bridge.ps1"
  $wsh = New-Object -ComObject WScript.Shell
  $shortcut = $wsh.CreateShortcut($StartupShortcutPath)
  $shortcut.TargetPath = "powershell.exe"
  $shortcut.Arguments = "-ExecutionPolicy Bypass -File `"$script`""
  $shortcut.WorkingDirectory = $CodexDir
  $shortcut.WindowStyle = 7
  $shortcut.Description = "Runs local bridge and dashboard for Codex to use OpenCode Go models."
  $shortcut.Save()
}

Write-Host "Installed Codex OpenCode Go Bridge."
Write-Host "Set your API key with:"
Write-Host '  setx OPENCODE_GO_API_KEY "your-opencode-go-api-key"'
Write-Host "Then open a new PowerShell window and run:"
Write-Host '  PowerShell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.codex\start-opencode-go-bridge.ps1"'
Write-Host "Dashboard:"
Write-Host "  http://127.0.0.1:41425/"
