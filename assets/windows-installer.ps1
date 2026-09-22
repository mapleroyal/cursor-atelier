param(
  [Parameter(Mandatory=$true)][string]$InstallDirectory,
  [ValidateSet('Prepare','Complete','Rollback','Uninstall')][string]$Mode = 'Complete',
  [Parameter(Mandatory=$true)][string]$StateFile,
  [string]$InstallerKey,
  [string]$UninstallKey
)
$ErrorActionPreference = 'Stop'
$applicationId = 'com.cursoratelier.CursorAtelier'
$runKey = 'Software\Microsoft\Windows\CurrentVersion\Run'
$approvalKey = 'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
$ownedValueKeys = @($runKey, $approvalKey)
$oldRoot = Join-Path $env:LOCALAPPDATA 'cursor_atelier'
$executable = Join-Path $InstallDirectory 'cursor-atelier.exe'

function Read-Identity([string]$directory) {
  $info = Get-Content -LiteralPath (Join-Path $directory 'resources\build-info.json') -Raw | ConvertFrom-Json
  if ($info.applicationId -ne $applicationId -or $info.platform -ne 'win32' -or $info.buildVersion -notmatch '^\d+$') {
    throw "Unrecognized Cursor Atelier installation: $directory"
  }
  return $info
}
function Get-OldProcesses([string]$directory) {
  $prefix = [IO.Path]::GetFullPath($directory).TrimEnd('\') + '\'
  return @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  })
}
function Stop-OldProcesses([string]$directory) {
  $processes = @(Get-OldProcesses $directory)
  if (-not $processes.Count) { return }
  foreach ($process in $processes) {
    $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
    if ($owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) {
      throw 'The earlier installation has a process owned by another user.'
    }
  }
  $mains = @($processes | Where-Object { $_.ExecutablePath -like '*\cursor-atelier.exe' -and $_.CommandLine -notmatch '(?:^|\s)--type=' })
  foreach ($main in $mains) {
    Start-Process -FilePath $main.ExecutablePath -ArgumentList '--quit-for-update' | Out-Null
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (@(Get-OldProcesses $directory).Count) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Cursor Atelier is still busy. Quit it and run Setup again; the earlier installation has been retained.' }
    Start-Sleep -Milliseconds 200
  }
}
function Write-State($state) {
  [IO.File]::WriteAllText($StateFile, ($state | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
}
function Read-Registrations {
  $paths = @($InstallerKey, $UninstallKey, $runKey, $approvalKey)
  return @(foreach ($path in $paths) {
    if (-not $path) { continue }
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path)
    try {
      $values = @(if ($key) {
        foreach ($name in $key.GetValueNames()) {
          if ($ownedValueKeys -contains $path -and $name -ne $applicationId) { continue }
          $kind = $key.GetValueKind($name).ToString()
          $value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
          if ($kind -eq 'Binary') { $value = [Convert]::ToBase64String($value) }
          @{ name = $name; kind = $kind; value = $value }
        }
      })
      @{ path = $path; exists = [bool]$key; values = $values }
    } finally { if ($key) { $key.Close() } }
  })
}
function Restore-Registrations($records) {
  foreach ($record in $records) {
    if ($ownedValueKeys -notcontains $record.path) {
      [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($record.path, $false)
    }
    if (-not $record.exists -and $ownedValueKeys -contains $record.path) {
      $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($record.path, $true)
      if ($key) { try { $key.DeleteValue($applicationId, $false) } finally { $key.Close() } }
    }
    if ($record.exists) {
      $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($record.path)
      try {
        if ($ownedValueKeys -contains $record.path) { $key.DeleteValue($applicationId, $false) }
        foreach ($item in $record.values) {
          $value = $item.value
          if ($item.kind -eq 'Binary') { $value = [Convert]::FromBase64String($value) }
          $key.SetValue($item.name, $value, [Enum]::Parse([Microsoft.Win32.RegistryValueKind], $item.kind))
        }
      } finally { $key.Close() }
    }
  }
}
try {
  if ($Mode -eq 'Uninstall') {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($runKey, $true)
    try {
      $value = if ($key) { $key.GetValue($applicationId) } else { $null }
      if (-not $value -or $value -ieq ('"' + $executable + '" --background')) {
        if ($key) { $key.DeleteValue($applicationId, $false) }
        $approval = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run', $true)
        if ($approval) { try { $approval.DeleteValue($applicationId, $false) } finally { $approval.Close() } }
      }
    } finally { if ($key) { $key.Close() } }
    exit 0
  }
  if ($Mode -eq 'Prepare') {
    $state = @{ backup = $null; running = $false; registrations = @(Read-Registrations); complete = $false; rolledBack = $false; prepared = $false; squirrelExecutable = $null }
    $shortcutPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Cursor Atelier.lnk'
    $state.shortcut = if (Test-Path -LiteralPath $shortcutPath) { [Convert]::ToBase64String([IO.File]::ReadAllBytes($shortcutPath)) } else { $null }
    Write-State $state
    if (Test-Path -LiteralPath $InstallDirectory) {
      $previous = Read-Identity $InstallDirectory
      if ((Get-Item -LiteralPath $InstallDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The previous installation is unexpectedly linked.' }
      $state.running = @(Get-OldProcesses $InstallDirectory).Count -gt 0
      Write-State $state
      Stop-OldProcesses $InstallDirectory
      $state.backup = $InstallDirectory + '.previous-' + $previous.buildVersion + '-' + [Guid]::NewGuid()
      Copy-Item -LiteralPath $InstallDirectory -Destination $state.backup -Recurse
    }
    $state.prepared = $true
    Write-State $state
    # The old one-off installer remains intact until the new renderer passes.
    if (Test-Path -LiteralPath (Join-Path $oldRoot 'Update.exe')) {
      $oldMain = @(Get-OldProcesses $oldRoot | Where-Object { $_.ExecutablePath -like '*\cursor-atelier.exe' -and $_.CommandLine -notmatch '(?:^|\s)--type=' }) | Select-Object -First 1
      if ($oldMain) { $state.squirrelExecutable = $oldMain.ExecutablePath; Write-State $state }
      Stop-OldProcesses $oldRoot
    }
    Write-Output 'Previous installation preserved.'
    exit 0
  }
  if ($Mode -eq 'Rollback') {
    if (-not (Test-Path -LiteralPath $StateFile)) { exit 0 }
    $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    if ($state.complete -or $state.rolledBack) { exit 0 }
    if (-not $state.prepared) {
      if ($state.running) { Start-Process -FilePath $executable | Out-Null }
      exit 0
    }
    Stop-OldProcesses $InstallDirectory
    if (Test-Path -LiteralPath $InstallDirectory) {
      $failed = $InstallDirectory + '.failed-setup-' + [Guid]::NewGuid()
      Move-Item -LiteralPath $InstallDirectory -Destination $failed
    }
    if ($state.backup -and (Test-Path -LiteralPath $state.backup)) {
      Move-Item -LiteralPath $state.backup -Destination $InstallDirectory
    }
    Restore-Registrations $state.registrations
    $shortcutPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Cursor Atelier.lnk'
    if ($state.shortcut) { [IO.File]::WriteAllBytes($shortcutPath, [Convert]::FromBase64String($state.shortcut)) }
    elseif (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath }
    if ($state.running) { Start-Process -FilePath $executable | Out-Null }
    if ($state.squirrelExecutable -and (Test-Path -LiteralPath $state.squirrelExecutable)) { Start-Process -FilePath $state.squirrelExecutable | Out-Null }
    $state.rolledBack = $true
    Write-State $state
    Write-Output 'Previous installation restored.'
    exit 0
  }
  $identity = Read-Identity $InstallDirectory
  $manifestPath = Join-Path $InstallDirectory 'resources\install-manifest.json'
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  foreach ($entry in $manifest.PSObject.Properties) {
    $file = Join-Path $InstallDirectory $entry.Name
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value.sha256) {
      throw "Installed file verification failed: $($entry.Name)"
    }
  }

  # Check the new renderer with isolated state before retiring the one-off build.
  $temporary = Join-Path ([IO.Path]::GetTempPath()) ('cursor-atelier-setup-check-' + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $temporary | Out-Null
  $resultPath = Join-Path $temporary 'result.json'
  $env:CURSOR_ATELIER_USER_DATA = Join-Path $temporary 'data'
  $env:CURSOR_ATELIER_DISABLE_LOGIN_ITEM_REGISTRATION = '1'
  $inspection = Start-Process -FilePath $executable -ArgumentList ('"--installation-check=' + $resultPath + '"') -PassThru
  try {
    if (-not $inspection.WaitForExit(60000)) { $inspection.Kill(); throw 'The installed app did not finish its startup check.' }
    if ($inspection.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $resultPath)) { throw 'The installed app failed its startup check.' }
    $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    if ($result.buildVersion -ne $identity.buildVersion -or -not $result.rendererReady -or $result.executablePath -ine $executable) {
      throw 'The installed app did not confirm its build and renderer.'
    }
  } finally {
    Remove-Item Env:CURSOR_ATELIER_USER_DATA -ErrorAction SilentlyContinue
    Remove-Item Env:CURSOR_ATELIER_DISABLE_LOGIN_ITEM_REGISTRATION -ErrorAction SilentlyContinue
    if ($inspection.HasExited) { Remove-Item -LiteralPath $temporary -Recurse -Force }
  }


  # Ensure the new shortcut is ready before committing installation.
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Cursor Atelier.lnk'))
  $shortcut.TargetPath = $executable
  $shortcut.WorkingDirectory = $InstallDirectory
  $shortcut.IconLocation = $executable + ',0'
  $shortcut.Save()

  # Record NSIS-generated files so developer updates retain installer ownership.
  foreach ($filename in @('Uninstall cursor-atelier.exe', 'uninstallerIcon.ico')) {
    $file = Join-Path $InstallDirectory $filename
    if (Test-Path -LiteralPath $file) {
      $manifest | Add-Member -MemberType NoteProperty -Name $filename -Value @{
        sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
      } -Force
    }
  }
  [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
  $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
  $state.complete = $true
  Write-State $state
  Write-Output 'Installed app and renderer verified.'
  if ($state.backup) { Write-Output ('Recoverable previous installation: ' + $state.backup) }
  # Commit before retiring Squirrel: cleanup failure must keep the verified app.
  try {
  if ((Test-Path -LiteralPath (Join-Path $oldRoot 'Update.exe')) -and -not (Test-Path -LiteralPath (Join-Path $oldRoot '.dead'))) {
    if ((Get-Item -LiteralPath $oldRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw 'The earlier installation is unexpectedly linked.'
    }
    $versions = @(Get-ChildItem -LiteralPath $oldRoot -Directory -Filter 'app-*' | Where-Object {
      Test-Path -LiteralPath (Join-Path $_.FullName 'resources\build-info.json')
    })
    foreach ($version in $versions) { $null = Read-Identity $version.FullName }
    if (-not $versions.Count) { throw 'Cannot identify the earlier Cursor Atelier installation.' }
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($runKey)
    try { $startup = if ($key) { $key.GetValue($applicationId) } else { $null } }
    finally { if ($key) { $key.Close() } }
    # Redirect owned startup before cleanup, retaining its StartupApproved state.
    if ($startup -and $startup.StartsWith('"' + $oldRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
      $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($runKey)
      try { $key.SetValue($applicationId, '"' + $executable + '" --background', [Microsoft.Win32.RegistryValueKind]::String) }
      finally { $key.Close() }
    }
    Stop-OldProcesses $oldRoot
    $remover = Start-Process -FilePath (Join-Path $oldRoot 'Update.exe') -ArgumentList '--uninstall','--silent' -PassThru
    if (-not $remover.WaitForExit(60000)) { $remover.Kill(); throw 'The earlier installer did not finish uninstalling.' }
    if ($remover.ExitCode -ne 0) { throw 'The earlier installer could not uninstall its application.' }
    Stop-OldProcesses $oldRoot
    # Retain any residue left by Squirrel rather than deleting user-created files.
  }


  } catch {
    [Console]::Error.WriteLine('The new app is installed; earlier installer cleanup needs attention: ' + $_.Exception.Message)
    exit 2
  } finally {
  # Squirrel can remove the new same-named Start Menu shortcut.
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Cursor Atelier.lnk'))
  $shortcut.TargetPath = $executable
  $shortcut.WorkingDirectory = $InstallDirectory
  $shortcut.IconLocation = $executable + ',0'
  $shortcut.Save()

  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
