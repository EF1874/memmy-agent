param(
  [Parameter(Mandatory = $true)]
  [string]$ProbePath,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$statusPath = "$OutputPath.shell-window.json"
try {
  $shell = New-Object -ComObject Shell.Application
  $windows = @($shell.Windows())
  $explorerPath = [System.IO.Path]::GetFullPath((Join-Path $env:WINDIR 'explorer.exe'))
  $window = $windows | Where-Object {
    try {
      [System.IO.Path]::GetFullPath([string]$_.FullName) -ieq $explorerPath
    }
    catch {
      $false
    }
  } | Select-Object -First 1
  if ($null -eq $window) {
    throw 'No Explorer shell window is available.'
  }
  $arguments = 'child "' + $OutputPath + '"'
  $window.Document.Application.ShellExecute(
    $ProbePath,
    $arguments,
    [System.IO.Path]::GetDirectoryName($ProbePath),
    'open',
    0
  )
  for ($attempt = 0; $attempt -lt 200; $attempt += 1) {
    if (Test-Path -LiteralPath $OutputPath -PathType Leaf) {
      break
    }
    Start-Sleep -Milliseconds 50
  }
  [ordered]@{
    status = if (Test-Path -LiteralPath $OutputPath -PathType Leaf) { 'success' } else { 'timeout' }
    shellWindowHwnd = [int64]$window.HWND
    shellWindowExecutable = [string]$window.FullName
  } | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding utf8
}
catch {
  [ordered]@{
    status = 'error'
    exceptionType = $_.Exception.GetType().FullName
    message = $_.Exception.Message
    fullyQualifiedErrorId = $_.FullyQualifiedErrorId
  } | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding utf8
}
