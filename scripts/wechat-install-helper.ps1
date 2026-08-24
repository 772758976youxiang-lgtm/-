param([Parameter(Mandatory = $true)][string]$OperationPath)

$ErrorActionPreference = 'Stop'
$ExpectedVersion = '4.1.10.27'
$ExpectedSize = 239441904
$ExpectedSha256 = '54203fc2b41983fa106b0af0d67f86befc56ccd3dc1005d4bab6de8ea36b4f74'
$ExpectedSigner = 'Tencent Technology (Shenzhen) Company Limited'
$operation = $null
$resultPath = $null
$secureDirectory = $null

function Write-Result([bool]$Ok, [string]$Code, [string]$Message, $Extra = @{}) {
  $result = [ordered]@{ ok = $Ok; code = $Code; message = $Message }
  foreach ($key in $Extra.Keys) { $result[$key] = $Extra[$key] }
  $json = $result | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($resultPath, $json, [Text.UTF8Encoding]::new($false))
}

function Get-ExecutableFromValue([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $expanded = [Environment]::ExpandEnvironmentVariables($Value.Trim())
  if ($expanded.StartsWith('"')) {
    $end = $expanded.IndexOf('"', 1)
    if ($end -gt 1) { return $expanded.Substring(1, $end - 1) }
  }
  $match = [regex]::Match($expanded, '^(.*?\.exe)(?:\s|,|$)', 'IgnoreCase')
  if ($match.Success) { return $match.Groups[1].Value.Trim('"') }
  return $expanded.Trim('"')
}

function Find-InstalledWeixin {
  $candidates = [Collections.Generic.List[string]]::new()
  $views = @([Microsoft.Win32.RegistryView]::Registry32)
  if ([Environment]::Is64BitOperatingSystem) { $views += [Microsoft.Win32.RegistryView]::Registry64 }
  foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach ($view in $views) {
      $base = $null; $uninstall = $null
      try {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
        $uninstall = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
        if (-not $uninstall) { continue }
        foreach ($name in $uninstall.GetSubKeyNames()) {
          $key = $null
          try {
            $key = $uninstall.OpenSubKey($name)
            if (-not $key) { continue }
            $displayName = [string]$key.GetValue('DisplayName')
            if ($displayName -notmatch '微信|Weixin') { continue }
            $location = [Environment]::ExpandEnvironmentVariables([string]$key.GetValue('InstallLocation'))
            if ($location) { $candidates.Add((Join-Path $location.Trim('"') 'Weixin.exe')) }
            $icon = Get-ExecutableFromValue ([string]$key.GetValue('DisplayIcon'))
            if ($icon) { $candidates.Add($icon) }
          } finally { if ($key) { $key.Dispose() } }
        }
      } finally {
        if ($uninstall) { $uninstall.Dispose() }
        if ($base) { $base.Dispose() }
      }
    }
  }
  Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.ExecutablePath) { $candidates.Add([string]$_.ExecutablePath) }
  }
  foreach ($candidate in $candidates | Select-Object -Unique) {
    if ([IO.Path]::GetFileName($candidate) -ine 'Weixin.exe' -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $item = Get-Item -LiteralPath $candidate
    if ([string]$item.VersionInfo.FileVersion -eq $ExpectedVersion) {
      return [pscustomobject]@{ executable = $item.FullName; installRoot = $item.Directory.FullName; version = $ExpectedVersion }
    }
  }
  return $null
}

function Test-PathInside([string]$Child, [string]$Root) {
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $childFull = [IO.Path]::GetFullPath($Child)
  return $childFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)
}

function Test-ExcludedProductPath([string]$Value) {
  $normalized = ([IO.Path]::GetFullPath($Value).Replace('/', '\') + '\').ToLowerInvariant()
  return $normalized.Contains('\wxwork\') -or $normalized.Contains('\wecom\') -or $normalized.Contains('\wechat\')
}

function Test-ReparseInPath([string]$Value) {
  $currentPath = [IO.Path]::GetFullPath($Value)
  while (-not [string]::IsNullOrWhiteSpace($currentPath)) {
    $current = Get-Item -LiteralPath $currentPath -Force
    if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $true }
    $parent = [IO.Directory]::GetParent($currentPath)
    if (-not $parent) { break }
    $currentPath = $parent.FullName
  }
  return $false
}

function Test-UnsafeReparsePath([string]$Child, [string]$Root) {
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $currentPath = [IO.Path]::GetFullPath($Child)
  while (-not $currentPath.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    $current = Get-Item -LiteralPath $currentPath -Force
    if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $true }
    $currentPath = Split-Path -Parent $currentPath
    if ([string]::IsNullOrWhiteSpace($currentPath)) { throw 'UPDATE_PATH_OUTSIDE_INSTALL_ROOT' }
  }
  return $false
}

try {
  $operationFullPath = [IO.Path]::GetFullPath($OperationPath)
  $operation = Get-Content -LiteralPath $operationFullPath -Raw | ConvertFrom-Json
  $resultPath = Join-Path (Split-Path -Parent $operationFullPath) 'result.json'
  $sourceInstaller = [IO.Path]::GetFullPath([string]$operation.installer)
  if (-not (Test-Path -LiteralPath $sourceInstaller -PathType Leaf)) { throw 'Installer file is missing' }

  $secureDirectory = Join-Path $env:ProgramData (Join-Path 'DeepSeekHarness\wechat-installer' ([guid]::NewGuid().ToString('N')))
  New-Item -ItemType Directory -Path $secureDirectory -Force | Out-Null
  $secureInstaller = Join-Path $secureDirectory 'weixin_4.1.10.27.exe'
  Copy-Item -LiteralPath $sourceInstaller -Destination $secureInstaller -Force

  $item = Get-Item -LiteralPath $secureInstaller
  if ($item.Length -ne $ExpectedSize) { throw 'INSTALLER_SIZE_MISMATCH' }
  $hash = (Get-FileHash -LiteralPath $secureInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $ExpectedSha256) { throw 'INSTALLER_HASH_MISMATCH' }
  $signature = Get-AuthenticodeSignature -LiteralPath $secureInstaller
  $organizationPattern = '(?:^|,\s*)O\s*=\s*"?' + [regex]::Escape($ExpectedSigner) + '"?(?:\s*,|$)'
  if ($signature.Status -ne 'Valid' -or [string]$signature.SignerCertificate.Subject -notmatch $organizationPattern) {
    throw 'INSTALLER_SIGNATURE_INVALID'
  }

  Get-Process -Name 'Weixin', 'WeixinUpdate' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction Stop
  $installerProcess = Start-Process -FilePath $secureInstaller -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
  if ($installerProcess.ExitCode -ne 0) { throw "INSTALLER_EXIT_$($installerProcess.ExitCode)" }

  $installed = Find-InstalledWeixin
  if (-not $installed -or $installed.version -ne $ExpectedVersion) { throw 'POST_INSTALL_VERSION_MISMATCH' }
  $root = [IO.Path]::GetFullPath($installed.installRoot)
  if (Test-ExcludedProductPath $root) { throw 'UPDATE_PATH_EXCLUDED_PRODUCT' }
  if (Test-ReparseInPath $root) { throw 'UPDATE_PATH_UNSAFE' }
  $updaterFiles = @(Get-ChildItem -LiteralPath $root -Filter 'WeixinUpdate.exe' -File -Recurse -ErrorAction SilentlyContinue)

  $updaterRecords = @()
  $safeUpdaterPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($updater in $updaterFiles) {
    if (-not (Test-PathInside $updater.FullName $root)) { throw 'UPDATE_PATH_OUTSIDE_INSTALL_ROOT' }
    if (Test-ExcludedProductPath $updater.FullName) { continue }
    if (Test-UnsafeReparsePath $updater.FullName $root) { throw 'UPDATE_PATH_UNSAFE' }
    $original = $updater.FullName
    $backup = "$original.dsh-disabled"
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
    Move-Item -LiteralPath $original -Destination $backup -Force
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $pathHash = (($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($original)) | ForEach-Object { $_.ToString('x2') }) -join '') }
    finally { $sha.Dispose() }
    $ruleName = "DeepSeek Harness - Block Weixin updater - $pathHash"
    if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName $ruleName -Direction Outbound -Action Block -Program $original -Profile Any | Out-Null
    }
    $updaterRecords += [ordered]@{ original = $original; backup = $backup; firewallRule = $ruleName }
    $null = $safeUpdaterPaths.Add([IO.Path]::GetFullPath($original))
  }
  if ($updaterRecords.Count -eq 0) { throw 'UPDATE_SUPPRESSION_FAILED' }

  $disabledTasks = @()
  Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object {
    $task = $_
    foreach ($action in @($task.Actions)) {
      $execute = Get-ExecutableFromValue ([string]$action.Execute)
      if ($execute -and [IO.Path]::GetFileName($execute) -ieq 'WeixinUpdate.exe' -and $safeUpdaterPaths.Contains([IO.Path]::GetFullPath($execute))) {
        Disable-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop | Out-Null
        $disabledTasks += "$($task.TaskPath)$($task.TaskName)"
        break
      }
    }
  }

  $disabledServices = @()
  Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | ForEach-Object {
    $servicePath = Get-ExecutableFromValue ([string]$_.PathName)
    if ($servicePath -and [IO.Path]::GetFileName($servicePath) -ieq 'WeixinUpdate.exe' -and $safeUpdaterPaths.Contains([IO.Path]::GetFullPath($servicePath))) {
      Stop-Service -Name $_.Name -Force -ErrorAction SilentlyContinue
      Set-Service -Name $_.Name -StartupType Disabled -ErrorAction Stop
      $disabledServices += $_.Name
    }
  }

  foreach ($record in $updaterRecords) {
    if ((Test-Path -LiteralPath $record.original) -or -not (Test-Path -LiteralPath $record.backup -PathType Leaf)) { throw 'UPDATE_SUPPRESSION_FAILED' }
    if (-not (Get-NetFirewallRule -DisplayName $record.firewallRule -ErrorAction SilentlyContinue)) { throw 'UPDATE_SUPPRESSION_FAILED' }
  }

  $state = [ordered]@{
    version = $ExpectedVersion
    executable = $installed.executable
    installRoot = $root
    updaters = $updaterRecords
    disabledTasks = $disabledTasks
    disabledServices = $disabledServices
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
  $statePath = Join-Path $env:USERPROFILE '.dsh\wechat-install-state.json'
  $stateDirectory = Split-Path -Parent $statePath
  New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
  [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  Write-Result $true 'READY' '微信 4.1.10.27 已安装，自动更新已关闭' @{ version = $ExpectedVersion; executable = $installed.executable; installRoot = $root; updateSuppressed = $true }
  exit 0
} catch {
  $code = [string]$_.Exception.Message
  if ($code -notmatch '^[A-Z][A-Z0-9_]+$') { $code = 'INSTALL_FAILED' }
  if ($resultPath) { Write-Result $false $code '微信安装或自动更新关闭失败' }
  [Console]::Error.WriteLine("$code`: $($_.Exception.Message)")
  exit 1
} finally {
  if ($secureDirectory -and (Test-Path -LiteralPath $secureDirectory)) {
    Remove-Item -LiteralPath $secureDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}
