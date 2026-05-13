param(
  [string]$Owner = "Kellen223",
  [string]$RepoName = "codex-opencode-go-bridge",
  [string]$Branch = "main",
  [string]$Message = "Initial open source bridge"
)

$ErrorActionPreference = "Stop"

function ConvertFrom-SecureStringToPlainText {
  param([securestring]$SecureString)
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureString)
  try {
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

function Invoke-GitHubApi {
  param(
    [string]$Method,
    [string]$Path,
    [object]$Body = $null
  )

  $uri = "https://api.github.com$Path"
  $params = @{
    Method = $Method
    Uri = $uri
    Headers = $script:Headers
    TimeoutSec = 60
  }

  if ($null -ne $Body) {
    $params.ContentType = "application/json"
    $params.Body = ($Body | ConvertTo-Json -Depth 20)
  }

  Invoke-RestMethod @params
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git was not found. Install Git for Windows first."
}

$token = $env:GH_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
  $token = $env:GITHUB_TOKEN
}

if ([string]::IsNullOrWhiteSpace($token)) {
  $secureToken = Read-Host "Paste a GitHub token with Contents read/write access" -AsSecureString
  $token = ConvertFrom-SecureStringToPlainText $secureToken
}

if ([string]::IsNullOrWhiteSpace($token)) {
  throw "Token was empty."
}

$script:Headers = @{
  Authorization = "Bearer $token"
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent" = "codex-opencode-go-bridge-publisher"
}

$repoPath = "/repos/$Owner/$RepoName"
Invoke-GitHubApi -Method "GET" -Path $repoPath | Out-Null

$currentRef = $null
$parentSha = $null
$baseTreeSha = $null
try {
  $currentRef = Invoke-GitHubApi -Method "GET" -Path "$repoPath/git/ref/heads/$Branch"
  $parentSha = $currentRef.object.sha
  $parentCommit = Invoke-GitHubApi -Method "GET" -Path "$repoPath/git/commits/$parentSha"
  $baseTreeSha = $parentCommit.tree.sha
} catch {
  $currentRef = $null
}

$files = git ls-files
if (-not $files) {
  throw "No tracked files found. Commit files before publishing."
}

$treeItems = @()
foreach ($file in $files) {
  $fullPath = Join-Path (Get-Location) $file
  $bytes = [System.IO.File]::ReadAllBytes($fullPath)
  $blob = Invoke-GitHubApi -Method "POST" -Path "$repoPath/git/blobs" -Body @{
    content = [Convert]::ToBase64String($bytes)
    encoding = "base64"
  }

  $treeItems += @{
    path = ($file -replace "\\", "/")
    mode = "100644"
    type = "blob"
    sha = $blob.sha
  }
}

$treeBody = @{ tree = $treeItems }
if ($baseTreeSha) {
  $treeBody.base_tree = $baseTreeSha
}

$tree = Invoke-GitHubApi -Method "POST" -Path "$repoPath/git/trees" -Body $treeBody

$commitBody = @{
  message = $Message
  tree = $tree.sha
  parents = @()
}
if ($parentSha) {
  $commitBody.parents = @($parentSha)
}

$commit = Invoke-GitHubApi -Method "POST" -Path "$repoPath/git/commits" -Body $commitBody

if ($currentRef) {
  Invoke-GitHubApi -Method "PATCH" -Path "$repoPath/git/refs/heads/$Branch" -Body @{
    sha = $commit.sha
    force = $false
  } | Out-Null
} else {
  Invoke-GitHubApi -Method "POST" -Path "$repoPath/git/refs" -Body @{
    ref = "refs/heads/$Branch"
    sha = $commit.sha
  } | Out-Null
}

git remote remove origin 2>$null
git remote add origin "https://github.com/$Owner/$RepoName.git"
git branch --set-upstream-to "origin/$Branch" $Branch 2>$null

Write-Host "Published https://github.com/$Owner/$RepoName"
