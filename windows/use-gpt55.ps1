$ErrorActionPreference = "Stop"

$ConfigPath = Join-Path $env:USERPROFILE ".codex\config.toml"
$Text = Get-Content $ConfigPath -Raw
$Text = $Text -replace '(?m)^model = ".*"$', 'model = "gpt-5.5"'
$Text = $Text -replace '(?m)^model_provider = "opencode-go-bridge"\r?\n', ''
Set-Content -Path $ConfigPath -Value $Text -NoNewline
Write-Host "Codex default model is now GPT-5.5."
