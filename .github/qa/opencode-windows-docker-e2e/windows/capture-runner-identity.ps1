param(
  [Parameter(Mandatory = $true)][string]$EvidenceDir
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$windowsBase = "mcr.microsoft.com/windows/servercore:ltsc2022@sha256:b841bb042e13a079f68fc82461f15abcefe8063fb9a3072120348252f13a6ce3"
$resolvedEvidence = (New-Item -ItemType Directory -Force $EvidenceDir).FullName
$hostOperatingSystem = Get-CimInstance Win32_OperatingSystem

$dockerVersionText = (& docker version --format "{{json .}}" | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "docker version failed"
}
$dockerVersion = $dockerVersionText | ConvertFrom-Json
$dockerInfoText = (& docker info --format "{{json .}}" | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "docker info failed"
}
$dockerInfo = $dockerInfoText | ConvertFrom-Json
$manifestText = (& docker manifest inspect $windowsBase | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "pinned Windows base manifest inspection failed"
}
$manifest = $manifestText | ConvertFrom-Json

$identity = [ordered]@{
  schema = "first-tree.opencode.windows-actions-runner-identity.v1"
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
  pinnedBase = [ordered]@{
    reference = $windowsBase
    manifestDigest = "sha256:b841bb042e13a079f68fc82461f15abcefe8063fb9a3072120348252f13a6ce3"
    mediaType = [string]$manifest.mediaType
    platforms = @(
      $manifest.manifests | ForEach-Object {
        [ordered]@{
          digest = [string]$_.digest
          architecture = [string]$_.platform.architecture
          os = [string]$_.platform.os
          osVersion = [string]$_.platform.'os.version'
        }
      }
    )
  }
}
$path = Join-Path $resolvedEvidence "windows-actions-runner-identity.json"
[System.IO.File]::WriteAllText(
  $path,
  (($identity | ConvertTo-Json -Depth 20) + [Environment]::NewLine),
  (New-Object System.Text.UTF8Encoding($false))
)
