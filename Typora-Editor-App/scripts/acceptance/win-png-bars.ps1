param(
  [Parameter(Mandatory = $true)][string]$In,
  [int]$Y0 = 0,
  [int]$Y1 = 0,
  [int]$Threshold = 60
)
# Report vertical bars in a PNG: for every column, count pixels whose luminance exceeds
# (background + threshold), where the background is the median luminance of that row band.
# Output: one line per column group: "x=..-.. rows=..-.. n=..".
# ASCII only (PowerShell 5.1 + ANSI code page).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile($In)
$w = $bmp.Width; $h = $bmp.Height
if ($Y1 -le 0 -or $Y1 -gt $h) { $Y1 = $h }
$lum = New-Object 'double[][]' $Y1
for ($y = $Y0; $y -lt $Y1; $y++) {
  $row = New-Object 'double[]' $w
  for ($x = 0; $x -lt $w; $x++) {
    $c = $bmp.GetPixel($x, $y)
    $row[$x] = ($c.R * 0.11 + $c.G * 0.59 + $c.B * 0.3) / 255 * 255
  }
  $lum[$y - $Y0] = $row
}
# background = median of all pixels in the band
$all = New-Object 'System.Collections.Generic.List[double]'
for ($y = 0; $y -lt ($Y1 - $Y0); $y++) { for ($x = 0; $x -lt $w; $x++) { $all.Add($lum[$y][$x]) } }
$all.Sort()
$bg = $all[[int]($all.Count / 2)]
Write-Output ("file=" + $In + " size=" + $w + "x" + $h + " band=" + $Y0 + ".." + $Y1 + " bg=" + [math]::Round($bg, 1))
$colHit = New-Object 'int[]' $w
$colTop = New-Object 'int[]' $w
$colBot = New-Object 'int[]' $w
for ($x = 0; $x -lt $w; $x++) {
  $n = 0; $top = -1; $bot = -1
  for ($y = 0; $y -lt ($Y1 - $Y0); $y++) {
    $d = [math]::Abs($lum[$y][$x] - $bg)
    if ($d -gt $Threshold) { $n++; if ($top -lt 0) { $top = $y }; $bot = $y }
  }
  $colHit[$x] = $n; $colTop[$x] = $top; $colBot[$x] = $bot
}
# group adjacent columns that have ink
$x = 0
while ($x -lt $w) {
  if ($colHit[$x] -gt 1) {
    $x0 = $x; $top = 9999; $bot = -1; $max = 0
    while ($x -lt $w -and $colHit[$x] -gt 1) {
      if ($colTop[$x] -lt $top) { $top = $colTop[$x] }
      if ($colBot[$x] -gt $bot) { $bot = $colBot[$x] }
      if ($colHit[$x] -gt $max) { $max = $colHit[$x] }
      $x++
    }
    Write-Output ("  x=" + $x0 + ".." + ($x - 1) + " w=" + ($x - $x0) + " rows=" + ($top + $Y0) + ".." + ($bot + $Y0) + " h=" + ($bot - $top + 1) + " maxcol=" + $max)
  } else { $x++ }
}
$bmp.Dispose()
