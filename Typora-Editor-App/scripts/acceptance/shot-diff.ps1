param(
  [Parameter(Mandatory = $true)][string]$Old,
  [Parameter(Mandatory = $true)][string]$New,
  [int]$TargetWidth = 780,
  [int]$TargetHeight = 900
)
# Proves "same picture, only sharper": shrink the new high-density shot back to the old
# shot's size and compare pixel by pixel.
# Prints: mean absolute difference / share of pixels past threshold / structural
# comparison at 1/10 scale / detail amount (neighbouring-pixel gradient) of both.
# ASCII only (PowerShell 5.1 decodes a BOM-less script with the ANSI code page, and
# non-ASCII bytes inside the C# block below break the compiler).
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public class ShotDiff {
  static byte[] Pixels(Bitmap bmp, out int stride, out int w, out int h) {
    w = bmp.Width; h = bmp.Height;
    BitmapData data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
    stride = data.Stride;
    byte[] buf = new byte[stride * h];
    Marshal.Copy(data.Scan0, buf, 0, buf.Length);
    bmp.UnlockBits(data);
    return buf;
  }
  static double Detail(Bitmap bmp) {
    int stride, w, h;
    byte[] p = Pixels(bmp, out stride, out w, out h);
    double sum = 0; long n = 0;
    for (int y = 0; y < h; y++) {
      int row = y * stride;
      for (int x = 0; x + 1 < w; x++) {
        int a = row + x * 4, b = a + 4;
        sum += Math.Abs(p[a] - p[b]) + Math.Abs(p[a + 1] - p[b + 1]) + Math.Abs(p[a + 2] - p[b + 2]);
        n++;
      }
    }
    return n > 0 ? sum / n : 0;
  }
  public static string Compare(string oldPath, string newPath, int tw, int th) {
    var sb = new StringBuilder();
    using (Bitmap oldBmp = new Bitmap(oldPath))
    using (Bitmap newFull = new Bitmap(newPath)) {
      sb.Append("old ").Append(oldBmp.Width).Append('x').Append(oldBmp.Height).Append('\n');
      sb.Append("new ").Append(newFull.Width).Append('x').Append(newFull.Height).Append('\n');
      if (oldBmp.Width != tw || oldBmp.Height != th) sb.Append("oldsize-unexpected\n");
      double ratioOld = (double)oldBmp.Width / oldBmp.Height;
      double ratioNew = (double)newFull.Width / newFull.Height;
      sb.Append("aspectmatch ").Append(Math.Abs(ratioOld - ratioNew) < 0.002 ? "yes" : "no").Append('\n');
      Bitmap shrunk = new Bitmap(oldBmp.Width, oldBmp.Height, PixelFormat.Format32bppRgb);
      using (Graphics g = Graphics.FromImage(shrunk)) {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.DrawImage(newFull, new Rectangle(0, 0, shrunk.Width, shrunk.Height));
      }
      int s1, s2, w1, h1, w2, h2;
      byte[] a = Pixels(oldBmp, out s1, out w1, out h1);
      byte[] b = Pixels(shrunk, out s2, out w2, out h2);
      long diff = 0, over = 0, n = 0; int max = 0;
      for (int y = 0; y < h1; y++) {
        for (int x = 0; x < w1; x++) {
          int oa = y * s1 + x * 4, ob = y * s2 + x * 4;
          int d = (Math.Abs(a[oa] - b[ob]) + Math.Abs(a[oa + 1] - b[ob + 1]) + Math.Abs(a[oa + 2] - b[ob + 2])) / 3;
          diff += d; if (d > 32) over++; if (d > max) max = d; n++;
        }
      }
      sb.Append("meanabs ").Append((diff / (double)n).ToString("F2")).Append('\n');
      sb.Append("over32pct ").Append((over * 100.0 / n).ToString("F2")).Append('\n');
      sb.Append("maxdiff ").Append(max).Append('\n');
      // Coarse-structure comparison: shrink both to 1/10 and compare again. Rasterization
      // differences (a line break moving by one character, a different anti-aliasing
      // algorithm) vanish at this scale. Only a real content change (layout, position,
      // an image swapped out) still shows up here.
      int cw = Math.Max(1, oldBmp.Width / 10), chh = Math.Max(1, oldBmp.Height / 10);
      using (Bitmap co = new Bitmap(cw, chh, PixelFormat.Format32bppRgb))
      using (Bitmap cn = new Bitmap(cw, chh, PixelFormat.Format32bppRgb)) {
        using (Graphics g = Graphics.FromImage(co)) { g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.DrawImage(oldBmp, new Rectangle(0, 0, cw, chh)); }
        using (Graphics g = Graphics.FromImage(cn)) { g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.DrawImage(newFull, new Rectangle(0, 0, cw, chh)); }
        int cs1, cs2, cw1, ch1, cw2, ch2;
        byte[] ca = Pixels(co, out cs1, out cw1, out ch1);
        byte[] cb = Pixels(cn, out cs2, out cw2, out ch2);
        long cdiff = 0, cover32 = 0, cn2 = 0;
        for (int y = 0; y < ch1; y++) {
          for (int x = 0; x < cw1; x++) {
            int oa = y * cs1 + x * 4, ob = y * cs2 + x * 4;
            int d = (Math.Abs(ca[oa] - cb[ob]) + Math.Abs(ca[oa + 1] - cb[ob + 1]) + Math.Abs(ca[oa + 2] - cb[ob + 2])) / 3;
            cdiff += d; if (d > 32) cover32++; cn2++;
          }
        }
        sb.Append("coarse10-meanabs ").Append((cdiff / (double)cn2).ToString("F2")).Append('\n');
        sb.Append("coarse10-over32pct ").Append((cover32 * 100.0 / cn2).ToString("F2")).Append('\n');
      }
      sb.Append("detail-old ").Append(Detail(oldBmp).ToString("F2")).Append('\n');
      sb.Append("detail-new(shrink) ").Append(Detail(shrunk).ToString("F2")).Append('\n');
      sb.Append("detail-new(full) ").Append(Detail(newFull).ToString("F2")).Append('\n');
      shrunk.Dispose();
    }
    return sb.ToString();
  }
}
'@
$text = [ShotDiff]::Compare($Old, $New, $TargetWidth, $TargetHeight)
[Console]::Out.Write($text)
