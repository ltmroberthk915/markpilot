param([Parameter(Mandatory=$true)][string]$ImagePath,[ValidateRange(0,2)][double]$MeanTolerance=0)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$drawingReferences=@('System.Drawing.Common','System.Private.Windows.GdiPlus','System.Private.Windows.Core') | ForEach-Object {
  $candidate=Join-Path $PSHOME ($_.ToString()+'.dll')
  if(Test-Path -LiteralPath $candidate){$candidate}
}
$compilerReferences=@(Get-ChildItem -Path (Join-Path $PSHOME 'ref/*.dll') | ForEach-Object FullName)+@($drawingReferences)
Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
public static class MarkPilotBitmapCheck {
  public static byte[] Pixels(Image source) {
    using (var bitmap = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb)) {
      using (var graphics = Graphics.FromImage(bitmap)) graphics.DrawImageUnscaled(source, 0, 0);
      var locked = bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      try {
        var data = new byte[bitmap.Width * bitmap.Height * 4];
        for (int row=0;row<bitmap.Height;row++) Marshal.Copy(IntPtr.Add(locked.Scan0,row*locked.Stride),data,row*bitmap.Width*4,bitmap.Width*4);
        return data;
      } finally { bitmap.UnlockBits(locked); }
    }
  }
  public static double Difference(Image expected, Image observed) {
    var a=Pixels(expected);var b=Pixels(observed);long sum=0;
    for(int i=0;i<a.Length;i++)sum+=Math.Abs((int)a[i]-(int)b[i]);
    return (double)sum/a.Length;
  }
}
'@ -ReferencedAssemblies $compilerReferences
$expected=[System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $ImagePath).Path)
$observed=[System.Windows.Forms.Clipboard]::GetImage()
try {
  $matches=$null -ne $observed -and $observed.Width -eq $expected.Width -and $observed.Height -eq $expected.Height
  $difference=$null
  if ($matches) { $difference=[MarkPilotBitmapCheck]::Difference($expected,$observed);$matches=$difference -le $MeanTolerance }
  @{matches=$matches;hasImage=($null -ne $observed);expectedWidth=$expected.Width;expectedHeight=$expected.Height;meanDifference=$difference;tolerance=$MeanTolerance} | ConvertTo-Json -Compress
} finally { $expected.Dispose();if($null -ne $observed){$observed.Dispose()} }
