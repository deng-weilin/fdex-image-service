$ErrorActionPreference = "Continue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot "runtime"
$stdoutLog = Join-Path $runtimeDir "server.out.log"
$stderrLog = Join-Path $runtimeDir "server.err.log"
$supervisorLog = Join-Path $runtimeDir "supervisor.log"
$serverPath = Join-Path $projectRoot "server.js"

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
$nodeExe = $nodeCommand.Source

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

if (-not $nodeExe) {
  "[$(Get-Date -Format o)] Node executable not found." | Out-File -FilePath $supervisorLog -Append -Encoding utf8
  exit 1
}

$mutex = [System.Threading.Mutex]::new($false, "Local\FDEXImageServiceSupervisor")
if (-not $mutex.WaitOne(0)) {
  exit 0
}

try {
  Set-Location -LiteralPath $projectRoot
  "[$(Get-Date -Format o)] Supervisor started." | Out-File -FilePath $supervisorLog -Append -Encoding utf8

  while ($true) {
    "[$(Get-Date -Format o)] Starting service." | Out-File -FilePath $stdoutLog -Append -Encoding utf8
    & $nodeExe $serverPath 1>> $stdoutLog 2>> $stderrLog
    $exitCode = $LASTEXITCODE
    "[$(Get-Date -Format o)] Service exited with code $exitCode; restarting in 3 seconds." |
      Out-File -FilePath $supervisorLog -Append -Encoding utf8
    Start-Sleep -Seconds 3
  }
}
finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
