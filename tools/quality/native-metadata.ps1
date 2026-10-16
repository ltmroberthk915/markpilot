param([ValidateSet('prepare','read')][string]$Action,[string]$Path,[string]$OwnedRoot)
$ErrorActionPreference='Stop'
$resolvedProbeRoot=[System.IO.Path]::GetFullPath($OwnedRoot).TrimEnd('\')
$resolvedProbePath=[System.IO.Path]::GetFullPath($Path)
$probeOwner=Get-Content -LiteralPath (Join-Path $resolvedProbeRoot 'quality-run.json') -Raw|ConvertFrom-Json
if ($probeOwner.owner -ne 'markpilot-quality' -or -not $resolvedProbePath.StartsWith($resolvedProbeRoot+'\',[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Owned probe path required' }
if ($Action -eq 'prepare') {
  $probeSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $probeAcl=[System.Security.AccessControl.FileSecurity]::new()
  $probeAcl.SetAccessRuleProtection($true,$false)
  $probeAcl.SetOwner($probeSid)
  $probeAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($probeSid,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow))
  Set-Acl -LiteralPath $resolvedProbePath -AclObject $probeAcl
  Set-Content -LiteralPath $resolvedProbePath -Stream MP_PROBE -Value 'OWNED_METADATA_MARKER' -NoNewline -Encoding utf8
}
$probeCurrent=Get-Acl -LiteralPath $resolvedProbePath
$probeStream=$null
try { $probeStream=Get-Content -LiteralPath $resolvedProbePath -Stream MP_PROBE -Raw -ErrorAction Stop } catch { }
@{protected=$probeCurrent.AreAccessRulesProtected;sddl=$probeCurrent.Sddl;stream=$probeStream}|ConvertTo-Json -Compress
