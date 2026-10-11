param(
  [Parameter(Mandatory = $true)][string]$Name,
  [int]$Timeout = 60000,
  [int]$Interval = 15,
  [int]$Stable = 400,
  [int]$ClientWidth = 1100,
  [int]$ClientHeight = 760,
  [string]$Mode = 'screen',
  [string]$Out = '',
  [string]$Shot = '',
  [string]$Ready = ''
)
# Screen-pixel paint witness. It never trusts any timestamp reported by the app under
# test: it only looks at the window manager and at the pixels on screen.
#
# Three external moments (all relative to the wstart epoch written below):
#   visible   the window really appeared on screen (IsWindowVisible + sane size)
#   firstink  document pixels first appeared in the client area (ink above threshold)
#   stable    client-area pixels stopped changing for $Stable ms (rendering settled)
#
# Why this exists: Typora ships with remote debugging switched off (it accepts
# --remote-debugging-port and never listens), so CDP cannot reach it. Screen pixels
# are the same ruler for both apps, and they are closer to "when did the user see the
# content" than a DOM reading is.
#
# Two details that are easy to get wrong:
#   1) This script must be started BEFORE the app under test: compiling the C# below
#      takes 1-2s, and doing that after the app started would be counted as open time.
#      The first thing it does is write the wstart epoch (and the -Ready marker).
#   2) Only the CLIENT area is sampled. Title bar and border pixels have nothing to do
#      with the document and would skew the ink threshold.
#
# mode screen = BitBlt the window off the screen (= what the user sees, window must be
# frontmost). mode print = PrintWindow(hwnd, dc, 2), unaffected by occlusion.
#
# ASCII only (PowerShell 5.1 decodes a BOM-less script with the ANSI code page, and
# non-ASCII bytes inside the C# block below break the compiler).
$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class PaintWitness {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

  const uint SWP_NOZORDER = 0x0004;

  static IntPtr found = IntPtr.Zero;
  static uint wantPid = 0;
  static bool OnWindow(IntPtr h, IntPtr p) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    if (pid != wantPid) return true;
    if (!IsWindowVisible(h) || IsIconic(h)) return true;
    RECT r; if (!GetWindowRect(h, out r)) return true;
    if (r.Right - r.Left < 200 || r.Bottom - r.Top < 150) return true;
    found = h; return false;
  }

  // Locate the instance by process name + "started after the epoch" only. Asking WMI
  // for the command line costs tens of ms per call, and inside a 15ms poll loop that
  // smears the moment the window appeared. One live instance at a time is a
  // precondition of this round (Typora is single-instance; MarkPilot waits for its
  // internal port to be released before the next launch).
  static IntPtr FindWindow(string procName, long notBeforeEpochMs, out int pidOut, out long startedAt) {
    pidOut = 0; startedAt = 0;
    foreach (Process proc in Process.GetProcessesByName(procName)) {
      long start;
      try { start = (long)(proc.StartTime.ToUniversalTime() - new DateTime(1970, 1, 1)).TotalMilliseconds; }
      catch { continue; }
      if (start < notBeforeEpochMs - 30000) continue;
      found = IntPtr.Zero; wantPid = (uint)proc.Id;
      EnumWindows(OnWindow, IntPtr.Zero);
      if (found != IntPtr.Zero) { pidOut = proc.Id; startedAt = start; return found; }
    }
    return IntPtr.Zero;
  }

  public static int FindPid(string procName, long notBefore) { int pid; long s; FindWindow(procName, notBefore, out pid, out s); return pid; }

  public static string Close(string procName, long notBefore) {
    int pid; long s; IntPtr h = FindWindow(procName, notBefore, out pid, out s);
    if (h == IntPtr.Zero) return "nohwnd";
    PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
    return "close-sent " + pid;
  }

  static long Now() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; }

  static void Grab(IntPtr hwnd, string mode, int cx, int cy, int cw, int ch,
                   ref Bitmap bmp, ref byte[] buf, ref int[] buckets, out int ink, out uint hash) {
    ink = -1; hash = 0;
    RECT wr; GetWindowRect(hwnd, out wr);
    int ww = wr.Right - wr.Left, wh = wr.Bottom - wr.Top;
    if (ww <= 0 || wh <= 0 || cw <= 10 || ch <= 10) return;
    if (bmp == null || bmp.Width != ww || bmp.Height != wh) {
      if (bmp != null) bmp.Dispose();
      bmp = new Bitmap(ww, wh, PixelFormat.Format32bppRgb);
    }
    using (Graphics g = Graphics.FromImage(bmp)) {
      if (mode == "print") {
        IntPtr dc = g.GetHdc();
        try { PrintWindow(hwnd, dc, 2); } finally { g.ReleaseHdc(dc); }
      } else {
        g.CopyFromScreen(wr.Left, wr.Top, 0, 0, new Size(ww, wh), CopyPixelOperation.SourceCopy);
      }
    }
    BitmapData data = bmp.LockBits(new Rectangle(0, 0, ww, wh), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
    int len = Math.Abs(data.Stride) * wh;
    if (buf == null || buf.Length < len) buf = new byte[len];
    Marshal.Copy(data.Scan0, buf, 0, len);
    int stride = data.Stride;
    bmp.UnlockBits(data);
    if (buckets == null) buckets = new int[32768];
    Array.Clear(buckets, 0, buckets.Length);
    int step = 4;
    int ox = Math.Max(0, cx - wr.Left), oy = Math.Max(0, cy - wr.Top);
    int maxY = Math.Min(oy + ch, wh), maxX = Math.Min(ox + cw, ww);
    for (int y = oy; y < maxY; y += step) {
      int row = y * stride;
      for (int x = ox; x < maxX; x += step) {
        int o = row + x * 4;
        buckets[((buf[o + 2] >> 3) << 10) | ((buf[o + 1] >> 3) << 5) | (buf[o] >> 3)]++;
      }
    }
    int best = 0, bestCount = -1;
    for (int i = 0; i < buckets.Length; i++) if (buckets[i] > bestCount) { bestCount = buckets[i]; best = i; }
    int br = ((best >> 10) & 31) << 3, bgc = ((best >> 5) & 31) << 3, bb = (best & 31) << 3;
    ink = 0; uint h2 = 2166136261;
    for (int y = oy; y < maxY; y += step) {
      int row = y * stride;
      for (int x = ox; x < maxX; x += step) {
        int o = row + x * 4;
        int b = buf[o], gg = buf[o + 1], rr = buf[o + 2];
        if (Math.Abs(rr - br) + Math.Abs(gg - bgc) + Math.Abs(b - bb) > 90) ink++;
        if (((x / step) + (y / step)) % 4 == 0) h2 = (h2 ^ (uint)(rr + gg * 3 + b * 7)) * 16777619;
      }
    }
    hash = h2;
  }

  static string Run(string procName, long notBefore, int timeoutMs, int intervalMs, int stableMs,
                    int clientW, int clientH, string mode, string shotPath) {
    var sb = new StringBuilder();
    sb.Append("wstart ").Append(Now()).Append('\n');
    var clock = Stopwatch.StartNew();
    Bitmap bmp = null; byte[] buf = null; int[] buckets = null;
    IntPtr hwnd = IntPtr.Zero;
    long visibleAt = -1, firstInkAt = -1, lastChangeAt = -1;
    int frames = 0, lastInk = -2, ink0 = -1, cw = 0, ch = 0, cx = 0, cy = 0;
    uint lastHash = 0; bool fg = false; string verdict = "timeout";
    while (clock.ElapsedMilliseconds < timeoutMs) {
      long now = clock.ElapsedMilliseconds;
      if (hwnd == IntPtr.Zero) {
        int pid; long started;
        hwnd = FindWindow(procName, notBefore, out pid, out started);
        if (hwnd == IntPtr.Zero) { Thread.Sleep(intervalMs); continue; }
        visibleAt = Now();
        sb.Append("visible ").Append(visibleAt).Append(" rel=").Append(now).Append(" pid=").Append(pid).Append('\n');
        SetForegroundWindow(hwnd);
        RECT wr, cr;
        GetWindowRect(hwnd, out wr); GetClientRect(hwnd, out cr);
        int dw = (wr.Right - wr.Left) - (cr.Right - cr.Left);
        int dh = (wr.Bottom - wr.Top) - (cr.Bottom - cr.Top);
        SetWindowPos(hwnd, IntPtr.Zero, 0, 0, clientW + dw, clientH + dh, SWP_NOZORDER);
        sb.Append("resized rel=").Append(clock.ElapsedMilliseconds).Append(" outer=").Append(clientW + dw).Append('x').Append(clientH + dh).Append('\n');
        Thread.Sleep(40);
        SetForegroundWindow(hwnd);
        continue;
      }
      POINT origin = new POINT(); origin.X = 0; origin.Y = 0;
      ClientToScreen(hwnd, ref origin);
      RECT cr2; GetClientRect(hwnd, out cr2);
      cw = cr2.Right - cr2.Left; ch = cr2.Bottom - cr2.Top; cx = origin.X; cy = origin.Y;
      int ink; uint hash; long grabbed = Now();
      Grab(hwnd, mode, cx, cy, cw, ch, ref bmp, ref buf, ref buckets, out ink, out hash);
      frames++;
      int samples = (cw / 4 + 1) * (ch / 4 + 1);
      int threshold = Math.Max(600, (int)(samples * 0.004));
      if (frames == 1) {
        ink0 = ink;
        sb.Append("firstframe t=").Append(grabbed).Append(" ink=").Append(ink).Append(" threshold=").Append(threshold)
          .Append(" client=").Append(cw).Append('x').Append(ch).Append(" at=").Append(cx).Append(',').Append(cy).Append('\n');
        if (ink >= threshold) { firstInkAt = visibleAt; sb.Append("firstink ").Append(visibleAt).Append(" ink=").Append(ink).Append(" note=already-painted\n"); }
      } else if (firstInkAt < 0 && ink >= threshold) {
        firstInkAt = grabbed;
        sb.Append("firstink ").Append(grabbed).Append(" ink=").Append(ink).Append('\n');
      }
      if (ink != lastInk || hash != lastHash) { lastChangeAt = Now(); lastInk = ink; lastHash = hash; }
      else if (firstInkAt >= 0 && Now() - lastChangeAt >= stableMs) {
        sb.Append("stable ").Append(lastChangeAt).Append(" ink=").Append(ink).Append('\n');
        verdict = "done"; break;
      }
      if (GetForegroundWindow() == hwnd) fg = true;
      Thread.Sleep(intervalMs);
    }
    sb.Append("frames ").Append(frames).Append('\n');
    sb.Append("foreground ").Append(fg ? "yes" : "no").Append('\n');
    sb.Append("verdict ").Append(verdict).Append('\n');
    if (shotPath != null && shotPath.Length > 0 && bmp != null) {
      try { bmp.Save(shotPath, ImageFormat.Png); sb.Append("shot ").Append(shotPath).Append('\n'); }
      catch (Exception e) { sb.Append("shotfail ").Append(e.Message).Append('\n'); }
    }
    if (bmp != null) bmp.Dispose();
    return sb.ToString();
  }

  public static string Watch(string procName, long notBefore, int timeoutMs, int intervalMs, int stableMs,
                             int clientW, int clientH, string mode, string shotPath) {
    try { return Run(procName, notBefore, timeoutMs, intervalMs, stableMs, clientW, clientH, mode, shotPath); }
    catch (Exception e) { return "error " + e.GetType().Name + ": " + e.Message; }
  }
}
'@

# Compilation must be finished before the clock starts: the caller waits for this
# marker and only then launches the app, otherwise the 1-2s Add-Type cost would be
# counted as open time.
if ($Ready -ne '') { [System.IO.File]::WriteAllText($Ready, 'ready') }
$notBefore = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$result = [PaintWitness]::Watch($Name, $notBefore, $Timeout, $Interval, $Stable, $ClientWidth, $ClientHeight, $Mode, $Shot)
if ($Out -ne '') { [System.IO.File]::WriteAllText($Out, $result, (New-Object System.Text.UTF8Encoding($false))) }
[Console]::Out.Write($result)
