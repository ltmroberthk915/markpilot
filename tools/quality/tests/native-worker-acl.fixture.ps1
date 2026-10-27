$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($env:MP_NATIVE_RULE_FILE,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'PS parse error'}
$f=$ast.Find({param($n) $n-is[Management.Automation.Language.FunctionDefinitionAst]-and$n.Name-eq'Assert-WorkerRules'},$true)
if(-not$f){throw 'actual rule function absent'}
. ([scriptblock]::Create($f.Extent.Text))
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted=@($sid,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$rows=@();foreach($c in @(@('inherit-full','S-1-1-0',2032127,3,2,$true,$true),@('read','S-1-1-0',1179817,3,0,$true,$false),@('ancestor-delete','S-1-1-0',65536,0,0,$false,$true),@('inherit-write-ancestor','S-1-1-0',278,3,2,$false,$false),@('trusted',$sid,2032127,3,0,$true,$false),@('creator-inherit','S-1-3-0',2032127,3,2,$true,$false),@('creator-direct','S-1-3-0',2032127,3,0,$true,$true))){
 $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($c[1]),[Security.AccessControl.FileSystemRights]$c[2],[Security.AccessControl.InheritanceFlags]$c[3],[Security.AccessControl.PropagationFlags]$c[4],[Security.AccessControl.AccessControlType]::Allow)
 $rejected=$false;try{Assert-WorkerRules -rules @($rule) -private ([bool]$c[5])}catch{$rejected=$true}
 $rows+=@{name=$c[0];rejected=$rejected;expected=$c[6];passed=$rejected-eq$c[6]}
}
$rows|ConvertTo-Json -Compress
if(@($rows|Where-Object {-not$_.passed}).Count){exit 1}
