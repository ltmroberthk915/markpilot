param(
  [Parameter(Mandatory = $true)][string]$OutPrefix,
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [Parameter(Mandatory = $true)][int]$W,
  [Parameter(Mandatory = $true)][int]$H,
  [int]$Count = 8,
  [int]$IntervalMs = 130,
  [string]$Hwnd = ''
)
# Burst of screen crops from ONE DPI-aware process. The insertion caret blinks (Chromium:
# ~500 ms on / ~500 ms off), so a single frame can never prove "no caret was painted";
# a burst spanning at least one full blink cycle can. Each frame is saved and its column
# ink profile is printed, so "how many vertical bars and how wide" is machine readable.
#
# With -Hwnd the window is raised (TOPMOST + foreground) before EVERY frame: screen pixels
# are only meaningful while the window we care about is actually the one on screen.
# ASCII only.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class BurstWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@
[BurstWin]::SetProcessDPIAware() | Out-Null
$hwndPtr = [IntPtr]::Zero
if ($Hwnd -ne '') { $hwndPtr = [IntPtr][Convert]::ToInt64($Hwnd, 16) }
$TOPMOST = [IntPtr](-1)
$FLAGS = 0x0001 -bor 0x0002 -bor 0x0010   # NOSIZE | NOMOVE | NOACTIVATE
for ($i = 0; $i -lt $Count; $i++) {
  if ($hwndPtr -ne [IntPtr]::Zero) {
    [BurstWin]::SetWindowPos($hwndPtr, $TOPMOST, 0, 0, 0, 0, $FLAGS) | Out-Null
    Start-Sleep -Milliseconds 60
  }
  $bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)), [System.Drawing.CopyPixelOperation]::SourceCopy)
  $g.Dispose()
  $file = $OutPrefix + '-f' + $i + '.png'
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  # column profile
  $all = New-Object 'System.Collections.Generic.List[double]'
  for ($y = 0; $y -lt $H; $y++) { for ($x = 0; $x -lt $W; $x++) { $c = $bmp.GetPixel($x, $y); $all.Add(($c.R * 0.11 + $c.G * 0.59 + $c.B * 0.3)) } }
  $all.Sort(); $bg = $all[[int]($all.Count / 2)]
  $colHit = New-Object 'int[]' $W; $colTop = New-Object 'int[]' $W; $colBot = New-Object 'int[]' $W
  for ($x = 0; $x -lt $W; $x++) {
    $n = 0; $top = -1; $bot = -1
    for ($y = 0; $y -lt $H; $y++) { $c = $bmp.GetPixel($x, $y); $d = [math]::Abs(($c.R * 0.11 + $c.G * 0.59 + $c.B * 0.3) - $bg)
      if ($d -gt 60) { $n++; if ($top -lt 0) { $top = $y }; $bot = $y } }
    $colHit[$x] = $n; $colTop[$x] = $top; $colBot[$x] = $bot
  }
  $groups = @()
  $x = 0
  while ($x -lt $W) {
    if ($colHit[$x] -gt 1) {
      $x0 = $x; $top = 9999; $bot = -1
      while ($x -lt $W -and $colHit[$x] -gt 1) { if ($colTop[$x] -lt $top) { $top = $colTop[$x] }; if ($colBot[$x] -gt $bot) { $bot = $colBot[$x] }; $x++ }
      $groups += ('[' + $x0 + '..' + ($x - 1) + ' w' + ($x - $x0) + ' h' + ($bot - $top + 1) + ']')
    } else { $x++ }
  }
  Write-Output ('f' + $i + ': ' + ($groups -join ' '))
  $bmp.Dispose()
  if ($i -lt ($Count - 1)) { Start-Sleep -Milliseconds $IntervalMs }
}
