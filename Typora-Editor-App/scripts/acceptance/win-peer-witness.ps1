param(
  [Parameter(Mandatory = $true)][string]$Name,
  [int]$Timeout = 90000,
  [int]$Interval = 10,
  [int]$Stable = 400,
  [int]$ClientWidth = 1100,
  [int]$ClientHeight = 760,
  [int]$RegionX0Pct = 40,
  [int]$RegionY0Pct = 25,
  [int]$Resize = 1,
  [int]$TypeKeys = 0,
  [int]$ScrollNotches = 0,
  [int]$WheelStep = 120,
  [int]$Calibrate = 0,
  [int]$Close = 0,
  [int]$ClickFormula = 0,
  [int]$ClickNotches = 3,
  [string]$Mode = 'print',
  [string]$Out = '',
  [string]$Shot = '',
  [string]$ShotOpen = '',
  [string]$Ready = ''
)
# Peer-comparison witness: measures "what the user sees" from outside the app, with one
# ruler for every app under test. Never reads a timestamp produced by the app.
#
# Primary measurement: Open() phases.
#   1) locate the window (IsWindowVisible, sane size)
#   2) optionally force a fixed client size, so two apps are measured at the same
#      viewport (Typora otherwise restores its own remembered geometry and the two
#      runs would not be comparable at all)
#   3) sample the DOCUMENT REGION of the client area every $Interval ms and record,
#      per frame: ink (pixels far from the modal background) and the number of samples
#      that changed since the previous frame
#
# The document region starts at (RegionX0Pct, RegionY0Pct) of the client area. Why a
# region and not the whole window: both apps paint their chrome (menu bar, toolbar,
# sidebar) BEFORE the document, and chrome pixels would cross any ink threshold on
# their own -- which reads as "the document is on screen" when it is not.
#
# Which frame counts as "content on screen" is decided afterwards, from the frame
# series (Node side): the first frame whose ink reaches 30% of the settled ink. Doing
# it from the series keeps the definition inspectable instead of hidden in a threshold.
#
# Changed-sample counting rather than a frame hash: the caret blinks, and a hash would
# never let the picture "settle". A caret is 1-2 px wide and moves a handful of samples;
# real content changes move many more.
#
# Optional phases, same ruler for both apps (heavier work, so off by default):
#   -TypeKeys N    after the open phase: Ctrl+End, then N single-character keystrokes,
#                  each timed from SendInput to the first frame that shows the change
#   -ScrollNotches N  after the open phase: Ctrl+Home, then N wheel notches, measuring
#                  how many distinct screen states appear and the largest gap between
#                  them (a coarse dropped-frame proxy) until the picture settles again
#
# ASCII only: PowerShell 5.1 decodes a BOM-less script with the ANSI code page and
# non-ASCII bytes inside the C# block below break the compiler.
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

public class Peer {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public MOUSEINPUT mi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern int GetWindowTextW(IntPtr h, [Out] char[] text, int max);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool SwitchToThisWindow(IntPtr h, bool alt);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);

  static void KeybdEvent(byte vk, byte scan, uint flags) { keybd_event(vk, scan, flags, IntPtr.Zero); }
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

  const uint SWP_NOZORDER = 0x0004;
  const uint SWP_NOSIZE = 0x0001;
  const uint SWP_NOMOVE = 0x0002;
  const uint MOUSEEVENTF_MOVE = 0x0001;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  const uint MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
  const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint MOUSEEVENTF_WHEEL = 0x0800;
  const int VK_CONTROL = 0x11, VK_END = 0x23, VK_HOME = 0x24;
  const int SAMPLE_STEP = 2;
  const int LUMA_DIFF = 40;

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

  // Locate the instance by process name + "started after the epoch" only: asking WMI for
  // the command line costs tens of ms and would smear the moment the window appeared.
  // One live instance at a time is a precondition of this round.
  static IntPtr FindWindow(string procName, long notBeforeEpochMs, out int pidOut) {
    pidOut = 0;
    foreach (Process proc in Process.GetProcessesByName(procName)) {
      long start;
      try { start = (long)(proc.StartTime.ToUniversalTime() - new DateTime(1970, 1, 1)).TotalMilliseconds; }
      catch { continue; }
      if (start < notBeforeEpochMs - 30000) continue;
      found = IntPtr.Zero; wantPid = (uint)proc.Id;
      EnumWindows(OnWindow, IntPtr.Zero);
      if (found != IntPtr.Zero) { pidOut = proc.Id; return found; }
    }
    return IntPtr.Zero;
  }

  public static string Close(string procName, long notBefore) {
    int pid; IntPtr h = FindWindow(procName, notBefore, out pid);
    if (h == IntPtr.Zero) return "nohwnd";
    PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
    return "close-sent " + pid;
  }

  static long Now() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; }

  // Sampler over the document region only. Keeps two luma buffers so "how many samples
  // changed" is a cheap array comparison instead of a hash.
  class Sampler {
    public IntPtr hwnd;
    public string mode = "screen";
    public int x0, y0, w, h, sw, sh;
    Bitmap bmp; byte[] pix;
    public byte[] cur, prev;
    public int ink, changed, bg;
    bool have;
    public void Measure() {
      RECT wr; GetWindowRect(hwnd, out wr);
      int ww = wr.Right - wr.Left, wh = wr.Bottom - wr.Top;
      if (ww <= 0 || wh <= 0) { ink = -1; changed = -1; return; }
      if (bmp == null || bmp.Width != ww || bmp.Height != wh) {
        if (bmp != null) bmp.Dispose();
        bmp = new Bitmap(ww, wh, PixelFormat.Format32bppRgb);
      }
      using (Graphics g = Graphics.FromImage(bmp)) {
        if (mode == "print") {
          // PrintWindow(..., 2) = PW_RENDERFULLCONTENT: the window renders itself into our
          // DC, so the result does not depend on z-order or occlusion. CopyFromScreen does:
          // on 2026-09-11 it captured whatever window happened to be on top (the user's
          // editor, while they were typing), and the run silently produced numbers for
          // the wrong picture. Any measurement taken while the machine is in use needs this.
          IntPtr dc = g.GetHdc();
          try { PrintWindow(hwnd, dc, 2); } finally { g.ReleaseHdc(dc); }
        } else {
          g.CopyFromScreen(wr.Left, wr.Top, 0, 0, new Size(ww, wh), CopyPixelOperation.SourceCopy);
        }
      }
      BitmapData data = bmp.LockBits(new Rectangle(0, 0, ww, wh), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
      int len = Math.Abs(data.Stride) * wh;
      if (pix == null || pix.Length < len) pix = new byte[len];
      Marshal.Copy(data.Scan0, pix, 0, len);
      int stride = data.Stride;
      bmp.UnlockBits(data);
      // Client origin relative to the window: the region must not include chrome.
      POINT origin = new POINT(); origin.X = 0; origin.Y = 0;
      ClientToScreen(hwnd, ref origin);
      RECT cr; GetClientRect(hwnd, out cr);
      int cw = cr.Right - cr.Left, ch = cr.Bottom - cr.Top;
      int ox = origin.X - wr.Left, oy = origin.Y - wr.Top;
      x0 = ox + cw * RegionX0 / 100; y0 = oy + ch * RegionY0 / 100;
      w = Math.Max(1, ox + cw - x0); h = Math.Max(1, oy + ch - y0);
      sw = w / SAMPLE_STEP + 1; sh = h / SAMPLE_STEP + 1;
      if (cur == null || cur.Length < sw * sh) { cur = new byte[sw * sh]; prev = new byte[sw * sh]; have = false; }
      int[] hist = new int[256];
      int n = 0;
      for (int y = 0; y < h; y += SAMPLE_STEP) {
        int row = (y0 + y) * stride;
        for (int x = 0; x < w; x += SAMPLE_STEP) {
          int o = row + (x0 + x) * 4;
          int luma = (pix[o + 2] * 77 + pix[o + 1] * 151 + pix[o] * 28) >> 8;
          cur[n++] = (byte)luma;
          hist[luma]++;
        }
      }
      int best = 0, bestCount = -1;
      for (int i = 0; i < 256; i++) if (hist[i] > bestCount) { bestCount = hist[i]; best = i; }
      bg = best;
      ink = 0;
      for (int i = 0; i < n; i++) if (Math.Abs(cur[i] - bg) > 60) ink++;
      changed = -1;
      if (have) {
        int c = 0;
        for (int i = 0; i < n; i++) { int d = cur[i] - prev[i]; if (d > LUMA_DIFF || d < -LUMA_DIFF) c++; }
        changed = c;
      }
      byte[] tmp = prev; prev = cur; cur = tmp;
      have = true;
    }
    public void Save(string path) { if (bmp != null) bmp.Save(path, ImageFormat.Png); }
    public void Dispose() { if (bmp != null) bmp.Dispose(); }
  }

  static int RegionX0 = 40, RegionY0 = 25;
  static string shotOpenPath = "";
  // Formula-click scenario: after the document settles, Ctrl+End, scroll up _gotoNotches_,
  // then click the centre of the document region and time the expansion.
  static int formulaClick = 0;
  static int gotoNotches = 3;
  // Ink floor: "there is a document on the screen". A blank editor is a perfectly stable
  // picture, so without this floor the settle detector declares victory on an empty page
  // and reports how fast the *blank* appeared (that is exactly what it did on the first
  // run: markpilot large "settled" at ink=0, 228 ms after spawn).
  const int INK_FLOOR = 600;
  // Changed-sample thresholds. A blinking caret or a re-antialiased glyph moves a handful
  // of samples; a formula expanding into its source replaces hundreds. Keeping the two
  // apart is what stops "the caret blinked" from being reported as "the formula opened".
  const int QUIET_MAX = 30;
  const int CHANGE_MIN = 80;

  // SendInput returns how many events it actually inserted; 0 means the injection was
  // refused outright (UIPI blocks injection into a higher-integrity foreground window).
  // That number is the difference between "the app ignored the click" and "no click happened".
  static uint SendInputs(INPUT[] inputs) { return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }
  static string CursorAt() {
    POINT p; if (!GetCursorPos(out p)) return "?";
    return p.X + "," + p.Y;
  }

  // Put the window above everything without giving it the keyboard focus.
  static void Raise(IntPtr hwnd) {
    SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
  }

  // Is the foreground window ours? Exact handle, or any window of the same process
  // (the app may put up its own child window: a dialog, a popup).
  static bool OwnsForeground(IntPtr hwnd) {
    IntPtr fg = GetForegroundWindow();
    if (fg == IntPtr.Zero) return false;
    if (fg == hwnd) return true;
    uint a, b;
    GetWindowThreadProcessId(fg, out a);
    GetWindowThreadProcessId(hwnd, out b);
    return a != 0 && a == b;
  }

  static string ForegroundTitle() {
    IntPtr fg = GetForegroundWindow();
    if (fg == IntPtr.Zero) return "(none)";
    char[] buffer = new char[120];
    int n = GetWindowTextW(fg, buffer, buffer.Length);
    string title = new string(buffer, 0, Math.Max(0, n));
    uint pid; GetWindowThreadProcessId(fg, out pid);
    return title + " [pid " + pid + "]";
  }

  // Acquisition has to survive Windows' foreground lock: a background process is not
  // allowed to steal the foreground on its own, so attach to the current foreground
  // thread first, then ask. Returns whether the foreground is now ours.
  static bool EnsureForeground(IntPtr hwnd, int tries) {
    for (int i = 0; i < tries; i++) {
      if (OwnsForeground(hwnd)) return true;
      IntPtr fg = GetForegroundWindow();
      // No "out uint _": PowerShell 5.1's Add-Type compiles as C# 5, which has no discards.
      uint fgThread = 0;
      if (fg != IntPtr.Zero) { uint ignoredPid; fgThread = GetWindowThreadProcessId(fg, out ignoredPid); }
      uint myThread = GetCurrentThreadId();
      bool attached = false;
      try {
        if (fgThread != 0 && fgThread != myThread) attached = AttachThreadInput(myThread, fgThread, true);
        // A lone ALT tap is the documented way past Windows' foreground lock: the window
        // that owns the last input event is allowed to set the foreground. Without it, an
        // always-on-top window that currently holds the foreground keeps it, and the capture
        // stays flat (measured: 12 rescue attempts, every frame ink 0).
        if (i >= 2) { KeybdEvent(0x12, 0, 0); }
        ShowWindow(hwnd, 5);          // SW_SHOW
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);
        SwitchToThisWindow(hwnd, true);
        if (i >= 2) { KeybdEvent(0x12, 0, KEYEVENTF_KEYUP); }
      } finally {
        if (attached) AttachThreadInput(myThread, fgThread, false);
      }
      Thread.Sleep(40);
    }
    // Activation is asynchronous: the window reports itself foreground before the app has
    // moved keyboard focus into its editor. Sending input in that gap is what made an
    // earlier version's Ctrl+End vanish (measured: focusInside=false, activeElement=BODY,
    // so the chord went to the shell and the document never moved).
    if (OwnsForeground(hwnd)) Thread.Sleep(250);
    return OwnsForeground(hwnd);
  }

  static INPUT Key(ushort vk, bool up) {
    INPUT i = new INPUT(); i.type = 1; i.U.ki.wVk = vk; i.U.ki.wScan = 0;
    i.U.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0; return i;
  }
  static INPUT Wheel(int delta) {
    INPUT i = new INPUT(); i.type = 0; i.U.mi.dwFlags = MOUSEEVENTF_WHEEL; i.U.mi.mouseData = (uint)delta; return i;
  }

  static INPUT Mouse(uint flags, int ax, int ay) {
    INPUT i = new INPUT(); i.type = 0;
    i.U.mi.dx = ax; i.U.mi.dy = ay; i.U.mi.mouseData = 0; i.U.mi.dwFlags = flags;
    return i;
  }

  // A real mouse click at absolute screen coordinates, through the same channel a user's
  // click takes. Virtual-desktop normalisation (0..65535) is what SendInput wants.
  static uint ClickAt(int sx, int sy) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77);
    int vw = Math.Max(1, GetSystemMetrics(78) - 1), vh = Math.Max(1, GetSystemMetrics(79) - 1);
    int ax = (int)((long)(sx - vx) * 65535 / vw);
    int ay = (int)((long)(sy - vy) * 65535 / vh);
    uint flags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    return SendInputs(new INPUT[] {
      Mouse(MOUSEEVENTF_MOVE | flags, ax, ay),
      Mouse(MOUSEEVENTF_LEFTDOWN | flags, ax, ay),
      Mouse(MOUSEEVENTF_LEFTUP | flags, ax, ay),
    });
  }

  static uint Chord(int vk, int code) {
    return SendInputs(new INPUT[] { Key((ushort)VK_CONTROL, false), Key((ushort)code, false), Key((ushort)code, true), Key((ushort)VK_CONTROL, true) });
  }

  static string captureMode = "print";

  public static string Run(string procName, long notBefore, int timeoutMs, int intervalMs, int stableMs,
                           int clientW, int clientH, int resize, int typeKeys, int scrollNotches, int wheelStep,
                           int clickFormula, int clickNotches, string shotPath) {
    var sb = new StringBuilder();
    sb.Append("wstart ").Append(Now()).Append('\n');
    var clock = Stopwatch.StartNew();
    IntPtr hwnd = IntPtr.Zero;
    Sampler sampler = null;
    long visibleAt = -1; int frames = 0; bool fg = false;
    string verdict = "timeout";
    long stableAt = -1; int settledInk = -1; int quietSince = -1; string phase = "open";
    int sizeFixes = 0;
    int maxInk = 0;
    int[] resizeRelays = new int[] { 150, 400, 900, 1600, 2600, 4000 };
    var keyLat = new List<int>();
    int scrollSpans = 0; int scrollMaxGap = 0; long scrollStart = -1; long lastSpanAt = -1;
    int scrollLeft = 0;
    bool inputUsed = false;
    int gotoLeft = gotoNotches;
    long gotoStart = -1;
    long clickAt = -1, clickChangeAt = -1;
    int clickInkBefore = -1;
    int clickIndex = 0, clickChMax = 0;
    long lastRescue = 0;
    int rescues = 0;
    int[] clickFractions = new int[] { 35, 55, 72 };
    int[][] clickPoints = null;
    try {
      while (clock.ElapsedMilliseconds < timeoutMs) {
        long now = clock.ElapsedMilliseconds;
        if (hwnd == IntPtr.Zero) {
          int pid; hwnd = FindWindow(procName, notBefore, out pid);
          if (hwnd == IntPtr.Zero) { Thread.Sleep(intervalMs); continue; }
          visibleAt = Now();
          sb.Append("visible ").Append(visibleAt).Append(" rel=").Append(now).Append(" pid=").Append(pid).Append('\n');
          // Raise without focusing. Screen capture needs the window unoccluded, but it
          // must NOT need the keyboard focus: stealing focus during the open phase would
          // both distort the measurement and put keystrokes at risk later.
          Raise(hwnd);
          sb.Append("raised rel=").Append(clock.ElapsedMilliseconds).Append('\n');
          if (resize == 1) {
            RECT wr, cr;
            GetWindowRect(hwnd, out wr); GetClientRect(hwnd, out cr);
            int dw = (wr.Right - wr.Left) - (cr.Right - cr.Left);
            int dh = (wr.Bottom - wr.Top) - (cr.Bottom - cr.Top);
            SetWindowPos(hwnd, IntPtr.Zero, 0, 0, clientW + dw, clientH + dh, SWP_NOZORDER);
            sb.Append("resize rel=").Append(clock.ElapsedMilliseconds).Append(" outer=").Append(clientW + dw).Append('x').Append(clientH + dh).Append('\n');
            Thread.Sleep(40);
            Raise(hwnd);
          }
          sampler = new Sampler(); sampler.hwnd = hwnd; sampler.mode = captureMode;
          continue;
        }
        // An app that restores its own remembered geometry can overrule the resize we
        // made a moment after the window appeared (Typora does exactly that). Re-apply
        // it on a bounded schedule, and log every attempt: the log is what proves the
        // two apps really were measured at the same viewport, or exposes that they were
        // not. Attempts stop once the size sticks.
        if (resize == 1 && (sizeFixes < resizeRelays.Length && clock.ElapsedMilliseconds >= resizeRelays[sizeFixes])) {
          RECT wr2, cr3;
          GetWindowRect(hwnd, out wr2); GetClientRect(hwnd, out cr3);
          if (cr3.Right - cr3.Left != clientW || cr3.Bottom - cr3.Top != clientH) {
            int dw2 = (wr2.Right - wr2.Left) - (cr3.Right - cr3.Left);
            int dh2 = (wr2.Bottom - wr2.Top) - (cr3.Bottom - cr3.Top);
            SetWindowPos(hwnd, IntPtr.Zero, 0, 0, clientW + dw2, clientH + dh2, SWP_NOZORDER);
            sb.Append("resizefix n=").Append(sizeFixes + 1).Append(" rel=").Append(clock.ElapsedMilliseconds)
              .Append(" was=").Append(cr3.Right - cr3.Left).Append('x').Append(cr3.Bottom - cr3.Top).Append('\n');
          }
          sizeFixes++;
        }
        sampler.Measure();
        frames++;
        // Occlusion rescue, on demand only. PrintWindow returns a flat image when the window
        // is completely covered (measured 2026-09-11: 3249 frames of ink 0 while another
        // always-on-top window held the foreground), and SetWindowPos(HWND_TOPMOST) is a
        // no-op for a window that is already topmost -- the active window stays above it.
        // So: when the capture comes back flat, activate and re-raise, then carry on. Doing
        // this unconditionally would fight the user for focus for the whole run.
        if (sampler.ink == 0 && frames >= 3 && rescues < 12 && Now() - lastRescue > 800) {
          lastRescue = Now(); rescues++;
          Raise(hwnd); EnsureForeground(hwnd, 3);
          sb.Append("rescue n=").Append(rescues).Append(" rel=").Append(now)
            .Append(" foregroundwas=").Append(ForegroundTitle()).Append('\n');
        }
        if (frames % 20 == 0) Raise(hwnd);
        RECT cr2; GetClientRect(hwnd, out cr2);
        int cw = cr2.Right - cr2.Left, ch = cr2.Bottom - cr2.Top;
        if (OwnsForeground(hwnd)) fg = true;
        if (frames == 1) sb.Append("firstframe t=").Append(Now()).Append(" ink=").Append(sampler.ink)
          .Append(" region=").Append(sampler.sw).Append('x').Append(sampler.sh)
          .Append(" client=").Append(cw).Append('x').Append(ch).Append('\n');
        sb.Append("frame ").Append(Now()).Append(" rel=").Append(now).Append(" ink=").Append(sampler.ink)
          .Append(" ch=").Append(sampler.changed).Append(" c=").Append(cw).Append('x').Append(ch).Append('\n');

        bool quiet = sampler.changed >= 0 && sampler.changed < QUIET_MAX && sampler.ink >= INK_FLOOR;
        if (quiet) { if (quietSince < 0) quietSince = (int)now; }
        else quietSince = -1;
        if (sampler.ink > maxInk) maxInk = sampler.ink;
        // Never captured anything after 25 s: the window is being covered by something we
        // cannot get in front of. Bail out now instead of burning the full 120 s timeout.
        if (frames > 200 && clock.ElapsedMilliseconds > 25000 && maxInk < INK_FLOOR) {
          sb.Append("nocapture maxink=").Append(maxInk).Append(" foreground=").Append(ForegroundTitle()).Append('\n');
          verdict = "timeout-nocapture"; break;
        }

        if (phase == "open") {
          if (quietSince >= 0 && now - quietSince >= stableMs) {
            stableAt = Now(); settledInk = sampler.ink;
            sb.Append("stable ").Append(stableAt).Append(" rel=").Append(now).Append(" ink=").Append(settledInk).Append('\n');
            // Snapshot at the moment content settled: this is the only way to check
            // afterwards that both apps were really showing the same fixture (Typora is
            // single-window and keeps tabs around; a stale active tab would otherwise go
            // unnoticed and quietly invalidate the comparison).
            if (shotOpenPath != null && shotOpenPath.Length > 0) { try { sampler.Save(shotOpenPath); sb.Append("shotopen ").Append(shotOpenPath).Append('\n'); } catch (Exception e) { sb.Append("shotopenfail ").Append(e.Message).Append('\n'); } }
            if (formulaClick > 0) {
              // Checked BEFORE scrollNotches: the click scenario drives its own scroll
              // through -ClickNotches, and an earlier version let the plain scroll branch
              // win here, so "click the formula" silently measured a scroll instead.
              if (!EnsureForeground(hwnd, 12)) {
                sb.Append("inputskipped reason=foreground-not-acquired foreground=").Append(ForegroundTitle()).Append('\n');
                verdict = "done"; break;
              }
              // Click candidates: down the middle of the sampled region, so at least one is
              // likely to land inside the formula block rather than on blank space or on the
              // empty strip under the last line.
              POINT origin2 = new POINT(); origin2.X = 0; origin2.Y = 0;
              ClientToScreen(hwnd, ref origin2);
              RECT crc; GetClientRect(hwnd, out crc);
              int rw = crc.Right - crc.Left, rh = crc.Bottom - crc.Top;
              int rx0 = origin2.X + rw * RegionX0 / 100, ry0 = origin2.Y + rh * RegionY0 / 100;
              int rwidth = rw - rw * RegionX0 / 100, rheight = rh - rh * RegionY0 / 100;
              clickPoints = new int[clickFractions.Length][];
              for (int i = 0; i < clickFractions.Length; i++) {
                clickPoints[i] = new int[] { rx0 + rwidth / 2, ry0 + rheight * clickFractions[i] / 100 };
              }
              // Focus click first. Document editors keep the caret in their own iframe and
              // only give that iframe keyboard focus once you click inside it; without this,
              // Ctrl+End is delivered to the shell and nothing moves.
              uint focusSent = ClickAt(clickPoints[1][0], clickPoints[1][1]);
              sb.Append("focusclick at=").Append(clickPoints[1][0]).Append(',').Append(clickPoints[1][1])
                .Append(" sent=").Append(focusSent).Append(" cursor=").Append(CursorAt()).Append('\n');
              inputUsed = true;
              Thread.Sleep(500);
              phase = "goto"; gotoStart = Now();
              uint chordSent = Chord(VK_CONTROL, VK_END);
              sb.Append("gotobegin ").Append(gotoStart).Append(" notches=").Append(gotoNotches)
                .Append(" chordsent=").Append(chordSent).Append(" cursor=").Append(CursorAt()).Append('\n');
              Thread.Sleep(1500); sampler.Measure(); Thread.Sleep(250);
              quietSince = -1;
              continue;
            }
            if (scrollNotches > 0) {
              if (!EnsureForeground(hwnd, 12)) {
                sb.Append("inputskipped reason=foreground-not-acquired foreground=").Append(ForegroundTitle()).Append('\n');
                verdict = "done"; break;
              }
              phase = "scroll"; Chord(VK_CONTROL, VK_HOME);
              Thread.Sleep(900); sampler.Measure(); Thread.Sleep(200);
              scrollStart = Now(); lastSpanAt = scrollStart; scrollLeft = scrollNotches;
              sb.Append("scrollbegin ").Append(scrollStart).Append(" notches=").Append(scrollNotches).Append('\n');
              quietSince = -1;
              continue;
            }
            if (typeKeys > 0) {
              if (!EnsureForeground(hwnd, 12)) {
                sb.Append("inputskipped reason=foreground-not-acquired foreground=").Append(ForegroundTitle()).Append('\n');
                verdict = "done"; break;
              }
              phase = "type"; Chord(VK_CONTROL, VK_END);
              Thread.Sleep(900); sampler.Measure();
              sb.Append("typebegin ").Append(Now()).Append(" keys=").Append(typeKeys).Append('\n');
              quietSince = -1;
              continue;
            }
            verdict = "done"; break;
          }
          Thread.Sleep(intervalMs);
          continue;
        }

        if (phase == "goto") {
          // Scroll up a few notches so the click target sits well inside the formula block
          // (and so this really is a scroll, not just a jump).
          if (gotoLeft > 0) {
            if (!OwnsForeground(hwnd)) {
              sb.Append("gotoabort after=").Append(gotoNotches - gotoLeft).Append(" foreground=").Append(ForegroundTitle()).Append('\n');
              gotoLeft = 0; verdict = "done"; break;
            }
            SendInputs(new INPUT[] { Wheel(wheelStep) });   // positive delta = scroll up
            gotoLeft--;
            inputUsed = true;
            Thread.Sleep(25);
            continue;
          }
          if (quietSince >= 0 && now - quietSince >= stableMs || (gotoStart > 0 && Now() - gotoStart > 20000)) {
            // A 20 s cap: a huge document can keep repainting its newly-revealed tail for a
            // long time, and an unbounded wait would burn the whole timeout budget without
            // producing a number.
            if (Now() - gotoStart > 20000) sb.Append("gotoslow ").Append(Now() - gotoStart).Append(" ink=").Append(sampler.ink).Append('\n');
            if (!EnsureForeground(hwnd, 12)) {
              sb.Append("inputskipped reason=foreground-not-acquired foreground=").Append(ForegroundTitle()).Append('\n');
              verdict = "done"; break;
            }
            if (clickPoints == null) { verdict = "done"; break; }
            if (shotOpenPath != null && shotOpenPath.Length > 0) { try { sampler.Save(shotOpenPath); } catch {} }
            quietSince = -1;
            clickIndex = 0;
            clickAt = Now(); clickInkBefore = sampler.ink; clickChangeAt = -1; clickChMax = 0;
            sb.Append("clickbegin ").Append(clickAt).Append(" points=").Append(clickFractions.Length)
              .Append(" at=").Append(clickPoints[0][0]).Append(',').Append(clickPoints[0][1])
              .Append(" inkbefore=").Append(clickInkBefore).Append('\n');
            uint sent0 = ClickAt(clickPoints[0][0], clickPoints[0][1]);
            sb.Append("clickcursor at=").Append(CursorAt()).Append(" sent=").Append(sent0).Append('\n');
            inputUsed = true;
            phase = "click";
            continue;
          }
          Thread.Sleep(intervalMs);
          continue;
        }

        if (phase == "click") {
          // Time one click, from mouse-up to the first frame that shows a change, and on to
          // the frame where the layout stops moving. Several candidate points are tried
          // down the middle of the document region: a click that lands on plain text only
          // moves a caret (a handful of samples), while expanding a formula replaces its
          // rendered glyphs with source text (hundreds to thousands of samples). The
          // changed-sample count is what tells the two apart afterwards, so a mis-aimed
          // click cannot masquerade as "the formula opened in 30 ms".
          if (clickIndex >= clickFractions.Length) { verdict = "done"; break; }
          if (clickChangeAt < 0 && sampler.changed >= CHANGE_MIN) {
            clickChangeAt = Now();
            if (sampler.changed > clickChMax) clickChMax = sampler.changed;
          }
          if (clickChangeAt >= 0 && sampler.changed > clickChMax) clickChMax = sampler.changed;
          if (clickChangeAt >= 0 && quietSince >= 0 && now - quietSince >= stableMs) {
            long ended = Now();
            sb.Append("clickpoint i=").Append(clickIndex + 1)
              .Append(" ypct=").Append(clickFractions[clickIndex])
              .Append(" change=").Append(clickChangeAt - clickAt)
              .Append(" settle=").Append(ended - clickAt)
              .Append(" inkbefore=").Append(clickInkBefore)
              .Append(" inkafter=").Append(sampler.ink)
              .Append(" chmax=").Append(clickChMax).Append('\n');
            clickIndex++;
            clickChangeAt = -1; clickChMax = 0; quietSince = -1;
            if (clickIndex >= clickFractions.Length) {
              if (shotPath != null && shotPath.Length > 0) { try { sampler.Save(shotPath); } catch {} }
              verdict = "done"; break;
            }
            Thread.Sleep(400);
            continue;
          }
          if (clickChangeAt < 0 && Now() - clickAt > 3000) {
            // Nothing measurable came of that click; move to the next candidate point.
            sb.Append("clickpoint i=").Append(clickIndex + 1)
              .Append(" ypct=").Append(clickFractions[clickIndex])
              .Append(" change=-1 settle=-1 inkbefore=").Append(clickInkBefore)
              .Append(" inkafter=").Append(sampler.ink).Append(" chmax=").Append(clickChMax).Append('\n');
            clickIndex++;
            clickChangeAt = -1; clickChMax = 0; quietSince = -1;
            if (clickIndex >= clickFractions.Length) { verdict = "done"; break; }
            clickAt = Now(); clickInkBefore = sampler.ink;
            ClickAt(clickPoints[clickIndex][0], clickPoints[clickIndex][1]);
            inputUsed = true;
            Thread.Sleep(400);
            continue;
          }
          Thread.Sleep(1);
          continue;
        }

        if (phase == "scroll") {
          if (scrollLeft > 0) {
            // Re-checked before every single notch, not just at phase entry.
            if (!OwnsForeground(hwnd)) {
              sb.Append("scrollabort after=").Append(scrollNotches - scrollLeft).Append(" foreground=").Append(ForegroundTitle()).Append('\n');
              scrollLeft = 0; verdict = "done"; break;
            }
            SendInputs(new INPUT[] { Wheel(-wheelStep) });
            inputUsed = true;
            scrollLeft--;
            Thread.Sleep(12);
            continue;
          }
          if (sampler.changed >= CHANGE_MIN) {
            long at = Now();
            scrollSpans++;
            int gap = (int)(at - lastSpanAt);
            if (scrollSpans > 1 && gap > scrollMaxGap) scrollMaxGap = gap;
            lastSpanAt = at;
            quietSince = -1;
          }
          if (quietSince >= 0 && now - quietSince >= stableMs) {
            sb.Append("scrollend ").Append(lastSpanAt).Append(" spans=").Append(scrollSpans)
              .Append(" maxgap=").Append(scrollMaxGap).Append(" total=").Append(lastSpanAt - scrollStart).Append('\n');
            if (typeKeys > 0) {
              if (!EnsureForeground(hwnd, 12)) {
                sb.Append("inputskipped reason=foreground-not-acquired foreground=").Append(ForegroundTitle()).Append('\n');
                verdict = "done"; break;
              }
              phase = "type"; Chord(VK_CONTROL, VK_END);
              Thread.Sleep(900); sampler.Measure();
              sb.Append("typebegin ").Append(Now()).Append(" keys=").Append(typeKeys).Append('\n');
              quietSince = -1;
              continue;
            }
            verdict = "done"; break;
          }
          Thread.Sleep(intervalMs);
          continue;
        }

        if (phase == "type") {
          // Wait for a settled picture, then time one keystroke to the first visible
          // change. Polling faster than $Interval here: the whole point is the delay.
          if (quietSince < 0 || now - quietSince < 250) { Thread.Sleep(6); continue; }
          if (sampler.ink < 0) { Thread.Sleep(6); continue; }
          if (!OwnsForeground(hwnd)) {
            // The user (or the OS) took the foreground away mid-phase. Stop sending
            // immediately; a keystroke would land in whatever is in front now.
            sb.Append("typeabort after=").Append(keyLat.Count).Append(" foreground=").Append(ForegroundTitle()).Append('\n');
            verdict = "done"; break;
          }
          long t0 = Now();
          SendInputs(new INPUT[] { Key(0x58, false), Key(0x58, true) });
          inputUsed = true;
          int lat = -1;
          var spin = Stopwatch.StartNew();
          while (spin.ElapsedMilliseconds < 4000) {
            sampler.Measure();
            if (sampler.changed >= 6) { lat = (int)(Now() - t0); break; }
            Thread.Sleep(1);
          }
          keyLat.Add(lat);
          sb.Append("key i=").Append(keyLat.Count).Append(" lat=").Append(lat).Append('\n');
          quietSince = -1;
          if (keyLat.Count >= typeKeys) {
            var sorted = new List<int>(keyLat); sorted.Sort();
            var good = new List<int>();
            foreach (int v in sorted) if (v >= 0) good.Add(v);
            int mid = good.Count > 0 ? good[good.Count / 2] : -1;
            sb.Append("keysummary n=").Append(good.Count).Append(" median=").Append(mid)
              .Append(" min=").Append(good.Count > 0 ? good[0] : -1)
              .Append(" max=").Append(good.Count > 0 ? good[good.Count - 1] : -1).Append('\n');
            verdict = "done"; break;
          }
          Thread.Sleep(80);
          continue;
        }
      }
    } catch (Exception e) {
      sb.Append("error ").Append(e.GetType().Name).Append(": ").Append(e.Message).Append('\n');
    }
    if (sampler != null) {
      if (shotPath != null && shotPath.Length > 0) { try { sampler.Save(shotPath); sb.Append("shot ").Append(shotPath).Append('\n'); } catch (Exception e) { sb.Append("shotfail ").Append(e.Message).Append('\n'); } }
      sampler.Dispose();
    }
    RECT final; GetClientRect(hwnd, out final);
    sb.Append("clientfinal ").Append(final.Right - final.Left).Append('x').Append(final.Bottom - final.Top).Append('\n');
    sb.Append("zoomed ").Append(IsZoomed(hwnd) ? "yes" : "no").Append('\n');
    sb.Append("frames ").Append(frames).Append('\n');
    sb.Append("maxink ").Append(maxInk).Append(" floor=").Append(INK_FLOOR).Append('\n');
    sb.Append("foreground ").Append(fg ? "yes" : "no").Append('\n');
    sb.Append("foregroundatend ").Append(ForegroundTitle()).Append('\n');
    // Whether input actually happened. The caller must treat a phase that asked for input
    // but got "no" as a MISSING measurement, never as a zero -- and a skipped phase must
    // never be silently averaged in with the ones that ran.
    sb.Append("input used=").Append(inputUsed ? "yes" : "no").Append(" asked=")
      .Append((typeKeys > 0 || scrollNotches > 0 || formulaClick > 0) ? "yes" : "no").Append('\n');
    sb.Append("rescues ").Append(rescues).Append('\n');
    // R12c（2026-10-04 D-E 裁决）：抢救风暴＝被测窗口反复被并行会话的置顶窗完全遮挡，
    // Chromium 的遮挡节流会把"正文上屏"推迟成假慢路径（A3 对比的 4-9s 慢样本全部带此
    // 病征：慢跑抢救 11 次 vs 快跑 ≤2，Typora 恒 1）。抢救 >2 的"成功"读数不可信，
    // 判废打标——多会话机器上凡像素尺验收都受此暴露（规则五新类型）。
    if (rescues > 2 && verdict == "done") verdict = "contaminated-rescue";
    sb.Append("verdict ").Append(verdict).Append('\n');
    sb.Append("elapsed ").Append(clock.ElapsedMilliseconds).Append('\n');
    return sb.ToString();
  }

  public static string Watch(string procName, long notBefore, int timeoutMs, int intervalMs, int stableMs,
                             int clientW, int clientH, int resize, int typeKeys, int scrollNotches, int wheelStep,
                             int regionX0, int regionY0, string shotPath, string shotOpen, string mode,
                             int clickFormula, int clickNotches) {
    RegionX0 = regionX0; RegionY0 = regionY0; shotOpenPath = shotOpen; captureMode = mode;
    formulaClick = clickFormula; gotoNotches = clickNotches;
    try { return Run(procName, notBefore, timeoutMs, intervalMs, stableMs, clientW, clientH, resize, typeKeys, scrollNotches, wheelStep, clickFormula, clickNotches, shotPath); }
    catch (Exception e) { return "error " + e.GetType().Name + ": " + e.Message; }
  }

  // Calibration run: bring the window to a fixed client size and hold it there, so that
  // the app's own geometry-remembering logic (both apps restore their last window size,
  // and both fight a resize made right after the window appears) has a chance to persist
  // our size. Measurements then run with NO resizing at all.
  public static string Calibrate(string procName, long notBefore, int budgetMs, int clientW, int clientH) {
    var sb = new StringBuilder();
    var clock = Stopwatch.StartNew();
    IntPtr hwnd = IntPtr.Zero;
    int attempts = 0; bool ok = false;
    RECT last = new RECT();
    while (clock.ElapsedMilliseconds < budgetMs) {
      if (hwnd == IntPtr.Zero) {
        int pid; hwnd = FindWindow(procName, notBefore, out pid);
        if (hwnd == IntPtr.Zero) { Thread.Sleep(50); continue; }
        sb.Append("calib-visible rel=").Append(clock.ElapsedMilliseconds).Append(" pid=").Append(pid).Append('\n');
        Raise(hwnd);
        Thread.Sleep(300);
      }
      RECT wr, cr;
      GetWindowRect(hwnd, out wr); GetClientRect(hwnd, out cr);
      last = cr;
      if (cr.Right - cr.Left == clientW && cr.Bottom - cr.Top == clientH) { ok = true; break; }
      int dw = (wr.Right - wr.Left) - (cr.Right - cr.Left);
      int dh = (wr.Bottom - wr.Top) - (cr.Bottom - cr.Top);
      SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, clientW + dw, clientH + dh, SWP_NOMOVE);
      attempts++;
      sb.Append("calib-attempt n=").Append(attempts).Append(" rel=").Append(clock.ElapsedMilliseconds)
        .Append(" was=").Append(cr.Right - cr.Left).Append('x').Append(cr.Bottom - cr.Top).Append('\n');
      Thread.Sleep(250);
      GetClientRect(hwnd, out last);
      if (last.Right - last.Left == clientW && last.Bottom - last.Top == clientH) { ok = true; break; }
    }
    sb.Append("calib ok=").Append(ok ? "yes" : "no").Append(" attempts=").Append(attempts)
      .Append(" client=").Append(last.Right - last.Left).Append('x').Append(last.Bottom - last.Top)
      .Append(" zoomed=").Append(IsZoomed(hwnd) ? "yes" : "no").Append('\n');
    return sb.ToString();
  }

  public static string CalibrateAndHold(string procName, long notBefore, int budgetMs, int clientW, int clientH) {
    try { return Calibrate(procName, notBefore, budgetMs, clientW, clientH); }
    catch (Exception e) { return "error " + e.GetType().Name + ": " + e.Message; }
  }
}
'@

if ($Ready -ne '') { [System.IO.File]::WriteAllText($Ready, 'ready') }
$notBefore = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
if ($Calibrate -gt 0) {
  $result = [Peer]::CalibrateAndHold($Name, $notBefore, $Calibrate, $ClientWidth, $ClientHeight)
  # Close gracefully rather than killing: both apps persist their window geometry on a
  # clean shutdown, which is how the calibrated size survives into the measured runs.
  if ($Close -eq 1) {
    $result += [Peer]::Close($Name, $notBefore) + "`n"
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ([DateTime]::UtcNow -lt $deadline) {
      if ([Peer]::FindPid($Name, $notBefore) -eq 0) { $result += "closed cleanly`n"; break }
      Start-Sleep -Milliseconds 200
    }
  }
  if ($Out -ne '') { [System.IO.File]::WriteAllText($Out, $result, (New-Object System.Text.UTF8Encoding($false))) }
  [Console]::Out.Write($result)
  exit 0
}
$result = [Peer]::Watch($Name, $notBefore, $Timeout, $Interval, $Stable, $ClientWidth, $ClientHeight, $Resize,
  $TypeKeys, $ScrollNotches, $WheelStep, $RegionX0Pct, $RegionY0Pct, $Shot, $ShotOpen, $Mode, $ClickFormula, $ClickNotches)
if ($Out -ne '') { [System.IO.File]::WriteAllText($Out, $result, (New-Object System.Text.UTF8Encoding($false))) }
[Console]::Out.Write($result)
