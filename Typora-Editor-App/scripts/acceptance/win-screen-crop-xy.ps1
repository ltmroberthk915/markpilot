param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [Parameter(Mandatory = $true)][int]$W,
  [Parameter(Mandatory = $true)][int]$H
)
# Screen-pixel crop with explicit physical coordinates (caller supplies them). DPI aware.
# ASCII only.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DpiAwareness2 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[DpiAwareness2]::SetProcessDPIAware() | Out-Null
$bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)), [System.Drawing.CopyPixelOperation]::SourceCopy)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ('crop=' + $X + ',' + $Y + ' ' + $W + 'x' + $H + ' -> ' + $Out)
