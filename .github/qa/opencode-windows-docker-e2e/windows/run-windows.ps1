param(
  [string]$EvidenceDir = "C:\ftqa-evidence",
  [string]$ProjectName = "ftqa-opencode-windows-218a",
  [ValidateSet("process", "hyperv")]
  [string]$Isolation = "process"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$harnessRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $harnessRoot "compose.windows.yaml"
$resolvedEvidence = (New-Item -ItemType Directory -Force $EvidenceDir).FullName
$identityPath = Join-Path $resolvedEvidence "windows-runner-identity.json"
$cleanupPath = Join-Path $resolvedEvidence "windows-cleanup-result.json"
$windowsBase = "mcr.microsoft.com/windows/servercore:ltsc2022@sha256:b841bb042e13a079f68fc82461f15abcefe8063fb9a3072120348252f13a6ce3"
$env:FTQA_EVIDENCE_DIR = $resolvedEvidence
$env:FTQA_WINDOWS_ISOLATION = $Isolation

function Write-Utf8Json {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )
  $json = $Value | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText(
    $Path,
    $json + [Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($false))
  )
}

function Invoke-DockerJson {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Description
  )
  $output = & docker @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed"
  }
  return ($output | Out-String).Trim() | ConvertFrom-Json
}

$osType = (& docker info --format "{{.OSType}}").Trim()
if ($LASTEXITCODE -ne 0) {
  throw "docker info failed"
}
if ($osType -ne "windows") {
  throw "Windows Docker engine required; docker reported '$osType'"
}

$serviceImageReferences = @(
  @(
    & docker compose `
      -p $ProjectName `
      -f $composeFile `
      config `
      --images
  ) | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Sort-Object -Unique
)
if ($LASTEXITCODE -ne 0 -or $serviceImageReferences.Count -ne 1) {
  throw "Expected exactly one Compose service image reference"
}
$serviceImageReference = [string]$serviceImageReferences[0]

$hostOperatingSystem = Get-CimInstance Win32_OperatingSystem
$dockerVersion = Invoke-DockerJson `
  -Arguments @("version", "--format", "{{json .}}") `
  -Description "docker version"
$dockerInfo = Invoke-DockerJson `
  -Arguments @("info", "--format", "{{json .}}") `
  -Description "docker info"
$baseImageIDBefore = $null
$baseInspect = & docker image inspect $windowsBase --format "{{.Id}}" 2>$null
if ($LASTEXITCODE -eq 0) {
  $baseImageIDBefore = ($baseInspect | Out-String).Trim()
}
$identity = [ordered]@{
  schema = "first-tree.opencode.windows-runner-identity.v1"
  capturedAt = [DateTime]::UtcNow.ToString("o")
  githubRunnerImage = [ordered]@{
    imageOS = $env:ImageOS
    imageVersion = $env:ImageVersion
  }
  host = [ordered]@{
    frameworkOSVersion = [Environment]::OSVersion.VersionString
    caption = [string]$hostOperatingSystem.Caption
    version = [string]$hostOperatingSystem.Version
    buildNumber = [string]$hostOperatingSystem.BuildNumber
  }
  docker = [ordered]@{
    client = $dockerVersion.Client
    server = $dockerVersion.Server
    osType = [string]$dockerInfo.OSType
    isolation = [string]$dockerInfo.Isolation
    serverVersion = [string]$dockerInfo.ServerVersion
    operatingSystem = [string]$dockerInfo.OperatingSystem
    kernelVersion = [string]$dockerInfo.KernelVersion
  }
  build = [ordered]@{
    baseReference = $windowsBase
    baseManifestDigest = "sha256:b841bb042e13a079f68fc82461f15abcefe8063fb9a3072120348252f13a6ce3"
    baseImageIDBefore = $baseImageIDBefore
    serviceImageReference = $serviceImageReference
    serviceImageID = $null
  }
}
Write-Utf8Json -Path $identityPath -Value $identity

$serviceImageID = $null
$runFailure = $null
$cleanupFailure = $null
try {
  try {
    & docker compose `
      -p $ProjectName `
      -f $composeFile `
      build `
      windows-job
    if ($LASTEXITCODE -ne 0) {
      throw "Windows harness image build failed"
    }

    $serviceImageID = (
      & docker image inspect `
        $serviceImageReference `
        --format "{{.Id}}" |
          Out-String
    ).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($serviceImageID)) {
      throw "Could not resolve the built Windows harness service image"
    }
    $identity.build.serviceImageID = $serviceImageID
    Write-Utf8Json -Path $identityPath -Value $identity

    & docker compose `
      -p $ProjectName `
      -f $composeFile `
      run `
      --rm `
      windows-job
    if ($LASTEXITCODE -ne 0) {
      throw "Windows harness execution failed; inspect $resolvedEvidence"
    }
  } catch {
    $runFailure = $_.Exception.ToString()
  }
} finally {
  & docker compose `
    -p $ProjectName `
    -f $composeFile `
    down `
    --remove-orphans `
    --rmi local
  $downExitCode = $LASTEXITCODE

  $containerResidue = @(& docker ps `
    -aq `
    --filter "label=com.docker.compose.project=$ProjectName")
  $containerReadExit = $LASTEXITCODE
  $networkResidue = @(& docker network ls `
    -q `
    --filter "label=com.docker.compose.project=$ProjectName")
  $networkReadExit = $LASTEXITCODE

  $serviceImageIDAlive = $false
  if (-not [string]::IsNullOrWhiteSpace($serviceImageID)) {
    & docker image inspect $serviceImageID *> $null
    $serviceImageIDAlive = $LASTEXITCODE -eq 0
  }
  & docker image inspect $serviceImageReference *> $null
  $serviceImageReferenceAlive = $LASTEXITCODE -eq 0

  $baseImageIDAfter = $null
  $baseInspectAfter = & docker image inspect $windowsBase --format "{{.Id}}" 2>$null
  if ($LASTEXITCODE -eq 0) {
    $baseImageIDAfter = ($baseInspectAfter | Out-String).Trim()
  }
  $baseCachePreserved = `
    [string]::IsNullOrWhiteSpace($baseImageIDBefore) -or `
    $baseImageIDAfter -eq $baseImageIDBefore
  $cleanupPassed = `
    $downExitCode -eq 0 -and `
    $containerReadExit -eq 0 -and `
    $networkReadExit -eq 0 -and `
    @($containerResidue | Where-Object { $_ }).Count -eq 0 -and `
    @($networkResidue | Where-Object { $_ }).Count -eq 0 -and `
    -not $serviceImageIDAlive -and `
    -not $serviceImageReferenceAlive -and `
    $baseCachePreserved
  $cleanup = [ordered]@{
    schema = "first-tree.opencode.windows-docker-cleanup.v1"
    status = $(if ($cleanupPassed) { "PASS" } else { "FAIL" })
    completedAt = [DateTime]::UtcNow.ToString("o")
    projectName = $ProjectName
    downExitCode = $downExitCode
    containers = @($containerResidue | Where-Object { $_ })
    networks = @($networkResidue | Where-Object { $_ })
    serviceImageReference = $serviceImageReference
    serviceImageID = $serviceImageID
    serviceImageIDAlive = $serviceImageIDAlive
    serviceImageReferenceAlive = $serviceImageReferenceAlive
    baseImageIDBefore = $baseImageIDBefore
    baseImageIDAfter = $baseImageIDAfter
    baseCachePreserved = $baseCachePreserved
  }
  Write-Utf8Json -Path $cleanupPath -Value $cleanup
  if (-not $cleanupPassed) {
    $cleanupFailure = "Scoped Docker cleanup or readback failed"
  }
}

if ($runFailure) {
  throw $runFailure
}
if ($cleanupFailure) {
  throw $cleanupFailure
}
