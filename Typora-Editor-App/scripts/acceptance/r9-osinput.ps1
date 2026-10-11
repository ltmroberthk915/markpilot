param([int]$X = 0, [int]$Y = 0, [int]$TargetPid = 0, [string]$Mode = 'xbuttons')
$ErrorActionPreference = 'Stop'
Add-Type -Namespace R9 -Name Xi -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] pInputs, int cbSize);
[StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }
[StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
'@
$fg = [R9.Xi]::GetForegroundWindow()
$fgPid = 0
[void][R9.Xi]::GetWindowThreadProcessId($fg, [ref]$fgPid)
if ($fgPid -ne $TargetPid) { Write-Output ('{"own":false,"fgPid":' + $fgPid + ',"wantPid":' + $TargetPid + '}'); exit 0 }
if ($Mode -eq 'f11') {
  # keyboard via MOUSEINPUT overlay: dx=wVk dy=wScan (classic SendInput union trick)
  $down = New-Object R9.Xi+INPUT[] 2
  $down[0].type = 1; $down[0].mi.dx = 0x7A; $down[0].mi.dwFlags = 0
  $down[1].type = 1; $down[1].mi.dx = 0x7A; $down[1].mi.dwFlags = 2
  $n = [R9.Xi]::SendInput(2, $down, [System.Runtime.InteropServices.Marshal]::SizeOf([type][R9.Xi+INPUT]))
  Write-Output ('{"own":true,"sent":' + $n + '}')
  exit 0
}
[void][R9.Xi]::SetCursorPos($X, $Y)
Start-Sleep -Milliseconds 120
$inputs = New-Object R9.Xi+INPUT[] 2
$inputs[0].type = 0; $inputs[0].mi.mouseData = 1; $inputs[0].mi.dwFlags = 0x0080
$inputs[1].type = 0; $inputs[1].mi.dwFlags = 0x0100
$n1 = [R9.Xi]::SendInput(2, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([type][R9.Xi+INPUT]))
Start-Sleep -Milliseconds 200
$inputs2 = New-Object R9.Xi+INPUT[] 2
$inputs2[0].type = 0; $inputs2[0].mi.mouseData = 2; $inputs2[0].mi.dwFlags = 0x0080
$inputs2[1].type = 0; $inputs2[1].mi.dwFlags = 0x0100
$n2 = [R9.Xi]::SendInput(2, $inputs2, [System.Runtime.InteropServices.Marshal]::SizeOf([type][R9.Xi+INPUT]))
Write-Output ('{"own":true,"x1":' + $n1 + ',"x2":' + $n2 + '}')
