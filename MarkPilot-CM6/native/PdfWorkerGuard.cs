using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Owns only one isolated PDF process tree. The editor remains outside this Job.
public static class PdfWorkerGuard {
  public sealed class Config {
    public string runDir { get; set; }
    public string exePath { get; set; }
    public string profilePath { get; set; }
    public string expectedExeSha256 { get; set; }
    public string workingDirectory { get; set; }
    public string ownerToken { get; set; }
    public string[] arguments { get; set; }
    public int runnerPid { get; set; }
    public int jobMemoryMB { get; set; }
    public int maxPrivateMB { get; set; }
    public int minAvailableMB { get; set; }
    public int minAvailableCommitMB { get; set; }
    public int cpuRatePercent { get; set; }
    public int maxDurationMs { get; set; }
    public int sampleIntervalMs { get; set; }
    public bool? writeSamples { get; set; }
  }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessUserTime, JobUserTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
    public uint cb;
    public string reserved, desktop, title;
    public uint x,y,width,height,xChars,yChars,fillAttributes,flags;
    public short showWindow, reserved2Bytes;
    public IntPtr reserved2, stdIn, stdOut, stdErr;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr process, thread;
    public uint pid, tid;
  }
  [StructLayout(LayoutKind.Sequential)] struct NativeFileTime { public uint low,high; }
  [StructLayout(LayoutKind.Sequential)] struct CpuRateControl { public uint flags,rate; }
  [StructLayout(LayoutKind.Sequential)] struct PerformanceInfo {
    public uint size;
    public UIntPtr commitTotal,commitLimit,commitPeak,physicalTotal,physicalAvailable,systemCache,kernelTotal,kernelPaged,kernelNonpaged,pageSize;
    public uint handleCount,processCount,threadCount;
  }
  [StructLayout(LayoutKind.Sequential)] struct MemoryStatus {
    public uint length,load;
    public ulong totalPhys,availablePhys,totalPageFile,availablePageFile,totalVirtual,availableVirtual,availableExtendedVirtual;
  }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct ProcessEntry {
    public uint size,usage,pid;
    public UIntPtr defaultHeap;
    public uint moduleId,threads,parentPid;
    public int priority;
    public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string name;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int cls,ref ExtendedLimits limits,uint length);
  [DllImport("kernel32.dll",EntryPoint="SetInformationJobObject",SetLastError=true)] static extern bool SetCpuRate(IntPtr job,int cls,ref CpuRateControl limits,uint length);
  [DllImport("kernel32.dll",EntryPoint="QueryInformationJobObject",SetLastError=true)] static extern bool QueryCpuRate(IntPtr job,int cls,out CpuRateControl limits,uint length,out uint returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int cls,IntPtr buffer,uint length,out uint returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint exitCode);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inheritHandles,uint flags,IntPtr environment,string currentDirectory,ref StartupInfo startup,out ProcessInfo info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out NativeFileTime creation,out NativeFileTime exit,out NativeFileTime kernel,out NativeFileTime user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetPriorityClass(IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);
  [DllImport("psapi.dll",SetLastError=true)] static extern bool GetPerformanceInfo(ref PerformanceInfo info,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32First(IntPtr snapshot,ref ProcessEntry entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32Next(IntPtr snapshot,ref ProcessEntry entry);

  static readonly JavaScriptSerializer Json=new JavaScriptSerializer { MaxJsonLength=1048576 };
  static readonly UTF8Encoding Utf8=new UTF8Encoding(false);
  static void Check(bool ok,string action){if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error(),action);}
  static void Require(bool ok,string message){if(!ok)throw new InvalidOperationException(message);}
  static PerformanceInfo SystemPerformance(){var info=new PerformanceInfo();info.size=(uint)Marshal.SizeOf(typeof(PerformanceInfo));Check(GetPerformanceInfo(ref info,info.size),"Read system commit headroom");Require(info.commitLimit.ToUInt64()>=info.commitTotal.ToUInt64(),"invalid system commit counters");return info;}
  static ulong CommitAvailable(PerformanceInfo info){return checked((info.commitLimit.ToUInt64()-info.commitTotal.ToUInt64())*info.pageSize.ToUInt64());}
  static string Sha(string file){using(var input=File.OpenRead(NativePath(file)))using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(input)).Replace("-","").ToLowerInvariant();}
  static void NewJson(string file,object value){using(var stream=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.Read))using(var writer=new StreamWriter(stream,Utf8)){writer.Write(Json.Serialize(value));}}
  static string NativePath(string file){string full=Full(file);return full.StartsWith(@"\\?\")?full:full.StartsWith(@"\\")?@"\\?\UNC\"+full.Substring(2):@"\\?\"+full;}
  static string Full(string value){Require(!String.IsNullOrEmpty(value),"required path absent");return Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar);}
  static string Quote(string value){
    Require(value!=null&&value.IndexOf('\0')<0,"invalid argv");
    var text=new StringBuilder("\"");int slashes=0;
    foreach(char c in value){if(c=='\\'){slashes++;continue;}if(c=='\"'){text.Append('\\',slashes*2+1);text.Append(c);}else{text.Append('\\',slashes);text.Append(c);}slashes=0;}
    text.Append('\\',slashes*2);text.Append('"');return text.ToString();
  }
  static IntPtr InheritedStd(int id){
    IntPtr source=GetStdHandle(id),copy;
    Require(source!=IntPtr.Zero&&source!=new IntPtr(-1),"standard handle missing: "+id);
    Check(DuplicateHandle(GetCurrentProcess(),source,GetCurrentProcess(),out copy,0,true,2),"Duplicate standard handle");
    return copy;
  }
  static int ParentPid(int pid){
    IntPtr snap=CreateToolhelp32Snapshot(2,0);Require(snap!=new IntPtr(-1),"process snapshot failed");
    try{var entry=new ProcessEntry();entry.size=(uint)Marshal.SizeOf(typeof(ProcessEntry));bool found=Process32First(snap,ref entry);while(found){if(entry.pid==(uint)pid)return (int)entry.parentPid;found=Process32Next(snap,ref entry);}throw new InvalidOperationException("launcher parent unavailable");}finally{CloseHandle(snap);}
  }
  static int[] JobPids(IntPtr job){
    int capacity=32;
    while(capacity<=4096){int bytes=8+IntPtr.Size*capacity;IntPtr buffer=Marshal.AllocHGlobal(bytes);
      try{uint returned;bool ok=QueryInformationJobObject(job,3,buffer,(uint)bytes,out returned);if(!ok){int err=Marshal.GetLastWin32Error();if(err==234){capacity*=2;continue;}throw new Win32Exception(err,"Query job members");}
        int count=Marshal.ReadInt32(buffer,4);Require(count>=0&&count<=capacity,"invalid job member count");var pids=new int[count];for(int i=0;i<count;i++){long n=IntPtr.Size==8?Marshal.ReadInt64(buffer,8+i*8):Marshal.ReadInt32(buffer,8+i*4);Require(n>0&&n<=Int32.MaxValue,"invalid job member PID");pids[i]=(int)n;}return pids;
      }finally{Marshal.FreeHGlobal(buffer);}
    }throw new InvalidOperationException("owned job PID capacity exceeded");
  }
  static object Stage(string file){
    try{if(!File.Exists(file)||new FileInfo(file).Length>65536)return null;using(var s=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.ReadWrite))using(var r=new StreamReader(s,Utf8)){return Json.DeserializeObject(r.ReadToEnd());}}catch{return null;}
  }
  static Config ReadConfig(string file){
    Require(new FileInfo(file).Length<=65536,"config too large");var c=Json.Deserialize<Config>(File.ReadAllText(file,Utf8));Require(c!=null,"invalid config");
    c.runDir=Full(c.runDir);c.exePath=Full(c.exePath);c.profilePath=Full(c.profilePath);
    string temp=Full(Path.GetTempPath()),stageDir=Path.GetDirectoryName(c.runDir),workerName=Path.GetFileName(c.runDir);
    Require(!String.IsNullOrEmpty(stageDir)&&String.Equals(Path.GetDirectoryName(stageDir),temp,StringComparison.OrdinalIgnoreCase),"worker stage must be a direct system-temp child");
    string stageName=Path.GetFileName(stageDir);Require(stageName.StartsWith("markpilot-pdf-",StringComparison.Ordinal)&&stageName.Length>"markpilot-pdf-".Length,"owned PDF temp stage required");
    Guid workerGuid;string suffix=workerName.StartsWith("pdf-worker-",StringComparison.Ordinal)?workerName.Substring(11):"";
    Require(Guid.TryParseExact(suffix,"D",out workerGuid)&&workerGuid!=Guid.Empty&&workerGuid.ToString("D")==suffix,"canonical UUID worker directory required");
    Require(String.Equals(Path.GetDirectoryName(Full(file)),c.runDir,StringComparison.OrdinalIgnoreCase),"config must be directly inside worker directory");
    foreach(string checkedPath in new[]{stageDir,c.runDir,Full(file)})Require((File.GetAttributes(checkedPath)&FileAttributes.ReparsePoint)==0,"worker/config reparse rejected");
    if(Directory.Exists(c.profilePath))Require((File.GetAttributes(c.profilePath)&FileAttributes.ReparsePoint)==0,"profile reparse rejected");
    Require(Directory.Exists(c.runDir),"parent must prepare worker run directory");
    Require(String.Equals(Path.GetDirectoryName(c.profilePath),c.runDir,StringComparison.OrdinalIgnoreCase)&&Path.GetFileName(c.profilePath).StartsWith("profile-",StringComparison.Ordinal)&&Path.GetFileName(c.profilePath).Length>8,"unique direct-child profile required");
    Require(File.Exists(NativePath(c.exePath))&&(String.Equals(Path.GetFileName(c.exePath),"MarkPilot.exe",StringComparison.OrdinalIgnoreCase)||String.Equals(Path.GetFileName(c.exePath),"electron.exe",StringComparison.OrdinalIgnoreCase)),"fixed MarkPilot executable required");
    Require((File.GetAttributes(NativePath(c.exePath))&FileAttributes.ReparsePoint)==0,"executable reparse rejected");
    Require(!String.IsNullOrEmpty(c.expectedExeSha256)&&c.expectedExeSha256.Length==64,"whole executable SHA required");
    foreach(char ch in c.expectedExeSha256)Require(Uri.IsHexDigit(ch),"invalid executable SHA");
    Require(String.Equals(Sha(c.exePath),c.expectedExeSha256,StringComparison.OrdinalIgnoreCase),"whole executable SHA mismatch");
    Require(c.arguments!=null&&c.arguments.Length>0,"actual launch argv required");int profiles=0;
    foreach(string arg in c.arguments){Require(arg!=null&&arg.IndexOf('\0')<0,"invalid argv");if(arg.StartsWith("--user-data-dir=",StringComparison.OrdinalIgnoreCase)){profiles++;Require(String.Equals(Full(arg.Substring(16)),c.profilePath,StringComparison.OrdinalIgnoreCase),"argv profile mismatch");}}
    Require(profiles==1,"exactly one unique user-data-dir required");
    if(String.IsNullOrEmpty(c.workingDirectory))c.workingDirectory=Path.GetDirectoryName(c.exePath);else c.workingDirectory=Full(c.workingDirectory);
    Require(Directory.Exists(c.workingDirectory),"working directory absent");
    Guid ownerGuid;Require(Guid.TryParseExact(c.ownerToken,"D",out ownerGuid)&&ownerGuid!=Guid.Empty&&ownerGuid.ToString("D")==c.ownerToken,"canonical UUID owner token required");
    if(c.jobMemoryMB==0)c.jobMemoryMB=3072;if(c.maxPrivateMB==0)c.maxPrivateMB=2560;if(c.minAvailableMB==0)c.minAvailableMB=3072;
    if(c.minAvailableCommitMB==0)c.minAvailableCommitMB=3072;if(c.cpuRatePercent==0)c.cpuRatePercent=25;
    if(c.maxDurationMs==0)c.maxDurationMs=65000;if(c.sampleIntervalMs==0)c.sampleIntervalMs=250;
    Require(c.jobMemoryMB==3072,"this frozen launcher uses a 3 GiB job cap");
    Require(c.maxPrivateMB>=512&&c.maxPrivateMB<c.jobMemoryMB&&c.minAvailableMB>=512,"explicit bounded memory thresholds required");
    Require(c.minAvailableCommitMB>=512&&c.cpuRatePercent>=1&&c.cpuRatePercent<=25,"explicit bounded system commit and CPU budgets required");
    Require(c.maxDurationMs>=5000&&c.maxDurationMs<=900000&&c.sampleIntervalMs>=100&&c.sampleIntervalMs<=250,"bounded monitor timing required");
    foreach(string name in new[]{"guard-launch.json","guard-result.json","guard-samples.jsonl","guard-stop.json"})Require(!File.Exists(Path.Combine(c.runDir,name)),"fresh guard files required: "+name);
    return c;
  }
  public static int Main(string[] args){
    Config c=null;IntPtr job=IntPtr.Zero,parentHandle=IntPtr.Zero;ProcessInfo app=new ProcessInfo();var inherited=new List<IntPtr>();bool assigned=false,resumed=false,appExited=false;
    int returnedCode=2;uint appCode=259;string reason="guard infrastructure error";object last=null;long sampleCount=0;double peakPrivateMB=0,peakWorkingMB=0;
    var result=new Dictionary<string,object>();bool jobEmpty=true;int[] remainingPids=new int[0];string cleanupError=null;int ignoredStopReads=0;var total=Stopwatch.StartNew();StreamWriter sampleLog=null;
    try{
      Require(args.Length==1,"usage: PdfWorkerGuard.exe <config.json>");AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling",false);AppContext.SetSwitch("Switch.System.IO.BlockLongPaths",false);c=ReadConfig(args[0]);int launcherPid=Process.GetCurrentProcess().Id;int parent=ParentPid(launcherPid);
      Require(c.runnerPid==0||c.runnerPid==parent,"launcher parent PID mismatch");
      parentHandle=OpenProcess(0x101000u,false,parent);Check(parentHandle!=IntPtr.Zero,"Open actual OS parent lifetime handle");
      NativeFileTime parentCreated,parentExit,parentKernel,parentUser,selfCreated,selfExit,selfKernel,selfUser;
      Check(GetProcessTimes(parentHandle,out parentCreated,out parentExit,out parentKernel,out parentUser),"Read retained parent creation time");
      Check(GetProcessTimes(GetCurrentProcess(),out selfCreated,out selfExit,out selfKernel,out selfUser),"Read guard creation time");
      ulong parentTime=((ulong)parentCreated.high<<32)|parentCreated.low,selfTime=((ulong)selfCreated.high<<32)|selfCreated.low;
      Require(parentTime<=selfTime,"actual parent PID was reused before lifetime handle acquisition");
      Require(WaitForSingleObject(parentHandle,0)==258,"actual parent exited before worker admission");
      result["parentCreationFileTime"]=parentTime.ToString();result["parentLifetimeHandleRetained"]=true;
      result["schema"]=1;result["machine"]=Environment.MachineName;result["launcherPid"]=launcherPid;result["launcherParentPid"]=parent;result["ownerToken"]=c.ownerToken;result["exePath"]=c.exePath;result["profilePath"]=c.profilePath;result["jobMemoryMB"]=c.jobMemoryMB;result["maxPrivateMB"]=c.maxPrivateMB;result["minAvailableMB"]=c.minAvailableMB;result["minAvailableCommitMB"]=c.minAvailableCommitMB;result["startedAt"]=DateTime.UtcNow.ToString("o");
      var initialMemory=new MemoryStatus();initialMemory.length=(uint)Marshal.SizeOf(typeof(MemoryStatus));Check(GlobalMemoryStatusEx(ref initialMemory),"Read pre-admission system memory");
      result["initialAvailableMB"]=initialMemory.availablePhys/1048576.0;
      Require(initialMemory.availablePhys>=(ulong)c.minAvailableMB*1048576UL,"MP_PDF_LOW_MEMORY: insufficient available memory before worker creation");
      var initialPerformance=SystemPerformance();result["initialAvailableCommitMB"]=CommitAvailable(initialPerformance)/1048576.0;
      Require(CommitAvailable(initialPerformance)>=(ulong)c.minAvailableCommitMB*1048576UL,"MP_PDF_LOW_MEMORY: insufficient system commit headroom before worker creation");
      job=CreateJobObject(IntPtr.Zero,null);Require(job!=IntPtr.Zero,"CreateJobObject failed");var limits=new ExtendedLimits();limits.Basic.Flags=0x2000u|0x200u;limits.JobMemory=new UIntPtr((ulong)c.jobMemoryMB*1048576UL);
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))),"Set job memory + kill-on-close");
      var cpuLimit=new CpuRateControl{flags=0x1u|0x4u,rate=(uint)c.cpuRatePercent*100u};
      Check(SetCpuRate(job,15,ref cpuLimit,(uint)Marshal.SizeOf(typeof(CpuRateControl))),"Set owned job CPU hard cap");
      CpuRateControl actualCpu;uint cpuReturned;Check(QueryCpuRate(job,15,out actualCpu,(uint)Marshal.SizeOf(typeof(CpuRateControl)),out cpuReturned),"Read back owned job CPU hard cap");
      Require(actualCpu.flags==cpuLimit.flags&&actualCpu.rate==cpuLimit.rate,"CPU hard cap was not admitted by Windows");
      result["cpuRateControlFlags"]=actualCpu.flags;result["cpuRatePercent"]=actualCpu.rate/100.0;
      var startup=new StartupInfo();startup.cb=(uint)Marshal.SizeOf(typeof(StartupInfo));startup.flags=0x100; // std handles only; do not inherit hidden-window startup mode
      startup.stdIn=InheritedStd(-10);inherited.Add(startup.stdIn);startup.stdOut=InheritedStd(-11);inherited.Add(startup.stdOut);startup.stdErr=InheritedStd(-12);inherited.Add(startup.stdErr);
      var command=new StringBuilder(Quote(c.exePath));foreach(string arg in c.arguments)command.Append(' ').Append(Quote(arg));
      Check(CreateProcess(NativePath(c.exePath),command,IntPtr.Zero,IntPtr.Zero,true,0x4u|0x400u|0x4000u,IntPtr.Zero,c.workingDirectory,ref startup,out app),"Create suspended below-normal PDF worker");
      uint workerPriority=GetPriorityClass(app.process);Check(workerPriority!=0,"Read suspended PDF worker priority");Require(workerPriority==0x4000u,"below-normal worker priority was not admitted");result["workerPriorityClass"]=workerPriority;
      // No application instruction runs before this exact root enters the job.
      Check(AssignProcessToJobObject(job,app.process),"Assign suspended root to job");assigned=true;
      Require(Array.IndexOf(JobPids(job),(int)app.pid)>=0,"suspended root missing from owned job");
      NativeFileTime created,exited,kernel,user;Check(GetProcessTimes(app.process,out created,out exited,out kernel,out user),"Read app creation time");ulong filetime=((ulong)created.high<<32)|created.low;
      Require(WaitForSingleObject(parentHandle,0)==258,"actual parent exited before worker resume");
      uint suspendCount=ResumeThread(app.thread);Check(suspendCount!=UInt32.MaxValue,"Resume assigned root");resumed=true;
      CloseHandle(app.thread);app.thread=IntPtr.Zero;
      foreach(IntPtr h in inherited)CloseHandle(h);inherited.Clear();
      var launch=new Dictionary<string,object>(result);launch["rootPid"]=app.pid;launch["rootCreationTimeUtc"]=DateTime.FromFileTimeUtc((long)filetime).ToString("o");launch["rootCreationFileTime"]=filetime.ToString();launch["hardJobGuardAssigned"]=true;launch["assignedBeforeResume"]=true;launch["resumed"]=true;launch["stdioInherited"]=true;
      NewJson(Path.Combine(c.runDir,"guard-launch.json"),launch);result["rootPid"]=app.pid;result["rootCreationFileTime"]=filetime.ToString();
      if(c.writeSamples==true){sampleLog=new StreamWriter(new FileStream(Path.Combine(c.runDir,"guard-samples.jsonl"),FileMode.CreateNew,FileAccess.Write,FileShare.Read),Utf8);sampleLog.AutoFlush=true;}
      int lowMemorySamples=0,lowCommitSamples=0;
      while(true){
        uint parentWait=WaitForSingleObject(parentHandle,0);if(parentWait==0){reason="actual parent exited";Check(TerminateJobObject(job,10),"Parent-exit owned job stop");break;}if(parentWait!=258)throw new Win32Exception(Marshal.GetLastWin32Error(),"Poll actual parent lifetime");
        uint waited=WaitForSingleObject(app.process,0);if(waited==0){appExited=true;reason="app exited";break;}if(waited!=258)throw new Win32Exception(Marshal.GetLastWin32Error(),"Wait owned app");
        string stopFile=Path.Combine(c.runDir,"guard-stop.json");if(File.Exists(stopFile)){bool ownedStop=false;try{if(new FileInfo(stopFile).Length<=4096){var marker=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(stopFile,Utf8));ownedStop=marker!=null&&marker.ContainsKey("ownerToken")&&String.Equals(Convert.ToString(marker["ownerToken"]),c.ownerToken,StringComparison.Ordinal);}}catch{}if(ownedStop){reason="owner stop marker";Check(TerminateJobObject(job,10),"Stop owned job");break;}ignoredStopReads++;}
        int[] pids=JobPids(job);long privateBytes=0,workingBytes=0;double cpu=0;var metrics=new List<object>();
        foreach(int pid in pids){try{using(var process=Process.GetProcessById(pid)){process.Refresh();long pb=process.PrivateMemorySize64,wb=process.WorkingSet64;double seconds=process.TotalProcessorTime.TotalSeconds;privateBytes+=pb;workingBytes+=wb;cpu+=seconds;metrics.Add(new{pid=pid,privateBytes=pb,workingSetBytes=wb,cpuSeconds=seconds});}}catch(ArgumentException){}catch(InvalidOperationException){} }
        var memory=new MemoryStatus();memory.length=(uint)Marshal.SizeOf(typeof(MemoryStatus));Check(GlobalMemoryStatusEx(ref memory),"Read system memory");
        var performance=SystemPerformance();ulong commitAvailable=CommitAvailable(performance);
        peakPrivateMB=Math.Max(peakPrivateMB,privateBytes/1048576.0);peakWorkingMB=Math.Max(peakWorkingMB,workingBytes/1048576.0);
        last=new{at=DateTime.UtcNow.ToString("o"),elapsedMs=total.ElapsedMilliseconds,rootPid=app.pid,pids=pids,metrics=metrics,privateMB=privateBytes/1048576.0,workingSetMB=workingBytes/1048576.0,cpuSeconds=cpu,availableMB=memory.availablePhys/1048576.0,totalPhysicalMB=memory.totalPhys/1048576.0,availableCommitMB=commitAvailable/1048576.0,systemCommitMB=performance.commitTotal.ToUInt64()*performance.pageSize.ToUInt64()/1048576.0,systemCommitLimitMB=performance.commitLimit.ToUInt64()*performance.pageSize.ToUInt64()/1048576.0,phase=Stage(Path.Combine(c.runDir,"stage.json"))};if(sampleLog!=null)sampleLog.WriteLine(Json.Serialize(last));sampleCount++;
        if(privateBytes>=(long)c.maxPrivateMB*1048576L){reason="owned private bytes threshold";Check(TerminateJobObject(job,10),"Private threshold owned job stop");break;}
        if(memory.availablePhys<(ulong)c.minAvailableMB*1048576UL)lowMemorySamples++;else lowMemorySamples=0;
        if(lowMemorySamples>=2){reason="system available memory threshold";Check(TerminateJobObject(job,10),"Available memory owned job stop");break;}
        if(commitAvailable<(ulong)c.minAvailableCommitMB*1048576UL)lowCommitSamples++;else lowCommitSamples=0;
        if(lowCommitSamples>=2){reason="system commit memory threshold";Check(TerminateJobObject(job,10),"System commit owned job stop");break;}
        if(total.ElapsedMilliseconds>=c.maxDurationMs){reason="owned total duration threshold";Check(TerminateJobObject(job,10),"Duration owned job stop");break;}
        uint idleParentWait=WaitForSingleObject(parentHandle,(uint)c.sampleIntervalMs);
        if(idleParentWait!=0&&idleParentWait!=258)throw new Win32Exception(Marshal.GetLastWin32Error(),"Wait actual parent between samples");
      }
      if(!appExited){Require(WaitForSingleObject(app.process,5000)==0,"owned app did not exit after job termination");appExited=true;}
      Check(GetExitCodeProcess(app.process,out appCode),"Read actual app exit code");returnedCode=unchecked((int)appCode);
    }catch(Exception error){result["error"]=error.GetType().Name+": "+error.Message;reason="guard infrastructure error";returnedCode=2;
      try{if(app.process!=IntPtr.Zero){if(assigned&&job!=IntPtr.Zero)TerminateJobObject(job,2);else TerminateProcess(app.process,2);WaitForSingleObject(app.process,5000);if(GetExitCodeProcess(app.process,out appCode)&&appCode!=259){appExited=true;returnedCode=unchecked((int)appCode);}}}catch{}
      Console.Error.WriteLine("PDF_GUARD_INFRA "+error.GetType().Name+": "+error.Message);
    }finally{
      if(sampleLog!=null)sampleLog.Dispose();foreach(IntPtr h in inherited)CloseHandle(h);if(app.thread!=IntPtr.Zero)CloseHandle(app.thread);
      var cleanupClock=Stopwatch.StartNew();
      if(job!=IntPtr.Zero){
        try{
          remainingPids=JobPids(job);
          if(remainingPids.Length>0)Check(TerminateJobObject(job,appExited?appCode:2u),"Final owned-job termination");
          while(remainingPids.Length>0&&cleanupClock.ElapsedMilliseconds<5000){Thread.Sleep(50);remainingPids=JobPids(job);}
          if(app.process!=IntPtr.Zero&&WaitForSingleObject(app.process,0)!=0){
            Check(TerminateProcess(app.process,2),"Terminate only own unassigned suspended root");
            uint left=(uint)Math.Max(0,5000-cleanupClock.ElapsedMilliseconds);
            if(WaitForSingleObject(app.process,left)!=0)remainingPids=new[]{(int)app.pid};
          }
          jobEmpty=remainingPids.Length==0;if(!jobEmpty)cleanupError="owned job or own suspended root still has members after bounded cleanup";
        }catch(Exception cleanupFailure){jobEmpty=false;remainingPids=null;cleanupError=cleanupFailure.GetType().Name+": "+cleanupFailure.Message;}
        finally{CloseHandle(job);job=IntPtr.Zero;}
      }else if(app.process!=IntPtr.Zero&&!appExited){jobEmpty=false;remainingPids=new[]{(int)app.pid};cleanupError="unassigned suspended worker exit was not observed";}
      if(cleanupError!=null&&returnedCode==0)returnedCode=2;
      if(parentHandle!=IntPtr.Zero){result["parentAliveAtFinish"]=WaitForSingleObject(parentHandle,0)==258;CloseHandle(parentHandle);parentHandle=IntPtr.Zero;}
      if(app.process!=IntPtr.Zero)CloseHandle(app.process);
      result["reason"]=reason;result["assignedBeforeResume"]=assigned;result["resumed"]=resumed;result["appExited"]=appExited;result["appExitCode"]=appExited?(object)appCode:null;result["launcherExitCode"]=returnedCode;result["exitCodeIsAppExitCode"]=appExited&&returnedCode==unchecked((int)appCode);result["lastSample"]=last;result["samples"]=sampleCount;result["peakPrivateMB"]=peakPrivateMB;result["peakWorkingMB"]=peakWorkingMB;result["ignoredStopMarkerReads"]=ignoredStopReads;result["jobEmpty"]=jobEmpty;result["remainingPids"]=remainingPids;result["cleanupError"]=cleanupError;result["cleanupMs"]=cleanupClock.ElapsedMilliseconds;result["success"]=appExited&&appCode==0&&returnedCode==0&&jobEmpty&&cleanupError==null&&!result.ContainsKey("error")&&reason=="app exited";result["finishedAt"]=DateTime.UtcNow.ToString("o");
      if(c!=null){try{NewJson(Path.Combine(c.runDir,"guard-result.json"),result);}catch(Exception writeError){Console.Error.WriteLine("PDF_GUARD_RESULT_WRITE "+writeError.Message);if(returnedCode==0)returnedCode=2;}}
    }
    return returnedCode;
  }
}
