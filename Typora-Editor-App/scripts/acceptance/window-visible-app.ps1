param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][string]$Match,
  [int]$Timeout = 60000
)
# 泛化版"窗口真的出现在屏幕上"证人：进程名 + 命令行子串定位到被测实例。
#
# 为什么要另起一份而不是改 window-visible.ps1：那份是 MarkPilot 验收套件的证人，
# 本轮要与 Typora 做同口径对照，两边必须用**同一把尺子**；改老文件会同时动到
# 已有基线，所以这里复制一份泛化版，本轮的 MarkPilot 侧也改用这一份。
#
# 只从窗口管理器侧观察（IsWindowVisible），绝不采信应用自报的时间戳。
# ASCII only（PowerShell 5.1 用 ANSI 码页解码无 BOM 脚本）。
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace Acc -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
'@
$deadline = [DateTime]::UtcNow.AddMilliseconds($Timeout)
$firstSeen = [DateTime]::UtcNow
while ([DateTime]::UtcNow -lt $deadline) {
  foreach ($process in @(Get-Process -Name $Name -ErrorAction SilentlyContinue)) {
    $handle = $process.MainWindowHandle
    if (-not $handle -or $handle -eq 0) { continue }
    $info = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $process.Id) -ErrorAction SilentlyContinue
    if (-not $info -or -not $info.CommandLine -or -not $info.CommandLine.Contains($Match)) { continue }
    if ([Acc.Win]::IsWindowVisible($handle)) {
      $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      [Console]::Out.Write("visible " + $stamp + " " + $process.Id + " " + ([int](([DateTime]::UtcNow) - $firstSeen).TotalMilliseconds))
      exit 0
    }
  }
  Start-Sleep -Milliseconds 20
}
[Console]::Out.Write("timeout " + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
