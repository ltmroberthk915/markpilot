param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Hwnd,
  [Parameter(Mandatory = $true)][double]$CssX,
  [Parameter(Mandatory = $true)][double]$CssY,
  [Parameter(Mandatory = $true)][double]$CssW,
  [Parameter(Mandatory = $true)][double]$CssH,
  [Parameter(Mandatory = $true)][double]$Scale
)
# Screen-pixel crop anchored to a WINDOW HANDLE instead of guessing content offsets:
# GetClientRect + ClientToScreen come from the same user32 ruler that the window manager
# uses, so the mapping CSS px -> physical px is exact once the process is DPI aware.
#
# Region is given in CSS px inside the client area, scaled by $Scale (display scale factor;
# the app runs at zoom 1.0). ASCII only.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinCrop {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[WinCrop]::SetProcessDPIAware() | Out-Null
$h = [IntPtr][Convert]::ToInt64($Hwnd, 16)
[WinCrop]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 150
$pt = New-Object WinCrop+POINT
$pt.X = 0; $pt.Y = 0
[WinCrop]::ClientToScreen($h, [ref]$pt) | Out-Null
$X = [int][math]::Round($pt.X + $CssX * $Scale)
$Y = [int][math]::Round($pt.Y + $CssY * $Scale)
$W = [int][math]::Round($CssW * $Scale)
$H = [int][math]::Round($CssH * $Scale)
$bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)), [System.Drawing.CopyPixelOperation]::SourceCopy)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ('client=' + $pt.X + ',' + $pt.Y + ' crop=' + $X + ',' + $Y + ' ' + $W + 'x' + $H + ' -> ' + $Out)
