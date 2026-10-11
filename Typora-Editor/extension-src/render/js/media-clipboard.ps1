$ErrorActionPreference = 'Stop'
# Console encodings are pinned so that (a) the JSON payload we read from stdin is
# decoded as UTF-8 and (b) the JSON report we print is UTF-8 even when the parent
# process reads the pipe with a different ANSI code page (the previous version only
# fixed stdin, so a Chinese error message came back to the app as mojibake).
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# One JSON line on stdout is the contract with the host: success carries a read-back
# of the real clipboard formats, failure carries the message. The host never has to
# parse PowerShell's own error text (which is localized and code-page dependent).
$report = @{ ok = $true; action = $null; files = 0; formats = @(); error = $null }
$clipboardData = New-Object System.Windows.Forms.DataObject
$imageStream = $null
$htmlStream = $null
$clipboardImage = $null
try {
  $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $report.action = [string]$payload.action
  if ($payload.action -eq 'copy-image') {
    $imageStream = New-Object System.IO.MemoryStream(, [Convert]::FromBase64String($payload.data))
    $clipboardImage = [System.Drawing.Image]::FromStream($imageStream)
    $clipboardData.SetData([System.Windows.Forms.DataFormats]::Bitmap, $true, $clipboardImage)
    if ($payload.mime -eq 'image/png') { $clipboardData.SetData('PNG', $false, $imageStream) }
    else {
      # Non-PNG sources (JPEG/GIF/BMP): re-encode to PNG here so the 'PNG'
      # clipboard format is present for targets that specifically request it
      # (Word/WeChat prefer PNG over a bare DIB). The desktop EXE converts
      # with nativeImage before invoking this script; the VSIX extension host
      # has no image codec, so the conversion lives here (round 5 / B6).
      $png = New-Object System.IO.MemoryStream
      $clipboardImage.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
      $png.Position = 0
      $clipboardData.SetData('PNG', $false, $png)
    }
    $report.files = 1
  } elseif ($payload.action -eq 'copy-table') {
    # Excel otherwise guesses the CF_HTML bytes using the active ANSI codepage,
    # corrupting non-ASCII cell text even though UnicodeText is also present.
    $head = '<html><head><meta charset="utf-8"></head><body><!--StartFragment-->'
    $tail = '<!--EndFragment--></body></html>'
    $format = "Version:1.0`r`nStartHTML:{0:D10}`r`nEndHTML:{1:D10}`r`nStartFragment:{2:D10}`r`nEndFragment:{3:D10}`r`n"
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $start = $encoding.GetByteCount(($format -f 0,0,0,0))
    $fragmentStart = $start + $encoding.GetByteCount($head)
    $fragmentEnd = $fragmentStart + $encoding.GetByteCount([string]$payload.html)
    $end = $fragmentEnd + $encoding.GetByteCount($tail)
    $html = ($format -f $start,$end,$fragmentStart,$fragmentEnd) + $head + $payload.html + $tail
    # A String is encoded by WinForms using the active ANSI code page for this
    # custom clipboard format. CF_HTML is UTF-8, so provide its exact bytes.
    $htmlStream = New-Object System.IO.MemoryStream(, $encoding.GetBytes($html))
    $clipboardData.SetData([System.Windows.Forms.DataFormats]::Html, $false, $htmlStream)
    $clipboardData.SetData([System.Windows.Forms.DataFormats]::UnicodeText, [string]$payload.text)
  } elseif ($payload.action -eq 'copy-images') {
    # Multiple images: the primary format is CF_HDROP (a file drop list). WeChat,
    # Explorer and Chromium-based pages (DeepSeek and friends) read exactly that:
    # the browser maps CF_HDROP onto the paste event's files. Only real files are
    # accepted; sources without a path (data:/http) are materialized by the main
    # process into cache files first. Keep this file ASCII-only: PowerShell 5.1
    # decodes a BOM-less script using the active ANSI code page, so non-ASCII
    # bytes here can break parsing.
    $files = @()
    foreach ($file in @($payload.files)) {
      if ($file -and (Test-Path -LiteralPath $file -PathType Leaf)) { $files += (Resolve-Path -LiteralPath $file).Path }
    }
    if ($files.Count -eq 0) { throw 'No image file could be placed on the clipboard' }
    $clipboardData.SetData([System.Windows.Forms.DataFormats]::FileDrop, $true, [string[]]$files)
    $clipboardData.SetData([System.Windows.Forms.DataFormats]::UnicodeText, [string]::Join("`r`n", [string[]]$files))
    $report.files = $files.Count
    # Bitmap fallback for targets that only take an image (some chat/input boxes
    # cannot see a file list): one vertically stacked image, capped so a big set
    # cannot exhaust memory.
    if ($payload.composite -ne $false -and $files.Count -le 8) {
      $bitmaps = @()
      foreach ($file in $files) {
        try { $bitmaps += [System.Drawing.Image]::FromFile($file) } catch { }
        if ($bitmaps.Count -ge 8) { break }
      }
      if ($bitmaps.Count -gt 0) {
        $width = 0; $height = 0
        foreach ($bitmap in $bitmaps) { $width = [Math]::Max($width, $bitmap.Width); $height += $bitmap.Height }
        if ($width -gt 0 -and $height -gt 0) {
          $canvas = New-Object System.Drawing.Bitmap($width, [Math]::Min($height, 20000))
          $graphics = [System.Drawing.Graphics]::FromImage($canvas)
          $graphics.Clear([System.Drawing.Color]::White)
          $y = 0
          foreach ($bitmap in $bitmaps) {
            if ($y + $bitmap.Height -gt $canvas.Height) { break }
            $graphics.DrawImage($bitmap, 0, $y, $bitmap.Width, $bitmap.Height)
            $y += $bitmap.Height
          }
          $graphics.Dispose()
          $clipboardData.SetData([System.Windows.Forms.DataFormats]::Bitmap, $true, $canvas)
          $png = New-Object System.IO.MemoryStream
          $canvas.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
          $png.Position = 0
          $clipboardData.SetData('PNG', $false, $png)
        }
        foreach ($bitmap in $bitmaps) { $bitmap.Dispose() }
      }
    }
  } else { throw 'Unsupported clipboard action' }
  [System.Windows.Forms.Clipboard]::SetDataObject($clipboardData, $true, 4, 100)
  # Cheapest possible self-check that the data really landed on the system
  # clipboard, and it lets the host assert on the formats it asked for.
  $report.formats = @([System.Windows.Forms.Clipboard]::GetDataObject().GetFormats())
} catch {
  $report.ok = $false
  $report.error = $_.Exception.Message
} finally {
  if ($clipboardImage) { $clipboardImage.Dispose() }
  if ($imageStream) { $imageStream.Dispose() }
  if ($htmlStream) { $htmlStream.Dispose() }
}
[Console]::Out.Write(($report | ConvertTo-Json -Compress -Depth 4) + "`n")
[Console]::Out.Flush()
if (-not $report.ok) { exit 1 }
