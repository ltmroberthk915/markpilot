param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$In = '',
  [string]$Out = 'clipboard-witness.json'
)
# Independent witness for clipboard scenarios. The acceptance suite never trusts the
# app's own report about the clipboard: this script reads the real system clipboard in
# a separate process and writes raw facts (formats, dropped file paths, sizes and
# SHA256 of those files, text, image dimensions) to a JSON file.
#
# ASCII only on purpose: PowerShell 5.1 decodes a BOM-less script with the active ANSI
# code page, so non-ASCII bytes here can break parsing.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# Raw (byte-exact) clipboard reads need the Win32 clipboard API: the managed API converts
# custom formats to String using the ANSI code page, which corrupts UTF-8 payloads.
Add-Type -Namespace Acc -Name Clip -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true)] public static extern uint RegisterClipboardFormat(string format);
[DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetClipboardData(uint format);
[DllImport("user32.dll", SetLastError=true)] public static extern bool OpenClipboard(IntPtr owner);
[DllImport("user32.dll", SetLastError=true)] public static extern bool CloseClipboard();
[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GlobalLock(IntPtr handle);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GlobalUnlock(IntPtr handle);
[DllImport("kernel32.dll", SetLastError=true)] public static extern UIntPtr GlobalSize(IntPtr handle);
'@

$directory = Split-Path -Parent $Out
if (-not $directory) { $directory = '.' }
function Save-Report($value) {
  $json = $value | ConvertTo-Json -Compress -Depth 6
  [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
}
function Get-Hash([string]$file) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
  return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower()
}

try {
  if ($Action -eq 'save') {
    $state = @{ ok = $true; hasText = $false; text = $null; hasImage = $false; imagePath = $null; hasFiles = $false; files = @() }
    if ([System.Windows.Forms.Clipboard]::ContainsText()) { $state.hasText = $true; $state.text = [System.Windows.Forms.Clipboard]::GetText() }
    if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
      $image = [System.Windows.Forms.Clipboard]::GetImage()
      $state.imagePath = Join-Path $directory 'saved-clipboard-image.png'
      $image.Save($state.imagePath, [System.Drawing.Imaging.ImageFormat]::Png)
      $state.hasImage = $true
      $image.Dispose()
    }
    if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
      $state.hasFiles = $true
      $state.files = @([System.Windows.Forms.Clipboard]::GetFileDropList())
    }
    Save-Report $state
    exit 0
  }
  if ($Action -eq 'restore') {
    $state = Get-Content -LiteralPath $In -Raw -Encoding UTF8 | ConvertFrom-Json
    $data = New-Object System.Windows.Forms.DataObject
    if ($state.hasText) { $data.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $true, [string]$state.text) }
    $image = $null
    if ($state.hasImage -and $state.imagePath -and (Test-Path -LiteralPath $state.imagePath)) {
      $image = [System.Drawing.Image]::FromFile($state.imagePath)
      $data.SetData([System.Windows.Forms.DataFormats]::Bitmap, $true, $image)
    }
    if ($state.hasFiles -and $state.files.Count -gt 0) { $data.SetData([System.Windows.Forms.DataFormats]::FileDrop, $true, [string[]]$state.files) }
    [System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
    if ($image) { $image.Dispose() }
    Save-Report @{ ok = $true; restored = $true }
    exit 0
  }
  if ($Action -eq 'write') {
    # Put known text on the clipboard so a paste can be driven for real. Text comes
    # from a UTF-8 file so nothing has to survive command-line quoting.
    $text = [System.IO.File]::ReadAllText($In, (New-Object System.Text.UTF8Encoding($false)))
    [System.Windows.Forms.Clipboard]::SetText($text)
    Save-Report @{ ok = $true; written = $true; length = $text.Length }
    exit 0
  }
  if ($Action -eq 'read') {
    $report = @{ ok = $true; formats = @(); files = @(); fileHashes = @(); fileSizes = @(); hasText = $false; text = $null;
                 hasImage = $false; imageWidth = 0; imageHeight = 0; hasPng = $false; pngWidth = 0; pngHeight = 0;
                 hasBitmap = $false; hasFileDrop = $false; fileCount = 0 }
    $data = [System.Windows.Forms.Clipboard]::GetDataObject()
    if ($data) { $report.formats = @($data.GetFormats()) }
    if ([System.Windows.Forms.Clipboard]::ContainsText()) { $report.hasText = $true; $report.text = [System.Windows.Forms.Clipboard]::GetText() }
    if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
      $image = [System.Windows.Forms.Clipboard]::GetImage()
      $report.hasImage = $true
      $report.imageWidth = $image.Width
      $report.imageHeight = $image.Height
      $image.Dispose()
    }
    if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
      $report.hasFileDrop = $true
      $report.files = @([System.Windows.Forms.Clipboard]::GetFileDropList())
      $report.fileCount = $report.files.Count
      foreach ($file in $report.files) {
        $report.fileHashes += (Get-Hash $file)
        if (Test-Path -LiteralPath $file -PathType Leaf) { $report.fileSizes += (Get-Item -LiteralPath $file).Length } else { $report.fileSizes += -1 }
      }
    }
    if ($data -and $data.GetDataPresent('PNG')) {
      $report.hasPng = $true
      try {
        $stream = $data.GetData('PNG')
        if ($stream -is [System.IO.Stream]) {
          $copy = New-Object System.IO.MemoryStream
          $stream.CopyTo($copy)
          $copy.Position = 0
          $image = [System.Drawing.Image]::FromStream($copy)
          $report.pngWidth = $image.Width
          $report.pngHeight = $image.Height
          $image.Dispose()
          $copy.Dispose()
        }
      } catch { $report.pngError = $_.Exception.Message }
    }
    if ($data -and $data.GetDataPresent([System.Windows.Forms.DataFormats]::Bitmap)) { $report.hasBitmap = $true }
    # CF_HTML must be read back as RAW BYTES. WinForms hands a custom format back as a
    # String decoded with the active ANSI code page, which mangles UTF-8 table bytes
    # (observed: CJK cells came back as mojibake while the clipboard itself was fine).
    # So go through the Win32 clipboard API and decode the HGLOBAL as UTF-8 ourselves.
    try {
      $format = [Acc.Clip]::RegisterClipboardFormat('HTML Format')
      if ($format -ne 0 -and [Acc.Clip]::OpenClipboard([IntPtr]::Zero)) {
        try {
          $handle = [Acc.Clip]::GetClipboardData($format)
          if ($handle -ne [IntPtr]::Zero) {
            $pointer = [Acc.Clip]::GlobalLock($handle)
            if ($pointer -ne [IntPtr]::Zero) {
              $size = [int]([Acc.Clip]::GlobalSize($handle).ToUInt64())
              $buffer = New-Object byte[] $size
              [System.Runtime.InteropServices.Marshal]::Copy($pointer, $buffer, 0, $size)
              [void][Acc.Clip]::GlobalUnlock($handle)
              $report.hasHtml = $true
              $report.htmlRawBytes = $size
              $report.htmlRawUtf8 = [System.Text.Encoding]::UTF8.GetString($buffer)
            }
          }
        } finally { [void][Acc.Clip]::CloseClipboard() }
      }
    } catch { $report.htmlRawError = $_.Exception.Message }
    Save-Report $report
    exit 0
  }
  throw "Unsupported action: $Action"
} catch {
  Save-Report @{ ok = $false; action = $Action; error = $_.Exception.Message }
  exit 1
}
