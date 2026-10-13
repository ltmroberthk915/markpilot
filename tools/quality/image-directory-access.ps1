param(
 [Parameter(Mandatory=$true)][string]$RunDirectory,
 [Parameter(Mandatory=$true)][string]$Directory,
 [Parameter(Mandatory=$true)][ValidateSet('block','restore')][string]$Mode
)
$ErrorActionPreference='Stop'
$run=(Resolve-Path -LiteralPath $RunDirectory).Path
$target=(Resolve-Path -LiteralPath $Directory).Path
$marker=Get-Content -Raw -LiteralPath (Join-Path $run 'quality-run.json') | ConvertFrom-Json
if($marker.owner -ne 'markpilot-quality' -or -not $target.StartsWith($run+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'ACL fixture must stay inside its owned quality output' }
if((Get-Item -LiteralPath $target).LinkType){throw 'ACL fixture cannot be a link'}
$record=Join-Path $run 'image-directory-acl.json'
if($Mode -eq 'block') {
 if(Test-Path -LiteralPath $record){throw 'Existing ACL receipt; restore it before retrying'}
 $acl=Get-Acl -LiteralPath $target
 @{directory=$target;sddl=$acl.Sddl}|ConvertTo-Json -Compress|Set-Content -LiteralPath $record
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
 $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'Write','ContainerInherit,ObjectInherit','None','Deny')
 $acl.AddAccessRule($rule)
 Set-Acl -LiteralPath $target -AclObject $acl
} else {
 $original=Get-Content -Raw -LiteralPath $record|ConvertFrom-Json
 if($original.directory -ne $target){throw 'ACL receipt target mismatch'}
 $acl=Get-Acl -LiteralPath $target
 $acl.SetSecurityDescriptorSddlForm($original.sddl)
 Set-Acl -LiteralPath $target -AclObject $acl
 if((Get-Acl -LiteralPath $target).Sddl -ne $original.sddl){throw 'ACL restoration mismatch'}
}
@{mode=$Mode;directory=$target;ok=$true}|ConvertTo-Json -Compress
