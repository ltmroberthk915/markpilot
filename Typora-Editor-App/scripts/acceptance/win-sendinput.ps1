param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][ValidateSet('wheel', 'click', 'key', 'origin', 'drag')][string]$Action,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$ToX = 0,
  [int]$ToY = 0,
  [int]$Steps = 18,
  [int]$Hold = 55,
  [int]$Delta = -120,
  [int]$Repeat = 1,
  [int]$Vk = 0,
  [int]$TargetPid = 0,
  [switch]$Ctrl
)
# Minimal SendInput driver, used to find out WHERE injected input ends up.
#
# Separate from the witness on purpose: this one takes a process name, grabs the window,
# forces it to the front, injects, and prints what the OS reported. It is a debugging tool
# for "the app ignored my click" -- the witness then has to justify any measurement itself.
#
# ASCII only (PowerShell 5.1 decodes a BOM-less script with the ANSI code page).
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Injected {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public MOUSEINPUT mi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] static extern bool SwitchToThisWindow(IntPtr h, bool alt);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern int GetWindowTextW(IntPtr h, [Out] char[] t, int max);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);

  const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
  const uint KEYEVENTF_KEYUP = 0x0002;

  static IntPtr FindByPid(int wanted, out int pidOut) {
    pidOut = 0;
    if (wanted <= 0) return IntPtr.Zero;
    try { var p = System.Diagnostics.Process.GetProcessById(wanted); if (p != null && p.MainWindowHandle != IntPtr.Zero) { pidOut = p.Id; return p.MainWindowHandle; } } catch {}
    return IntPtr.Zero;
  }

  static IntPtr Find(IntPtr[] all, string name, out int pidOut) {
    pidOut = 0;
    foreach (var p in System.Diagnostics.Process.GetProcessesByName(name)) {
      if (p.MainWindowHandle != IntPtr.Zero) { pidOut = p.Id; return p.MainWindowHandle; }
    }
    return IntPtr.Zero;
  }

  static string TitleOf(IntPtr h) {
    if (h == IntPtr.Zero) return "(none)";
    char[] buf = new char[140];
    int n = GetWindowTextW(h, buf, buf.Length);
    uint pid; GetWindowThreadProcessId(h, out pid);
    return new string(buf, 0, Math.Max(0, n)) + " [pid " + pid + "]";
  }

  static INPUT Key(ushort vk, bool up) {
    INPUT i = new INPUT(); i.type = 1; i.U.ki.wVk = vk; i.U.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0; return i;
  }

  public static string Run(string name, string action, int x, int y, int delta, int repeat, int vk, bool ctrl, int toX, int toY, int steps, int hold, int pidWanted) {
    var sb = new StringBuilder();
    int pid;
    IntPtr h = FindByPid(pidWanted, out pid);
    if (h == IntPtr.Zero) h = Find(null, name, out pid);
    if (h == IntPtr.Zero) return "window-not-found";
    if (action == "origin") {
      // Client-area origin on screen: SendInput needs screen coordinates, while CDP reports
      // viewport coordinates, so this is the missing conversion term.
      POINT p = new POINT(); p.X = 0; p.Y = 0;
      ClientToScreen(h, ref p);
      RECT wr; GetWindowRect(h, out wr);
      RECT cr; GetClientRect(h, out cr);
      sb.Append("clientorigin ").Append(p.X).Append(',').Append(p.Y).Append('\n');
      sb.Append("windowrect ").Append(wr.Left).Append(',').Append(wr.Top).Append(' ').Append(wr.Right - wr.Left).Append('x').Append(wr.Bottom - wr.Top).Append('\n');
      sb.Append("clientrect ").Append(cr.Right - cr.Left).Append('x').Append(cr.Bottom - cr.Top).Append('\n');
      sb.Append("zoomed ").Append(IsZoomed(h) ? "yes" : "no").Append('\n');
      sb.Append("title ").Append(TitleOf(h)).Append('\n');
      return sb.ToString();
    }
    sb.Append("hwnd pid=").Append(pid).Append(" title=").Append(TitleOf(h)).Append('\n');

    // Force activation (the window may be behind an always-on-top window).
    IntPtr fg = GetForegroundWindow();
    uint fgThread = 0;
    if (fg != IntPtr.Zero) { uint ignored; fgThread = GetWindowThreadProcessId(fg, out ignored); }
    uint myThread = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != 0 && fgThread != myThread) attached = AttachThreadInput(myThread, fgThread, true);
    ShowWindow(h, 5); BringWindowToTop(h); SetForegroundWindow(h); SwitchToThisWindow(h, true);
    if (attached) AttachThreadInput(myThread, fgThread, false);
    System.Threading.Thread.Sleep(250);
    sb.Append("foreground=").Append(TitleOf(GetForegroundWindow())).Append('\n');

    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77);
    int vw = Math.Max(1, GetSystemMetrics(78) - 1), vh = Math.Max(1, GetSystemMetrics(79) - 1);
    int ax = (int)((long)(x - vx) * 65535 / vw), ay = (int)((long)(y - vy) * 65535 / vh);
    POINT pt; pt.X = x; pt.Y = y;
    sb.Append("windowFromPoint=").Append(TitleOf(WindowFromPoint(pt))).Append(" at=").Append(x).Append(',').Append(y).Append('\n');

    uint sent = 0;
    if (action == "wheel") {
      var list = new System.Collections.Generic.List<INPUT>();
      list.Add(Mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay));
      for (int i = 0; i < repeat; i++) { var w = Mouse(MOUSEEVENTF_WHEEL, 0, 0); w.U.mi.mouseData = (uint)delta; list.Add(w); }
      sent = SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT)));
      sb.Append("wheel sent=").Append(sent).Append(" of=").Append(list.Count).Append(" delta=").Append(delta).Append('\n');
    } else if (action == "click") {
      sent = SendInput(3, new INPUT[] {
        Mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay),
        Mouse(MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay),
        Mouse(MOUSEEVENTF_LEFTUP | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay),
      }, Marshal.SizeOf(typeof(INPUT)));
      sb.Append("click sent=").Append(sent).Append(" of=3").Append('\n');
    } else if (action == "drag") {
      // Real mouse drag: move to the start, press, walk to the end, release.
      // Steps/Hold control how "human" the motion is; Chromium needs the pointer to
      // actually move between press and release for this to become a drag selection.
      var list = new System.Collections.Generic.List<INPUT>();
      list.Add(Mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay));
      list.Add(Mouse(MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay));
      sent = SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT)));
      sb.Append("drag press sent=").Append(sent).Append('\n');
      for (int i = 1; i <= steps; i++) {
        int sx = x + (toX - x) * i / steps, sy = y + (toY - y) * i / steps;
        int sax = (int)((long)(sx - vx) * 65535 / vw), say = (int)((long)(sy - vy) * 65535 / vh);
        SendInput(1, new INPUT[] { Mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, sax, say) }, Marshal.SizeOf(typeof(INPUT)));
        System.Threading.Thread.Sleep(hold);
      }
      int lax = (int)((long)(toX - vx) * 65535 / vw), lay = (int)((long)(toY - vy) * 65535 / vh);
      sent = SendInput(1, new INPUT[] { Mouse(MOUSEEVENTF_LEFTUP | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, lax, lay) }, Marshal.SizeOf(typeof(INPUT)));
      sb.Append("drag release sent=").Append(sent).Append(" steps=").Append(steps).Append('\n');
    } else {
      var list = new System.Collections.Generic.List<INPUT>();
      for (int i = 0; i < repeat; i++) {
        if (ctrl) list.Add(Key(0x11, false));
        list.Add(Key((ushort)vk, false));
        list.Add(Key((ushort)vk, true));
        if (ctrl) list.Add(Key(0x11, true));
      }
      sent = SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT)));
      sb.Append("key vk=").Append(vk).Append(" ctrl=").Append(ctrl ? "yes" : "no").Append(" sent=").Append(sent).Append(" of=").Append(list.Count).Append('\n');
    }
    POINT after; GetCursorPos(out after);
    sb.Append("cursor=").Append(after.X).Append(',').Append(after.Y).Append('\n');
    sb.Append("foregroundAfter=").Append(TitleOf(GetForegroundWindow())).Append('\n');
    return sb.ToString();
  }

  static INPUT Mouse(uint flags, int ax, int ay) {
    INPUT i = new INPUT(); i.type = 0; i.U.mi.dx = ax; i.U.mi.dy = ay; i.U.mi.dwFlags = flags; return i;
  }
}
'@

[Console]::Out.Write([Injected]::Run($Name, $Action, $X, $Y, $Delta, $Repeat, $Vk, [bool]$Ctrl, $ToX, $ToY, $Steps, $Hold, $TargetPid))
