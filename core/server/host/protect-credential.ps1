param([Parameter(Mandatory = $true)][string]$LiteralPath, [switch]$Directory)
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $LiteralPath -Force
if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Credential path must not be redirected' }
$previous = if ($Directory) { [System.IO.Directory]::GetAccessControl($LiteralPath) } else { [System.IO.File]::GetAccessControl($LiteralPath) }
$owner = $previous.GetOwner([System.Security.Principal.SecurityIdentifier])
if ($Directory) {
  $security = [System.Security.AccessControl.DirectorySecurity]::new()
  $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
} else {
  $security = [System.Security.AccessControl.FileSecurity]::new()
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
}
$security.SetOwner($owner)
$security.SetAccessRuleProtection($true, $false)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($owner, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
$security.SetAccessRule($rule)
if ($Directory) { [System.IO.Directory]::SetAccessControl($LiteralPath, $security) } else { [System.IO.File]::SetAccessControl($LiteralPath, $security) }
$verified = if ($Directory) { [System.IO.Directory]::GetAccessControl($LiteralPath) } else { [System.IO.File]::GetAccessControl($LiteralPath) }
foreach ($entry in $verified.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($entry.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and $entry.IdentityReference -ne $owner) { throw 'Credential access restriction failed' }
}
