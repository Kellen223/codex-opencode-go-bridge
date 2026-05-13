$ErrorActionPreference = "Stop"

$ConfigPath = Join-Path $env:USERPROFILE ".codex\config.toml"
$Text = Get-Content $ConfigPath -Raw
$Parts = $Text -split "(?m)(?=^\[)", 2
$Top = $Parts[0]
$Rest = if ($Parts.Count -gt 1) { $Parts[1] } else { "" }
$Top = $Top -replace '(?m)^model = ".*"$', 'model = "gpt-5.5"'
$Top = $Top -replace '(?m)^model_provider = "opencode-go-bridge"\r?\n', ''
$Text = $Top + $Rest
Set-Content -Path $ConfigPath -Value $Text -NoNewline
Write-Host "Codex default model is now GPT-5.5."
