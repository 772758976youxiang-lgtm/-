param(
  [Parameter(Mandatory = $true)][string]$HelperPath,
  [Parameter(Mandatory = $true)][string]$OperationPath
)

$ErrorActionPreference = 'Stop'

function Quote-Argument([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

try {
  $arguments = @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', (Quote-Argument $HelperPath),
    '-OperationPath', (Quote-Argument $OperationPath)
  )
  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  exit $process.ExitCode
} catch {
  [Console]::Error.WriteLine("UAC_CANCELLED: $($_.Exception.Message)")
  exit 1223
}
