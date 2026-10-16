param(
  [Parameter(Mandatory = $true)][string]$EvidenceDir,
  [Parameter(Mandatory = $true)][string]$OutputDir
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Utf8 {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Value
  )
  [System.IO.File]::WriteAllText(
    $Path,
    $Value,
    (New-Object System.Text.UTF8Encoding($false))
  )
}

New-Item -ItemType Directory -Force $OutputDir | Out-Null

$receiptNames = @(
  "windows-result.json",
  "windows-supervisor-result.json",
  "windows-runner-identity.json",
  "windows-actions-runner-identity.json",
  "windows-cleanup-result.json",
  "windows-actions-cleanup-result.json"
)
foreach ($name in $receiptNames) {
  $source = Join-Path $EvidenceDir $name
  if (Test-Path -LiteralPath $source) {
    $parsed = Get-Content -LiteralPath $source -Raw | ConvertFrom-Json
    $json = $parsed | ConvertTo-Json -Depth 30
    Write-Utf8 `
      -Path (Join-Path $OutputDir $name) `
      -Value ($json + [Environment]::NewLine)
  }
}

$providerLog = Join-Path $EvidenceDir "windows-provider.jsonl"
if (Test-Path -LiteralPath $providerLog) {
  $redactedLines = @()
  foreach ($line in Get-Content -LiteralPath $providerLog) {
    if ([string]::IsNullOrWhiteSpace($line)) {
      continue
    }
    $record = $line | ConvertFrom-Json
    if ($record.PSObject.Properties.Name -contains "body") {
      $record.PSObject.Properties.Remove("body")
    }
    $redactedLines += ($record | ConvertTo-Json -Depth 20 -Compress)
  }
  Write-Utf8 `
    -Path (Join-Path $OutputDir "windows-provider.redacted.jsonl") `
    -Value (($redactedLines -join [Environment]::NewLine) + [Environment]::NewLine)
}

$manifest = [ordered]@{
  schema = "first-tree.opencode.windows-evidence-manifest.v1"
  generatedAt = [DateTime]::UtcNow.ToString("o")
  files = @(
    Get-ChildItem -LiteralPath $OutputDir -File |
      Select-Object -ExpandProperty Name |
      Sort-Object
  )
  providerRequestBodiesRemoved = $true
  rawEvidenceUploaded = $false
}
Write-Utf8 `
  -Path (Join-Path $OutputDir "evidence-manifest.json") `
  -Value (($manifest | ConvertTo-Json -Depth 10) + [Environment]::NewLine)
