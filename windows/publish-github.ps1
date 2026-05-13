param(
  [string]$RepoName = "codex-opencode-go-bridge",
  [ValidateSet("public", "private")]
  [string]$Visibility = "public"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git was not found. Install Git for Windows first."
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI was not found. Install it from https://cli.github.com/ first."
}

gh auth status | Out-Null

$repoExists = $false
try {
  gh repo view $RepoName | Out-Null
  $repoExists = $true
} catch {
  $repoExists = $false
}

if (-not $repoExists) {
  gh repo create $RepoName "--$Visibility" --source . --remote origin --push
} else {
  $remoteUrl = gh repo view $RepoName --json url --jq .url
  if (-not (git remote get-url origin 2>$null)) {
    git remote add origin "$remoteUrl.git"
  }
  git push -u origin main
}

Write-Host "Published repository: $RepoName"
