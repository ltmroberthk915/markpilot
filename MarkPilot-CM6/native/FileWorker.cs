using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

// Private, persistent stdin/stdout worker. No listener, shell, or document text.
// Staging inherits the original DACL before the first content byte is written.
internal static class FileWorker {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool ReplaceFileW(string target, string replacement, string backup,
    uint flags, IntPtr exclude, IntPtr reserved);
  [StructLayout(LayoutKind.Sequential)]
  private struct FileInformation {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool GetFileInformationByHandle(IntPtr handle,out FileInformation info);
  private sealed class Conflict : IOException {
    public readonly string Code;
    public Conflict(string code,string message):base(message) { Code=code; }
  }
  private sealed class Stage {
    public string Target, Temp, Backup;
    public bool Existed, Recovery;
    public string ExpectedHash, OutputHash;
    public long OutputBytes;
  }
  private static readonly Dictionary<string,Stage> Stages=new Dictionary<string,Stage>();
  private static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
  private static string NativePath(string path) {
    string full=Path.GetFullPath(path);
    return full.StartsWith(@"\\?\") ? full : full.StartsWith(@"\\") ? @"\\?\UNC\"+full.Substring(2) : @"\\?\"+full;
  }
  private static string Str(Dictionary<string,object> obj,string key) {
    object value; return obj.TryGetValue(key,out value) ? Convert.ToString(value) : "";
  }
  private static bool Exists(string file) {
    try { var attributes=File.GetAttributes(NativePath(file)); if((attributes&FileAttributes.Directory)!=0)throw new IOException("Target is a directory");return true; }
    catch(FileNotFoundException) { return false; }
    catch(DirectoryNotFoundException) { return false; }
  }
  private static string Hash(Stream stream) {
    using(var sha=SHA256.Create()) { return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant(); }
  }
  private static FileStream ValidateTarget(Stage entry,bool hash) {
    if(!entry.Existed) { if(Exists(entry.Target))throw new Conflict("MP_FILE_CONFLICT","保存目标已由其他程序创建");return null; }
    if(!Exists(entry.Target))throw new Conflict("MP_FILE_MISSING","原文件已不在磁盘上");
    var file=new FileStream(NativePath(entry.Target),FileMode.Open,FileAccess.Read,FileShare.Read|FileShare.Delete);
    try {
      FileInformation info;
      if(!GetFileInformationByHandle(file.SafeFileHandle.DangerousGetHandle(),out info))throw new Win32Exception(Marshal.GetLastWin32Error());
      if(info.Links>1)throw new Conflict("MP_FILE_LINKED","文件包含硬链接，请另存为独立文件");
      if(hash&&!String.Equals(Hash(file),entry.ExpectedHash,StringComparison.Ordinal))throw new Conflict("MP_FILE_CONFLICT","文件已被其他窗口或程序修改，请重新加载或另存为");
      return file;
    }catch { file.Dispose();throw; }
  }
  private static object Handle(Dictionary<string,object> cmd) {
    string id=Str(cmd,"id"),action=Str(cmd,"action");
    if(action=="prepare") {
      if(Stages.ContainsKey(id)) throw new IOException("Duplicate stage");
      var s=new Stage { Target=Path.GetFullPath(Str(cmd,"target")), Temp=Path.GetFullPath(Str(cmd,"temp")), Backup=Path.GetFullPath(Str(cmd,"backup")) };
      object expectedValue,outputValue;
      if(!cmd.TryGetValue("expected",out expectedValue)||!cmd.TryGetValue("output",out outputValue))throw new IOException("Missing save baseline");
      var expected=expectedValue as Dictionary<string,object>;var output=outputValue as Dictionary<string,object>;
      if(expected==null||output==null||!expected.ContainsKey("exists")||!(expected["exists"] is bool))throw new IOException("Invalid save baseline");
      s.Existed=(bool)expected["exists"];s.ExpectedHash=Str(expected,"sha256");s.OutputHash=Str(output,"sha256");s.OutputBytes=Convert.ToInt64(output["bytes"]);
      if((s.Existed&&!Regex.IsMatch(s.ExpectedHash,"^[a-f0-9]{64}$"))||!Regex.IsMatch(s.OutputHash,"^[a-f0-9]{64}$")||s.OutputBytes<0)throw new IOException("Invalid save digest");
      if(!String.Equals(Path.GetDirectoryName(s.Target),Path.GetDirectoryName(s.Temp),StringComparison.OrdinalIgnoreCase)
        || !String.Equals(Path.GetDirectoryName(s.Temp),Path.GetDirectoryName(s.Backup),StringComparison.OrdinalIgnoreCase)
        || s.Temp==s.Target || s.Backup==s.Target || s.Temp==s.Backup) throw new IOException("Invalid stage paths");
      if(File.Exists(s.Temp)||File.Exists(s.Backup)||Directory.Exists(s.Target)) throw new IOException("Stage destination exists");
      using(var guard=ValidateTarget(s,false)) { }
      if(s.Existed) {
        FileSecurity acl=File.GetAccessControl(NativePath(s.Target),AccessControlSections.Access);
        using(var f=new FileStream(NativePath(s.Temp),FileMode.CreateNew,FileSystemRights.Read|FileSystemRights.Write,FileShare.None,4096,FileOptions.None,acl)) { }
      } else { using(var f=new FileStream(NativePath(s.Temp),FileMode.CreateNew,FileAccess.Write,FileShare.None)) { } }
      Stages.Add(id,s);
      return new { ok=true, phase="prepared", existed=s.Existed };
    }
    Stage entry;
    if(!Stages.TryGetValue(id,out entry)) throw new IOException("Unknown stage");
    if(action=="abort") {
      if(entry.Recovery) return new {ok=false,phase="recovery",preserveTemp=true,temp=entry.Temp,backup=entry.Backup};
      if(File.Exists(NativePath(entry.Temp))) File.Delete(NativePath(entry.Temp));
      Stages.Remove(id); return new {ok=true,phase="aborted"};
    }
    if(action!="commit" || entry.Recovery) throw new IOException("Invalid stage command");
    // Do not merge through failures or relax ACL errors. A unique backup is
    // required because ReplaceFile has documented partial-failure states.
    bool committed=false;int code=0;
    try {
      using(var f=new FileStream(NativePath(entry.Temp),FileMode.Open,FileAccess.ReadWrite,FileShare.Read)) {
        f.Flush(true);
        if(f.Length!=entry.OutputBytes||Hash(f)!=entry.OutputHash)throw new Conflict("MP_FILE_CONFLICT","保存临时文件已改变，已停止替换原文件");
      }
      // Hash at execution time, after any RPC queue wait. The read/delete-share
      // handle excludes ordinary writers through replace; this is not an OS CAS
      // against another process renaming paths concurrently.
      using(var guard=ValidateTarget(entry,true)) {
        if(entry.Existed) {
          committed=ReplaceFileW(NativePath(entry.Target),NativePath(entry.Temp),NativePath(entry.Backup),0,IntPtr.Zero,IntPtr.Zero);
          if(!committed) code=Marshal.GetLastWin32Error();
        } else { File.Move(NativePath(entry.Temp),NativePath(entry.Target)); committed=true; }
      }
    } catch(Conflict conflict) {
      return new {ok=false,phase="conflict",code=conflict.Code,error=conflict.Message,preserveTemp=false};
    } catch(Exception error) {
      entry.Recovery=true;
      return new {ok=false,phase="recovery",error=error.Message,preserveTemp=true,temp=entry.Temp,backup=entry.Backup};
    }
    if(!committed) {
      entry.Recovery=true;bool restored=false;
      // A partial replace may have moved the original to the owned backup.
      // Restore only a missing target. Never overwrite an external new file.
      if(!File.Exists(NativePath(entry.Target))&&File.Exists(NativePath(entry.Backup))) {
        try { File.Move(NativePath(entry.Backup),NativePath(entry.Target)); restored=true; } catch { }
      }
      return new {ok=false,phase="recovery",win32=code,error=new Win32Exception(code).Message,
        preserveTemp=true,restored=restored,temp=entry.Temp,backup=entry.Backup};
    }
    Stages.Remove(id);bool backupRetained=false;
    try { if(File.Exists(NativePath(entry.Backup))) File.Delete(NativePath(entry.Backup)); } catch { backupRetained=true; }
    return new {ok=true,phase="committed",backupRetained=backupRetained};
  }
  private static void Main() {
    AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling",false);
    AppContext.SetSwitch("Switch.System.IO.BlockLongPaths",false);
    Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
    string line;
    while((line=Console.ReadLine())!=null) {
      string request="";
      try {
        var cmd=Json.Deserialize<Dictionary<string,object>>(line);request=Str(cmd,"request");
        Console.WriteLine(Json.Serialize(new {request=request,result=Handle(cmd)}));
      } catch(Exception error) { var conflict=error as Conflict;Console.WriteLine(Json.Serialize(new {request=request,result=new {ok=false,error=error.Message,code=conflict==null?"MP_REPLACE_FAILED":conflict.Code,phase="failed",preserveTemp=false}})); }
      Console.Out.Flush();
    }
    // EOF/parent exit never deletes a staged draft or a recovery backup.
  }
}
