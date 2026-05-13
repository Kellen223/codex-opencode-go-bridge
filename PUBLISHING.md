# Publishing

This repository is ready to publish. The local Git repository has already been initialized.

## Option 1: GitHub CLI

Log in:

```powershell
gh auth login
```

Then publish:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\windows\publish-github.ps1
```

To publish as private:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\windows\publish-github.ps1 -Visibility private
```

## Option 2: GitHub website

1. Create a new repository on GitHub named `codex-opencode-go-bridge`.
2. Upload the files from this folder.
3. Or upload the generated archive:

```text
C:\Users\admin\Documents\Codex\codex-opencode-go-bridge.zip
```

## Notes

- Do not upload any API keys.
- The project folder has been scanned for the provided OpenCode Go key pattern.
- The real OpenCode Go key belongs in the Windows user environment variable `OPENCODE_GO_API_KEY`.
