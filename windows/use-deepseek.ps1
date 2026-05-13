$ErrorActionPreference = "Stop"

$ConfigPath = Join-Path $env:USERPROFILE ".codex\config.toml"
$Text = Get-Content $ConfigPath -Raw
$Text = $Text -replace '(?m)^model = ".*"$', 'model = "deepseek-v4-flash"'
if ($Text -notmatch '(?m)^model_provider = "opencode-go-bridge"$') {
  $Text = $Text -replace '(?m)^(model = "deepseek-v4-flash"\r?\n)', "`$1model_provider = `"opencode-go-bridge`"`n"
}
Set-Content -Path $ConfigPath -Value $Text -NoNewline
Write-Host "Codex default model is now DeepSeek V4 Flash."
