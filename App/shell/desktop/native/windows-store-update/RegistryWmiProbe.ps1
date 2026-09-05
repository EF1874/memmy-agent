param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$hkeyUsers = [uint32]2147483651
$uninstallKey = "$sid\Software\Microsoft\Windows\CurrentVersion\Uninstall\886615f7-a04c-57ec-a2dd-9161dbe1a7c4"
$authorityKey = "$sid\Software\886615f7-a04c-57ec-a2dd-9161dbe1a7c4"

function Read-RegistryString([string]$Subkey, [uint32]$Architecture) {
  $options = New-CimSessionOption -Protocol Dcom
  $session = New-CimSession -ComputerName localhost -SessionOption $options
  try {
    $result = Invoke-CimMethod `
      -CimSession $session `
      -Namespace root/default `
      -ClassName StdRegProv `
      -MethodName GetStringValue `
      -Arguments @{
        hDefKey = $hkeyUsers
        sSubKeyName = $Subkey
        sValueName = 'InstallLocation'
      }
    return [ordered]@{
      architecture = $Architecture
      returnValue = [uint32]$result.ReturnValue
      value = $result.sValue
    }
  }
  finally {
    Remove-CimSession -CimSession $session
  }
}

try {
  $payload = [ordered]@{
    status = 'success'
    pid = $PID
    session = (Get-Process -Id $PID).SessionId
    sid = $sid
    uninstall32 = Read-RegistryString -Subkey $uninstallKey -Architecture 32
    uninstall64 = Read-RegistryString -Subkey $uninstallKey -Architecture 64
    authority32 = Read-RegistryString -Subkey $authorityKey -Architecture 32
    authority64 = Read-RegistryString -Subkey $authorityKey -Architecture 64
  }
}
catch {
  $payload = [ordered]@{
    status = 'error'
    pid = $PID
    session = (Get-Process -Id $PID).SessionId
    sid = $sid
    exceptionType = $_.Exception.GetType().FullName
    message = $_.Exception.Message
    fullyQualifiedErrorId = $_.FullyQualifiedErrorId
  }
}
$payload | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutputPath -Encoding utf8
