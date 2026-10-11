# find-file-lock.ps1 — report which process holds a file open (Windows Restart Manager).
# Read-only: it opens nothing for writing and deletes nothing; it just asks the OS.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/find-file-lock.ps1 <path> [<path> ...]
#
# Output per path:
#   --- <path>
#   STATUS=LOCKED | FREE | MISSING
#   <holder lines, one per process>          (only when LOCKED)
#
# Why this exists: `npm run dist` dies with EBUSY on dist/win-unpacked/resources/app.asar,
# and Task Manager shows no owner. Two reasons it is invisible there: app.asar is a data
# file, so it never appears in a process's module list; and a read handle opened without
# FILE_SHARE_DELETE blocks delete/rename while still allowing other readers. Antivirus,
# the search indexer, a crashed process and the agent/tool host all look identical from
# the outside. This script names the actual holder.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Paths)

if (-not $Paths -or $Paths.Count -eq 0) {
  $Paths = @('E:\MarkPilot\Typora-Editor-App\dist\win-unpacked\resources\app.asar')
}

$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Diagnostics;

public static class FileLockFinder {
  [StructLayout(LayoutKind.Sequential)]
  struct RM_UNIQUE_PROCESS {
    public int dwProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
  }
  const int CCH_RM_MAX_APP_NAME = 255;
  const int CCH_RM_MAX_SVC_NAME = 63;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_APP_NAME + 1)]
    public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_SVC_NAME + 1)]
    public string strServiceShortName;
    public uint ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)]
    public bool bRestartable;
  }

  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
  [DllImport("rstrtmgr.dll")]
  static extern int RmEndSession(uint pSessionHandle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames,
    uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo,
    [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

  public static List<string> Find(string path) {
    var result = new List<string>();
    uint session = 0;
    int rv = RmStartSession(out session, 0, Guid.NewGuid().ToString());
    if (rv != 0) { result.Add("RmStartSession failed rv=" + rv); return result; }
    try {
      rv = RmRegisterResources(session, 1, new string[] { path }, 0, null, 0, null);
      if (rv != 0) { result.Add("RmRegisterResources failed rv=" + rv); return result; }
      uint needed = 0, count = 0, reasons = 0;
      rv = RmGetList(session, out needed, ref count, null, ref reasons);
      if (rv == 0) { return result; }
      if (rv != 234) { result.Add("RmGetList failed rv=" + rv); return result; }
      count = needed;
      var arr = new RM_PROCESS_INFO[count];
      rv = RmGetList(session, out needed, ref count, arr, ref reasons);
      if (rv != 0) { result.Add("RmGetList(2) failed rv=" + rv); return result; }
      for (int i = 0; i < count; i++) {
        string name = "(gone)", exe = "";
        try {
          var p = Process.GetProcessById(arr[i].Process.dwProcessId);
          name = p.ProcessName;
          try { exe = p.MainModule.FileName; } catch { }
        } catch { }
        result.Add("pid=" + arr[i].Process.dwProcessId + "  name=" + name + "  app='" + arr[i].strAppName + "'  path=" + exe);
      }
    } finally { RmEndSession(session); }
    return result;
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp

foreach ($p in $Paths) {
  Write-Output ('--- ' + $p)
  if (-not (Test-Path $p)) { Write-Output 'STATUS=MISSING'; continue }
  $exclusive = $true
  try {
    $fs = [System.IO.File]::Open($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $fs.Close()
  } catch { $exclusive = $false }
  $holders = @([FileLockFinder]::Find($p))
  if ($exclusive) { Write-Output 'STATUS=FREE' }
  elseif ($holders.Count -gt 0) { Write-Output 'STATUS=LOCKED' }
  else { Write-Output 'STATUS=LOCKED-UNKNOWN-HOLDER' }
  foreach ($line in $holders) { Write-Output ('    ' + $line) }
}
