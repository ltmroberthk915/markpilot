param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out,
  [double]$Factor = 2
)
# Nearest-neighbour upscale for local acceptance shots (the native caret is 1-2 physical
# px wide; at 2x it is readable). ASCII only.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Bitmap]::FromFile($In)
$w = [int][math]::Round($src.Width * $Factor); $h = [int][math]::Round($src.Height * $Factor)
$dst = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
$g = [System.Drawing.Graphics]::FromImage($dst)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
$g.DrawImage($src, 0, 0, $w, $h)
$g.Dispose()
$dst.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$dst.Dispose(); $src.Dispose()
Write-Output ($In + ' -> ' + $Out + ' (' + $w + 'x' + $h + ')')
