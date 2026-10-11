param(
  [Parameter(Mandatory = $true)][string]$Profile,
  [int]$Timeout = 60000
)
# Independent witness for "when did the window actually appear on screen".
# The app shows its window from a ready-to-show handler, so this is the moment the user
# starts seeing something; it must be observed from outside the app (window manager),
# never from the app's own timing code.
#
# ASCII only (PowerShell 5.1 decodes a BOM-less script with the ANSI code page).
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace Acc -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
'@
$deadline = [DateTime]::UtcNow.AddMilliseconds($Timeout)
$firstSeen = [DateTime]::UtcNow
while ([DateTime]::UtcNow -lt $deadline) {
  foreach ($process in @(Get-Process -Name MarkPilot -ErrorAction SilentlyContinue)) {
    $handle = $process.MainWindowHandle
    if (-not $handle -or $handle -eq 0) { continue }
    $info = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $process.Id) -ErrorAction SilentlyContinue
    if (-not $info -or -not $info.CommandLine -or -not $info.CommandLine.Contains($Profile)) { continue }
    if ([Acc.Win]::IsWindowVisible($handle)) {
      $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      [Console]::Out.Write("visible " + $stamp + " " + $process.Id + " " + ([int](([DateTime]::UtcNow) - $firstSeen).TotalMilliseconds))
      exit 0
    }
  }
  Start-Sleep -Milliseconds 20
}
[Console]::Out.Write("timeout " + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
