param([Parameter(Mandatory=$true)][string]$ImagePath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# Original clipboard data stays in memory. Never print or persist its contents.
$clipOriginal = [System.Windows.Forms.Clipboard]::GetDataObject()
$clipBackup = New-Object System.Windows.Forms.DataObject
if ($null -ne $clipOriginal) {
    foreach ($clipFormat in $clipOriginal.GetFormats($false)) {
        $clipValue = $clipOriginal.GetData($clipFormat, $false)
        if ($clipValue -is [System.Drawing.Image]) { $clipValue = $clipValue.Clone() }
        if ($clipValue -is [System.IO.MemoryStream]) { $clipValue = [System.IO.MemoryStream]::new($clipValue.ToArray()) }
        $clipBackup.SetData($clipFormat, $false, $clipValue)
    }
}
try {
    $clipBitmap = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $ImagePath).Path)
    try { [System.Windows.Forms.Clipboard]::SetImage($clipBitmap) }
    finally { $clipBitmap.Dispose() }
    [Console]::WriteLine((@{ready=$true; formats=@([System.Windows.Forms.Clipboard]::GetDataObject().GetFormats())} | ConvertTo-Json -Compress))
    # EOF also restores the clipboard if the test process exits unexpectedly.
    [void][Console]::ReadLine()
} finally {
    if ($null -eq $clipOriginal) { [System.Windows.Forms.Clipboard]::Clear() }
    else { [System.Windows.Forms.Clipboard]::SetDataObject($clipBackup, $true) }
    [Console]::WriteLine('{"restored":true}')
}
