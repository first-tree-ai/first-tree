$ErrorActionPreference = "Stop"

$process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PID"
$record = [ordered]@{
  pid = $PID
  parentPid = [int]$process.ParentProcessId
  startedAt = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString("o")
  clientId = [string]$env:FIRST_TREE_CLIENT_ID
  agentId = [string]$env:FIRST_TREE_AGENT_ID
  chatId = [string]$env:FIRST_TREE_CHAT_ID
  providerMarker = [string]$env:FIRST_TREE_PROVIDER_MARKER
  attributionSource = "child-self-report"
}

$json = $record | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText(
  $env:FTQA_BACKGROUND_RECORD_FILE,
  $json + [Environment]::NewLine,
  (New-Object System.Text.UTF8Encoding($false))
)

[System.Threading.Thread]::Sleep(600000)
