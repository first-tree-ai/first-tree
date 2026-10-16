$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$root = "C:\ftqa"
$state = Join-Path $root "state"
$readyPath = Join-Path $state "windows-job-ready.json"
$controlRequestPath = Join-Path $state "windows-job-control-request.json"
$evidenceDir = `
  $(if ($env:FTQA_EVIDENCE_DIR) { $env:FTQA_EVIDENCE_DIR } else { "C:\ftqa\evidence" })
$supervisorResultPath = Join-Path $evidenceDir "windows-supervisor-result.json"

trap {
  $supervisorError = $_.Exception.ToString()
  $failureEvidence = $evidenceDir
  $failurePath = Join-Path $failureEvidence "windows-result.json"
  $supervisorFailurePath = $supervisorResultPath
  try {
    New-Item -ItemType Directory -Force $failureEvidence | Out-Null
    $priorStatus = $null
    if (Test-Path -LiteralPath $failurePath) {
      try {
        $prior = Get-Content -LiteralPath $failurePath -Raw | ConvertFrom-Json
        $priorStatus = [string]$prior.status
      } catch {
        $priorStatus = "UNREADABLE"
      }
    }
    if ($priorStatus -ne "FAIL") {
      $failure = [ordered]@{
        schema = "first-tree.opencode.windows-cli-e2e.v1"
        status = "FAIL"
        failClosed = $true
        phase = "job-supervisor"
        error = $supervisorError
        priorReceiptStatus = $priorStatus
        finalResidue = [ordered]@{
          runtimeScope = [ordered]@{
            jobPids = $null
            backgroundAlive = $null
            rootAlive = $null
          }
          harnessSupport = $null
        }
      }
      $failureJson = $failure | ConvertTo-Json -Depth 12
      [System.IO.File]::WriteAllText(
        $failurePath,
        $failureJson + [Environment]::NewLine,
        (New-Object System.Text.UTF8Encoding($false))
      )
    }
    $supervisorFailure = [ordered]@{
      schema = "first-tree.opencode.windows-job-supervisor.v1"
      status = "FAIL"
      failClosed = $true
      error = $supervisorError
      priorReceiptStatus = $priorStatus
    }
    $supervisorFailureJson = $supervisorFailure | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText(
      $supervisorFailurePath,
      $supervisorFailureJson + [Environment]::NewLine,
      (New-Object System.Text.UTF8Encoding($false))
    )
  } catch {
    [Console]::Error.WriteLine(
      "Could not persist supervisor failure receipt: $($_.Exception.Message)"
    )
  }
  [Console]::Error.WriteLine($supervisorError)
  exit 1
}

New-Item -ItemType Directory -Force $state | Out-Null
Remove-Item -Force -ErrorAction SilentlyContinue $readyPath, $controlRequestPath
Get-ChildItem -LiteralPath $state -Filter "windows-job-*.json" `
  -ErrorAction SilentlyContinue | Remove-Item -Force

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class FirstTreeJob
{
    private const int JobObjectBasicProcessIdList = 3;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int ERROR_MORE_DATA = 234;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength,
        IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static void Check(bool ok, string operation)
    {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    public static IntPtr CreateKillOnClose()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");

        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            Check(
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    buffer,
                    (uint)size),
                "SetInformationJobObject(KILL_ON_JOB_CLOSE)");
            return job;
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public static void Assign(IntPtr job, IntPtr process)
    {
        Check(AssignProcessToJobObject(job, process), "AssignProcessToJobObject");
    }

    public static long[] ProcessIds(IntPtr job)
    {
        int capacity = 64;
        while (capacity <= 65536)
        {
            int size = 8 + capacity * IntPtr.Size;
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                for (int offset = 0; offset < size; offset += 4)
                    Marshal.WriteInt32(buffer, offset, 0);

                bool ok = QueryInformationJobObject(
                    job,
                    JobObjectBasicProcessIdList,
                    buffer,
                    (uint)size,
                    IntPtr.Zero);
                int error = ok ? 0 : Marshal.GetLastWin32Error();
                int assigned = Marshal.ReadInt32(buffer, 0);
                int listed = Marshal.ReadInt32(buffer, 4);

                if (!ok && error != ERROR_MORE_DATA)
                    throw new Win32Exception(error, "QueryInformationJobObject(ProcessIdList)");
                if (!ok || assigned > capacity)
                {
                    capacity = Math.Max(capacity * 2, assigned + 16);
                    continue;
                }

                long[] result = new long[listed];
                for (int index = 0; index < listed; index++)
                {
                    int offset = 8 + index * IntPtr.Size;
                    result[index] = IntPtr.Size == 8
                        ? Marshal.ReadInt64(buffer, offset)
                        : Marshal.ReadInt32(buffer, offset);
                }
                return result;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        throw new InvalidOperationException("Job process list exceeded the safety bound");
    }

    public static void Terminate(IntPtr job)
    {
        Check(TerminateJobObject(job, 137), "TerminateJobObject");
    }

    public static void Close(IntPtr job)
    {
        if (job != IntPtr.Zero) Check(CloseHandle(job), "CloseHandle(job)");
    }
}
"@

function Write-Utf8Json {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )
  $json = $Value | ConvertTo-Json -Depth 12 -Compress
  [System.IO.File]::WriteAllText(
    $Path,
    $json + [Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($false))
  )
}

function Wait-ForPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][int]$TimeoutMilliseconds,
    [System.Diagnostics.Process]$GuardProcess
  )
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  while (-not (Test-Path -LiteralPath $Path)) {
    if ($GuardProcess -and $GuardProcess.HasExited) {
      throw "Guard process exited before $Path appeared (exit $($GuardProcess.ExitCode))"
    }
    if ([DateTime]::UtcNow -ge $deadline) {
      throw "Timed out waiting for $Path"
    }
    Start-Sleep -Milliseconds 20
  }
}

$job = [IntPtr]::Zero
$driver = $null

try {
  $job = [FirstTreeJob]::CreateKillOnClose()
  Write-Utf8Json -Path $readyPath -Value ([ordered]@{
      killOnJobClose = $true
      authority = "QueryInformationJobObject"
      readyAt = [DateTime]::UtcNow.ToString("o")
    })

  $driverInfo = New-Object System.Diagnostics.ProcessStartInfo
  $driverInfo.FileName = "node.exe"
  $driverInfo.Arguments = "C:\ftqa\windows\windows-harness.mjs"
  $driverInfo.WorkingDirectory = $root
  $driverInfo.UseShellExecute = $false
  $driverInfo.EnvironmentVariables["FTQA_JOB_STATE_DIR"] = $state
  $driverInfo.EnvironmentVariables["FTQA_EVIDENCE_DIR"] = `
    $(if ($env:FTQA_EVIDENCE_DIR) { $env:FTQA_EVIDENCE_DIR } else { "C:\ftqa\evidence" })
  $driver = [System.Diagnostics.Process]::Start($driverInfo)

  $overallDeadline = [DateTime]::UtcNow.AddMinutes(5)
  while (-not $driver.HasExited) {
    if ([DateTime]::UtcNow -ge $overallDeadline) {
      throw "Windows Job Object harness exceeded five minutes"
    }

    $launchRequests = @(Get-ChildItem `
      -LiteralPath $state `
      -Filter "windows-job-launch-request-*.json" `
      -ErrorAction SilentlyContinue)
    foreach ($launchRequestFile in $launchRequests) {
      $launchRequest = $null
      $request = $null
      try {
        $launchRequest = Get-Content -LiteralPath $launchRequestFile.FullName -Raw |
          ConvertFrom-Json
        Remove-Item -LiteralPath $launchRequestFile.FullName -Force

        $wrapperInfo = New-Object System.Diagnostics.ProcessStartInfo
        $wrapperInfo.FileName = "node.exe"
        $wrapperInfo.Arguments = `
          "C:\ftqa\windows\job-launch-wrapper.mjs $($launchRequest.specPath)"
        $wrapperInfo.WorkingDirectory = $root
        $wrapperInfo.UseShellExecute = $false
        $wrapper = [System.Diagnostics.Process]::Start($wrapperInfo)
        [FirstTreeJob]::Assign($job, $wrapper.Handle)

        $launchResponse = [ordered]@{
          seq = [string]$launchRequest.seq
          wrapperPid = $wrapper.Id
          killOnJobClose = $true
          assignedAt = [DateTime]::UtcNow.ToString("o")
        }
      } catch {
        $launchResponse = [ordered]@{
          seq = $(if ($launchRequest) { [string]$launchRequest.seq } else { "unparsed" })
          error = $_.Exception.ToString()
          observedAt = [DateTime]::UtcNow.ToString("o")
        }
      }
      $launchResponsePath = Join-Path `
        $state `
        "windows-job-launch-response-$($launchResponse.seq).json"
      Write-Utf8Json -Path $launchResponsePath -Value $launchResponse
    }

    if (Test-Path -LiteralPath $controlRequestPath) {
      $request = $null
      try {
        $request = Get-Content -LiteralPath $controlRequestPath -Raw | ConvertFrom-Json
        Remove-Item -LiteralPath $controlRequestPath -Force
        if ($request.action -eq "terminate") {
          [FirstTreeJob]::Terminate($job)
          Start-Sleep -Milliseconds 20
        } elseif ($request.action -ne "snapshot") {
          throw "Unknown job request action: $($request.action)"
        }
        $response = [ordered]@{
          seq = [string]$request.seq
          action = [string]$request.action
          pids = @([FirstTreeJob]::ProcessIds($job))
          observedAt = [DateTime]::UtcNow.ToString("o")
        }
      } catch {
        $response = [ordered]@{
          seq = $(if ($request) { [string]$request.seq } else { "unparsed" })
          error = $_.Exception.ToString()
          observedAt = [DateTime]::UtcNow.ToString("o")
        }
      }
      $responsePath = Join-Path $state "windows-job-response-$($response.seq).json"
      Write-Utf8Json -Path $responsePath -Value $response
    }
    Start-Sleep -Milliseconds 20
  }

  $driver.WaitForExit()
  if ($driver.ExitCode -ne 0) {
    throw "Windows driver exited with code $($driver.ExitCode)"
  }
} finally {
  if ($job -ne [IntPtr]::Zero) {
    try {
      if ([FirstTreeJob]::ProcessIds($job).Count -gt 0) {
        [FirstTreeJob]::Terminate($job)
      }
    } finally {
      [FirstTreeJob]::Close($job)
    }
  }
  if ($driver -and -not $driver.HasExited) {
    $driver.Kill()
    $driver.WaitForExit()
  }
  Remove-Item -Force -ErrorAction SilentlyContinue $readyPath
}

New-Item -ItemType Directory -Force $evidenceDir | Out-Null
$mainResultPath = Join-Path $evidenceDir "windows-result.json"
if (-not (Test-Path -LiteralPath $mainResultPath)) {
  throw "Driver exited successfully without windows-result.json"
}
$mainResult = Get-Content -LiteralPath $mainResultPath -Raw | ConvertFrom-Json
if ([string]$mainResult.status -ne "PASS") {
  throw "Driver exited successfully but main receipt was not PASS"
}
Write-Utf8Json -Path $supervisorResultPath -Value ([ordered]@{
    schema = "first-tree.opencode.windows-job-supervisor.v1"
    status = "PASS"
    failClosed = $true
    driverExitCode = $driver.ExitCode
    mainReceiptStatus = [string]$mainResult.status
    jobClosed = $true
    observedAt = [DateTime]::UtcNow.ToString("o")
  })
