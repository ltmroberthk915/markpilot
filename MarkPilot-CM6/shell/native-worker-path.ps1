$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted=@($sid,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$checks=[Collections.Generic.List[object]]::new()
function Assert-WorkerRules($rules,[bool]$private){
 foreach($r in $rules){
  if($r.AccessControlType-ne[Security.AccessControl.AccessControlType]::Allow-or$r.IdentityReference.Value-in$trusted){continue}
  $inheritOnly=($r.PropagationFlags-band[Security.AccessControl.PropagationFlags]::InheritOnly)-ne0
  if($r.IdentityReference.Value-eq'S-1-3-0'-and$inheritOnly){continue}
  $mask=[long]$r.FileSystemRights
  if(((-not$inheritOnly)-and($mask-band 0x500D0040)-ne0)-or($private-and($mask-band 0x500D0156)-ne0)){throw 'Worker directory permits modification by another identity'}
 }
}
function Inspect-Directory([string]$p,[bool]$private){
 $d=[IO.DirectoryInfo]::new($p)
 if(-not$d.Exists-or($d.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0){throw 'Worker path must contain real directories'}
 $a=$d.GetAccessControl([Security.AccessControl.AccessControlSections]'Owner,Access')
 $owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value
 if($owner-notin$trusted){throw 'Worker path has an untrusted owner'}
 Assert-WorkerRules ($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) $private
 $checks.Add(@{path=$d.FullName;owner=$owner;sddl=$a.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Access')})
}
$lease=$env:MP_NATIVE_LEASE_PATH
if($lease){$lease=[IO.Path]::GetFullPath($lease).TrimEnd('\')}
$candidates=@([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData),[IO.Path]::Combine($env:USERPROFILE,'AppData','Local'),$env:USERPROFILE)|Select-Object -Unique
$base=$null;$rejections=[Collections.Generic.List[string]]::new()
foreach($candidate in $candidates){
 try{
  $candidate=[IO.Path]::GetFullPath($candidate).TrimEnd('\')
  if($candidate-notmatch'^[A-Za-z]:\\'-or$candidate.Length-gt180){throw 'No short local worker base'}
  if($lease-and-not[IO.Path]::GetDirectoryName($lease).Equals($candidate,[StringComparison]::OrdinalIgnoreCase)){continue}
  $checks.Clear();$p=$candidate
  while($p){Inspect-Directory $p ($p-eq$candidate);$parent=[IO.Directory]::GetParent($p);$p=if($parent){$parent.FullName}else{$null}}
  $base=$candidate;break
 }catch{$rejections.Add($_.Exception.Message)}
}
if(-not$base){throw ('No qualified private worker directory: '+($rejections-join'; '))}
if($lease){
 if(-not[IO.Path]::GetDirectoryName($lease).Equals($base,[StringComparison]::OrdinalIgnoreCase)-or[IO.Path]::GetFileName($lease)-notmatch'^MarkPilot-file-[0-9]+-[A-Za-z0-9]{6}$'){throw 'Worker lease must be a new direct child'}
 Inspect-Directory $lease $true
 if(($lease.Length+16)-gt240){throw 'Worker executable path budget exceeded'}
}
[pscustomobject]@{base=$base;lease=$lease;sid=$sid;checks=@($checks);rejectedCandidates=@($rejections)}|ConvertTo-Json -Depth 5 -Compress
