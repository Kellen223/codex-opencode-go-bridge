$ErrorActionPreference = "Stop"

$BridgeDir = Join-Path $env:USERPROFILE ".codex\opencode-go-bridge"
$ServerPath = Join-Path $BridgeDir "server.mjs"

if (-not $env:OPENCODE_GO_API_KEY) {
  throw "OPENCODE_GO_API_KEY is not set. Run: setx OPENCODE_GO_API_KEY `"your-opencode-go-key`", then open a new PowerShell window."
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js was not found in PATH. Install Node.js LTS from https://nodejs.org/ and open a new PowerShell window."
}

& $node.Source $ServerPath
