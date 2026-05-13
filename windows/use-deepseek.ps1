$ErrorActionPreference = "Stop"

$ConfigPath = Join-Path $env:USERPROFILE ".codex\config.toml"
$Text = Get-Content $ConfigPath -Raw
$Parts = $Text -split "(?m)(?=^\[)", 2
$Top = $Parts[0]
$Rest = if ($Parts.Count -gt 1) { $Parts[1] } else { "" }
$Top = $Top -replace '(?m)^model = ".*"$', 'model = "deepseek-v4-flash"'
if ($Top -notmatch '(?m)^model_provider = "opencode-go-bridge"$') {
  $Top = $Top -replace '(?m)^(model = "deepseek-v4-flash"\r?\n)', "`$1model_provider = `"opencode-go-bridge`"`n"
}
$Text = $Top + $Rest
Set-Content -Path $ConfigPath -Value $Text -NoNewline
Write-Host "Codex default model is now DeepSeek V4 Flash."
