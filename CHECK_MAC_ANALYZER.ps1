$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
try {
  pnpm check
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
