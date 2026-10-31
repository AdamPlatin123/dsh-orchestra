// ProcGuard.cs - S4 spike helper for dsh-orchestra (spec r4 §13.2 S4, §10.5, §10.16).
// C# 5 / .NET Framework 4.x, compiled with the system csc.exe (see build.cmd).
//
// Two modes:
//   procguard.exe [serve] [--protect <pid,pid>]   resident: stdin one JSON command per line,
//                                                 stdout one JSON result per line; exits on stdin EOF
//                                                 (orchestrad dies -> pipe breaks -> helper exits ->
//                                                 Job handles close -> KILL_ON_JOB_CLOSE kills the trees).
//   procguard.exe run-in-job [--name <osJobName>] [--env-allowlist <file>] [--no-window] -- <cmd> [args]
//                                                 one-shot: child inherits our stdio, we wait and return its
//                                                 exit code; our Job dies with us.
// Commands: run-in-job, snapshot, kill-job, close-job, job-info, job-open, in-job, in-job-named,
//           kill-tree, pipe-client-pid, pipe-peers, job-handles, file-busy, alive, protect, self, ping.
// Review fixes (2026-10-30): kill-tree refuses an unknown identity (createTime 0); includeRoot defaults to
// false and killing the root needs its token; hosts inside our Jobs are "owned-host" (token needed);
// resident run-in-job passes only its own 3 std handles (PROC_THREAD_ATTRIBUTE_HANDLE_LIST).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace ProcGuard {

static class W {
  public const uint KILL_ON_JOB_CLOSE = 0x2000, CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENV = 0x400, CREATE_NO_WINDOW = 0x08000000;
  public const uint PQLI = 0x1000, PTERM = 0x1, PDUP = 0x40, JOB_QUERY = 0x4, STILL_ACTIVE = 259;
  [StructLayout(LayoutKind.Sequential)] public struct BASIC_LIMIT { public long PerProc, PerJob; public uint LimitFlags; public UIntPtr MinWs, MaxWs; public uint ActiveLimit; public UIntPtr Affinity; public uint Prio, Sched; }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] public struct EXT_LIMIT { public BASIC_LIMIT Basic; public IO_COUNTERS Io; public UIntPtr ProcMem, JobMem, PeakProcMem, PeakJobMem; }
  [StructLayout(LayoutKind.Sequential)] public struct ACCT { public long TU, TK, PU, PK; public uint Faults, TotalProcesses, ActiveProcesses, TotalTerminated; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct PE32 { public uint dwSize, cntUsage, pid; public IntPtr heap; public uint module, threads, ppid; public int pri; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe; }
  [StructLayout(LayoutKind.Sequential)] public struct SI { public int cb; public IntPtr r, desk, title; public int x, y, xs, ys, xc, yc, fill, flags; public short show, cbr2; public IntPtr r2, hIn, hOut, hErr; }
  [StructLayout(LayoutKind.Sequential)] public struct PI { public IntPtr hProcess, hThread; public uint pid, tid; }
  [StructLayout(LayoutKind.Sequential)] public struct PMC { public uint cb, faults; public UIntPtr peakWs, ws, a, b, c, d, pf, peakPf; }
  [StructLayout(LayoutKind.Sequential)] public struct SA { public int len; public IntPtr sd; public int inherit; }
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObjectW(IntPtr sa, string name);
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr OpenJobObjectW(uint acc, bool inh, string name);
  [DllImport("kernel32", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT_LIMIT info, int len);
  [DllImport("kernel32", SetLastError = true)] public static extern bool QueryInformationJobObject(IntPtr job, int cls, out ACCT info, int len, IntPtr ret);
  [DllImport("kernel32", SetLastError = true, EntryPoint = "QueryInformationJobObject")] public static extern bool QueryJobRaw(IntPtr job, int cls, IntPtr buf, int len, IntPtr ret);
  [DllImport("kernel32", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32", SetLastError = true)] public static extern bool IsProcessInJob(IntPtr proc, IntPtr job, out bool res);
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inh, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
  [DllImport("kernel32", SetLastError = true)] public static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32", SetLastError = true)] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool Process32FirstW(IntPtr s, ref PE32 e);
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool Process32NextW(IntPtr s, ref PE32 e);
  [DllImport("kernel32", SetLastError = true)] public static extern IntPtr OpenProcess(uint acc, bool inh, uint pid);
  [DllImport("kernel32", SetLastError = true)] public static extern bool GetProcessTimes(IntPtr h, out long c, out long e, out long k, out long u);
  [DllImport("kernel32", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32", SetLastError = true)] public static extern bool K32GetProcessMemoryInfo(IntPtr h, out PMC c, int cb);
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr h, uint f, StringBuilder sb, ref int size);
  [DllImport("kernel32", SetLastError = true)] public static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32", SetLastError = true)] public static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32", SetLastError = true)] public static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateFileW(string n, uint acc, uint share, ref SA sa, uint disp, uint flags, IntPtr t);
  [DllImport("kernel32", SetLastError = true)] public static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
  [DllImport("kernel32", SetLastError = true)] public static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint pid);
  [DllImport("kernel32", SetLastError = true)] public static extern uint GetFileType(IntPtr h);
  public const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  [StructLayout(LayoutKind.Sequential)] public struct SIEX { public SI si; public IntPtr attrs; }
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateProcessW")] public static extern bool CreateProcessExW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inh, uint flags, IntPtr env, string cwd, ref SIEX si, out PI pi);
  [DllImport("kernel32", SetLastError = true)] public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32", SetLastError = true)] public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr val, IntPtr size, IntPtr prev, IntPtr ret);
  [DllImport("kernel32")] public static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32", SetLastError = true)] public static extern bool DuplicateHandle(IntPtr sp, IntPtr s, IntPtr tp, out IntPtr t, uint acc, bool inh, uint opt);
  [DllImport("kernel32")] public static extern IntPtr GetCurrentProcess();
  [DllImport("ntdll")] public static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr buf, int len, out int ret);
  [DllImport("ntdll")] public static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
}

class Proc { public uint Pid, Ppid; public string Name, Cmd; public long Create, Ws; }
class Job { public IntPtr H; public string Id, OsName; }

static class P {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 64 };
  static readonly object OutLock = new object(), SpawnLock = new object(), JobLock = new object();
  static readonly Dictionary<string, Job> Jobs = new Dictionary<string, Job>();
  static readonly HashSet<uint> ProtectPids = new HashSet<uint>();
  static StreamWriter Out;
  static uint SelfPid, ParentPid; static long SelfCreate, ParentCreate;
  static readonly string[] Critical = { "[system process]", "system", "secure system", "registry", "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe", "services.exe", "lsass.exe", "svchost.exe", "dwm.exe", "fontdrvhost.exe", "sihost.exe", "lsaiso.exe", "memory compression" };
  static readonly string[] ProtectedNames = { "explorer.exe", "windowsterminal.exe", "openconsole.exe", "conhost.exe", "code.exe", "cursor.exe", "wsl.exe", "wslhost.exe", "wslservice.exe", "vmmem", "vmmemwsl", "herdr.exe" };

  static int Main(string[] args) {
    using (var me = Process.GetCurrentProcess()) SelfPid = (uint)me.Id;
    if (args.Length > 0 && args[0] == "run-in-job") return OneShot(args);
    SelfCreate = CreateTimeOf(SelfPid);
    IntPtr pbi = Marshal.AllocHGlobal(48); int got; // PROCESS_BASIC_INFORMATION: InheritedFromUniqueProcessId at offset 40
    if (W.NtQueryInformationProcess(W.GetCurrentProcess(), 0, pbi, 48, out got) == 0) ParentPid = (uint)Marshal.ReadInt64(pbi, 40);
    Marshal.FreeHGlobal(pbi);
    ParentCreate = CreateTimeOf(ParentPid);
    if (ParentCreate == 0 || ParentCreate > SelfCreate) { ParentPid = 0; ParentCreate = 0; } // parent gone or PID reused
    for (int i = 0; i < args.Length; i++) if (args[i] == "--protect" && i + 1 < args.Length) foreach (var s in args[++i].Split(',')) ProtectPids.Add(uint.Parse(s));
    return Serve();
  }

  // ---------- resident mode ----------
  static int Serve() {
    for (int n = -10; n >= -12; n--) W.SetHandleInformation(W.GetStdHandle(n), 1, 0); // our stdio must not leak into children
    Out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)); Out.AutoFlush = true;
    var ready = new Dictionary<string, object>();
    ready["event"] = "ready"; ready["pid"] = SelfPid; ready["createTime"] = SelfCreate.ToString(); ready["parentPid"] = ParentPid;
    ready["startupMs"] = (DateTime.UtcNow.ToFileTimeUtc() - SelfCreate) / 10000.0; ready["ws"] = Environment.WorkingSet;
    Emit(ready);
    var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    string line;
    while ((line = input.ReadLine()) != null) {
      if (line.Trim().Length == 0) continue;
      string l = line;
      ThreadPool.QueueUserWorkItem(delegate { Handle(l); });
    }
    Environment.Exit(0); // stdin EOF: orchestrad is gone; process exit closes every Job handle
    return 0;
  }

  static void Handle(string line) {
    object id = null; Dictionary<string, object> r;
    try {
      var a = Json.Deserialize<Dictionary<string, object>>(line);
      a.TryGetValue("id", out id);
      string cmd = S(a, "cmd");
      var sw = Stopwatch.StartNew();
      switch (cmd) {
        case "run-in-job": r = RunInJob(a); break;
        case "snapshot": r = SnapshotCmd(a); break;
        case "kill-job": r = KillJob(a); break;
        case "close-job": r = CloseJob(a); break;
        case "job-info": r = JobInfo(GetJob(S(a, "job"))); break;
        case "job-open": r = JobOpen(a); break;
        case "in-job": r = InJob(a); break;
        case "in-job-named": r = InJobNamed(a); break;
        case "kill-tree": r = KillTree(a); break;
        case "pipe-client-pid": r = PipeClientPid(a); break;
        case "pipe-peers": r = PipePeers(a); break;
        case "job-handles": r = JobHandles(a); break;
        case "file-busy": r = FileBusy(a); break;
        case "protect": foreach (var o in L(a, "pids")) ProtectPids.Add(Convert.ToUInt32(o)); r = Ok(); break;
        case "self": r = Ok(); r["pid"] = SelfPid; r["ws"] = Environment.WorkingSet; using (var me = Process.GetCurrentProcess()) { r["privateBytes"] = me.PrivateMemorySize64; r["peakWs"] = me.PeakWorkingSet64; r["threads"] = me.Threads.Count; } r["dotnetProcessCount"] = Process.GetProcesses().Length; break;
        case "alive": r = AliveCmd(a); break;
        case "ping": r = Ok(); break;
        default: r = Err("unknown-command"); break;
      }
      r["ms"] = sw.Elapsed.TotalMilliseconds;
    } catch (Exception e) { r = Err("exception"); r["message"] = e.GetType().Name + ": " + e.Message; }
    r["id"] = id;
    Emit(r);
  }

  static void Emit(Dictionary<string, object> r) { string s = Json.Serialize(r); lock (OutLock) Out.WriteLine(s); }

  // ---------- jobs and spawning ----------
  static Job GetJob(string id) { lock (JobLock) { Job j; if (id != null && Jobs.TryGetValue(id, out j)) return j; } throw new InvalidOperationException("no such job: " + id); }

  static IntPtr CreateKillOnCloseJob(string osName) {
    IntPtr h = W.CreateJobObjectW(IntPtr.Zero, osName);
    if (h == IntPtr.Zero) throw new Win32("CreateJobObject");
    var info = new W.EXT_LIMIT();
    info.Basic.LimitFlags = W.KILL_ON_JOB_CLOSE; // no BREAKAWAY_OK, no SILENT_BREAKAWAY_OK, no UI restrictions
    if (!W.SetInformationJobObject(h, 9, ref info, Marshal.SizeOf(typeof(W.EXT_LIMIT)))) { int e = Marshal.GetLastWin32Error(); W.CloseHandle(h); throw new Win32("SetInformationJobObject", e); }
    return h;
  }

  static Dictionary<string, object> RunInJob(Dictionary<string, object> a) {
    string jobId = S(a, "job") ?? "default"; bool created = false; Job job, parent = null;
    lock (JobLock) {
      if (!Jobs.TryGetValue(jobId, out job)) { job = new Job { Id = jobId, OsName = S(a, "jobName") }; job.H = CreateKillOnCloseJob(job.OsName); Jobs[jobId] = job; created = true; }
      if (S(a, "parentJob") != null) parent = Jobs[S(a, "parentJob")];
    }
    string cmdline = S(a, "cmdline"); if (cmdline == null) cmdline = string.Join(" ", L(a, "argv").Select(o => Quote(Convert.ToString(o))).ToArray());
    IntPtr env = IntPtr.Zero; int envCount = -1;
    if (S(a, "envAllowlist") != null) env = BuildEnv(File.ReadAllLines(S(a, "envAllowlist")), out envCount);
    var opened = new List<IntPtr>(); IntPtr attrs = IntPtr.Zero, hlist = IntPtr.Zero;
    try {
      var si = new W.SIEX(); si.si.cb = Marshal.SizeOf(typeof(W.SIEX)); si.si.flags = 0x100; // STARTF_USESTDHANDLES
      si.si.hIn = StdTarget(S(a, "stdin"), false, opened); si.si.hOut = StdTarget(S(a, "stdout"), true, opened); si.si.hErr = StdTarget(S(a, "stderr"), true, opened);
      if (a.ContainsKey("show")) { si.si.flags |= 0x1; si.si.show = Convert.ToInt16(a["show"]); }
      uint flags = W.CREATE_SUSPENDED | W.CREATE_UNICODE_ENV | (B(a, "noWindow", false) ? W.CREATE_NO_WINDOW : 0);
      // Commands run in parallel on the thread pool, so another call's inheritable handles may exist right now.
      // PROC_THREAD_ATTRIBUTE_HANDLE_LIST (0x20002) makes this child inherit only its own three std handles.
      // "legacyInherit" (test only) restores the old behaviour: inherit every inheritable handle of the helper.
      if (!B(a, "legacyInherit", false)) {
        hlist = Marshal.AllocHGlobal(3 * IntPtr.Size);
        Marshal.WriteIntPtr(hlist, 0, si.si.hIn); Marshal.WriteIntPtr(hlist, IntPtr.Size, si.si.hOut); Marshal.WriteIntPtr(hlist, 2 * IntPtr.Size, si.si.hErr);
        IntPtr size = IntPtr.Zero; W.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        IntPtr al = Marshal.AllocHGlobal(size);
        if (!W.InitializeProcThreadAttributeList(al, 1, 0, ref size)) { int e = Marshal.GetLastWin32Error(); Marshal.FreeHGlobal(al); throw new Win32("InitializeProcThreadAttributeList", e); }
        attrs = al;
        if (!W.UpdateProcThreadAttribute(attrs, 0, new IntPtr(0x20002), hlist, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32("UpdateProcThreadAttribute");
        si.attrs = attrs; flags |= W.EXTENDED_STARTUPINFO_PRESENT;
      } else si.si.cb = Marshal.SizeOf(typeof(W.SI));
      int hold = a.ContainsKey("holdMs") ? Convert.ToInt32(a["holdMs"]) : 0;
      if (hold > 0) Thread.Sleep(Math.Min(hold, 10000)); // test only: widen the window between creating our handles and spawning
      W.PI pi; var sw = Stopwatch.StartNew();
      lock (SpawnLock) {
        if (!W.CreateProcessExW(S(a, "app"), new StringBuilder(cmdline, 32768), IntPtr.Zero, IntPtr.Zero, true, flags, env, S(a, "cwd"), ref si, out pi)) throw new Win32("CreateProcess");
      }
      var r = Ok();
      if (parent != null && !W.AssignProcessToJobObject(parent.H, pi.hProcess)) { int e = Marshal.GetLastWin32Error(); W.TerminateProcess(pi.hProcess, 1); Close2(pi); throw new Win32("AssignProcessToJobObject(parent)", e); }
      if (!W.AssignProcessToJobObject(job.H, pi.hProcess)) { int e = Marshal.GetLastWin32Error(); W.TerminateProcess(pi.hProcess, 1); Close2(pi); throw new Win32("AssignProcessToJobObject", e); }
      bool inJob; W.IsProcessInJob(pi.hProcess, job.H, out inJob);
      W.ResumeThread(pi.hThread);
      long c, x, k, u; W.GetProcessTimes(pi.hProcess, out c, out x, out k, out u);
      Close2(pi);
      r["pid"] = pi.pid; r["createTime"] = c.ToString(); r["job"] = jobId; r["jobCreated"] = created; r["inJobBeforeResume"] = inJob;
      r["spawnMs"] = sw.Elapsed.TotalMilliseconds; if (envCount >= 0) r["envCount"] = envCount;
      return r;
    } finally {
      if (attrs != IntPtr.Zero) { W.DeleteProcThreadAttributeList(attrs); Marshal.FreeHGlobal(attrs); }
      if (hlist != IntPtr.Zero) Marshal.FreeHGlobal(hlist);
      foreach (var h in opened) W.CloseHandle(h);
      if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
    }
  }

  // Does anyone hold a handle to this file? Opening it with no sharing fails with 32 while any handle is open.
  static Dictionary<string, object> FileBusy(Dictionary<string, object> a) {
    var sa = new W.SA { len = Marshal.SizeOf(typeof(W.SA)) };
    IntPtr h = W.CreateFileW(S(a, "path"), 0x80000000u, 0, ref sa, 3, 0, IntPtr.Zero);
    var r = Ok();
    if (h == new IntPtr(-1)) { int e = Marshal.GetLastWin32Error(); r["busy"] = e == 32; r["win32"] = e; } else { W.CloseHandle(h); r["busy"] = false; }
    return r;
  }

  static void Close2(W.PI pi) { W.CloseHandle(pi.hThread); W.CloseHandle(pi.hProcess); }

  static IntPtr StdTarget(string spec, bool write, List<IntPtr> opened) {
    var sa = new W.SA { len = Marshal.SizeOf(typeof(W.SA)), inherit = 1 };
    string path = (spec == null || spec == "null") ? "NUL" : spec;
    uint disp = (path == "NUL" || !write) ? 3u : 4u; // OPEN_EXISTING : OPEN_ALWAYS
    IntPtr h = W.CreateFileW(path, write ? 0x40000000u | 0x80000000u : 0x80000000u, 7, ref sa, disp, 0, IntPtr.Zero);
    if (h == new IntPtr(-1)) throw new Win32("CreateFile(" + (path == "NUL" ? "NUL" : "file") + ")");
    if (write && path != "NUL") { long dummy = 0; SetFilePointerEx(h, 0, out dummy, 2); }
    opened.Add(h); return h;
  }
  [DllImport("kernel32", SetLastError = true)] static extern bool SetFilePointerEx(IntPtr h, long dist, out long newPos, uint method);

  // Environment from scratch: "NAME" copies our value if present, "NAME=VALUE" sets a literal, "#" comments.
  static IntPtr BuildEnv(string[] lines, out int count) {
    var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    foreach (var raw in lines) {
      string l = raw.Trim(); if (l.Length == 0 || l[0] == '#') continue;
      int eq = l.IndexOf('=', 1);
      if (eq > 0) env[l.Substring(0, eq)] = l.Substring(eq + 1);
      else { string v = Environment.GetEnvironmentVariable(l); if (v != null) env[l] = v; }
    }
    var sb = new StringBuilder();
    foreach (var kv in env) sb.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
    sb.Append('\0'); if (env.Count == 0) sb.Append('\0');
    count = env.Count;
    return Marshal.StringToHGlobalUni(sb.ToString());
  }

  static string Quote(string s) {
    if (s.Length > 0 && s.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return s;
    var sb = new StringBuilder("\""); int bs = 0;
    foreach (char ch in s) {
      if (ch == '\\') { bs++; continue; }
      if (ch == '"') { sb.Append('\\', bs * 2 + 1).Append('"'); bs = 0; continue; }
      sb.Append('\\', bs).Append(ch); bs = 0;
    }
    return sb.Append('\\', bs * 2).Append('"').ToString();
  }

  static Dictionary<string, object> KillJob(Dictionary<string, object> a) {
    var j = GetJob(S(a, "job")); var sw = Stopwatch.StartNew();
    if (!W.TerminateJobObject(j.H, 1)) throw new Win32("TerminateJobObject");
    int waitMs = a.ContainsKey("waitMs") ? Convert.ToInt32(a["waitMs"]) : 2000; W.ACCT acct;
    while (true) { if (!W.QueryInformationJobObject(j.H, 1, out acct, Marshal.SizeOf(typeof(W.ACCT)), IntPtr.Zero)) throw new Win32("QueryInformationJobObject"); if (acct.ActiveProcesses == 0 || sw.ElapsedMilliseconds > waitMs) break; Thread.Sleep(5); }
    var r = Ok(); r["zeroAfterMs"] = sw.Elapsed.TotalMilliseconds; r["activeProcesses"] = acct.ActiveProcesses; r["totalProcesses"] = acct.TotalProcesses; r["totalTerminated"] = acct.TotalTerminated;
    if (B(a, "close", false)) { CloseJob(a); r["closed"] = true; }
    return r;
  }

  static Dictionary<string, object> CloseJob(Dictionary<string, object> a) { var j = GetJob(S(a, "job")); lock (JobLock) Jobs.Remove(j.Id); W.CloseHandle(j.H); return Ok(); }

  static Dictionary<string, object> JobInfo(Job j) { var r = Acct(j.H); r["job"] = j.Id; return r; }

  static Dictionary<string, object> Acct(IntPtr h) {
    W.ACCT acct; if (!W.QueryInformationJobObject(h, 1, out acct, Marshal.SizeOf(typeof(W.ACCT)), IntPtr.Zero)) throw new Win32("QueryInformationJobObject");
    var r = Ok(); r["activeProcesses"] = acct.ActiveProcesses; r["totalProcesses"] = acct.TotalProcesses; r["totalTerminated"] = acct.TotalTerminated;
    r["limitFlags"] = QueryU32(h, 9, 16); r["uiRestrictions"] = QueryU32(h, 4, 0);
    int n = 1024; IntPtr buf = Marshal.AllocHGlobal(8 + 8 * n);
    try {
      var pids = new List<object>();
      if (W.QueryJobRaw(h, 3, buf, 8 + 8 * n, IntPtr.Zero)) { int cnt = Marshal.ReadInt32(buf, 4); for (int i = 0; i < cnt; i++) pids.Add((long)Marshal.ReadInt64(buf, 8 + 8 * i)); }
      r["pids"] = pids;
    } finally { Marshal.FreeHGlobal(buf); }
    return r;
  }

  static object QueryU32(IntPtr h, int cls, int off) { // cls 9: LimitFlags at offset 16; cls 4: UIRestrictionsClass
    int len = cls == 9 ? Marshal.SizeOf(typeof(W.EXT_LIMIT)) : 4; IntPtr b = Marshal.AllocHGlobal(len);
    try { return W.QueryJobRaw(h, cls, b, len, IntPtr.Zero) ? (object)(long)(uint)Marshal.ReadInt32(b, off) : null; } finally { Marshal.FreeHGlobal(b); }
  }

  // Job handles held by ownerPid (Chromium's browser holds one per sandboxed child): limits of each and which
  // of `pids` it contains. Walks the system handle table (SystemExtendedHandleInformation = 64, 40-byte x64
  // entries); reads only owner pid, handle value and type index, never object names.
  // Handle values of one type held by `owner`. The type index is learned from a probe handle of our own.
  static List<long> HandlesOfType(uint owner, IntPtr probe, out long total, out int typeIdx) {
    int len = 1 << 24, ret, st; IntPtr buf;
    while (true) {
      buf = Marshal.AllocHGlobal(len); st = W.NtQuerySystemInformation(64, buf, len, out ret);
      if ((uint)st != 0xC0000004) break;
      Marshal.FreeHGlobal(buf); len = Math.Max(len * 2, ret + (1 << 20));
    }
    var res = new List<long>(); typeIdx = -1; total = 0;
    try {
      if (st != 0) throw new InvalidOperationException("NtQuerySystemInformation(64) status 0x" + st.ToString("X"));
      total = Marshal.ReadInt64(buf, 0); long b0 = buf.ToInt64() + 16;
      for (long i = 0; i < total && typeIdx < 0; i++) { long ep = b0 + i * 40; if (Marshal.ReadInt64(new IntPtr(ep + 8)) == SelfPid && Marshal.ReadInt64(new IntPtr(ep + 16)) == probe.ToInt64()) typeIdx = (ushort)Marshal.ReadInt16(new IntPtr(ep + 30)); }
      if (typeIdx < 0) return res;
      for (long i = 0; i < total; i++) { long ep = b0 + i * 40; if (Marshal.ReadInt64(new IntPtr(ep + 8)) == owner && (ushort)Marshal.ReadInt16(new IntPtr(ep + 30)) == typeIdx) res.Add(Marshal.ReadInt64(new IntPtr(ep + 16))); }
    } finally { Marshal.FreeHGlobal(buf); }
    return res;
  }

  static Dictionary<string, object> JobHandles(Dictionary<string, object> a) {
    uint owner = Convert.ToUInt32(a["ownerPid"]); var targets = L(a, "pids").Select(o => Convert.ToUInt32(o)).ToList();
    IntPtr probe = W.CreateJobObjectW(IntPtr.Zero, null); if (probe == IntPtr.Zero) throw new Win32("CreateJobObject(probe)");
    int typeIdx, ownerJobs = 0; long total; var jobs = new List<object>(); List<long> hs;
    try { hs = HandlesOfType(owner, probe, out total, out typeIdx); } finally { W.CloseHandle(probe); }
    if (typeIdx < 0) return Err("job-type-not-found");
    {
      IntPtr ownerH = W.OpenProcess(W.PDUP, false, owner); if (ownerH == IntPtr.Zero) throw new Win32("OpenProcess(DUP)");
      var th = new Dictionary<uint, IntPtr>();
      foreach (var t in targets) { IntPtr x = W.OpenProcess(W.PQLI, false, t); if (x != IntPtr.Zero) th[t] = x; }
      try {
        foreach (long hv in hs) {
          ownerJobs++; var d = new Dictionary<string, object>(); IntPtr dup;
          if (!W.DuplicateHandle(ownerH, new IntPtr(hv), W.GetCurrentProcess(), out dup, W.JOB_QUERY, false, 0)) { d["dupError"] = Marshal.GetLastWin32Error(); jobs.Add(d); continue; }
          try {
            W.ACCT acct; if (W.QueryInformationJobObject(dup, 1, out acct, Marshal.SizeOf(typeof(W.ACCT)), IntPtr.Zero)) d["activeProcesses"] = acct.ActiveProcesses;
            d["limitFlags"] = QueryU32(dup, 9, 16); d["uiRestrictions"] = QueryU32(dup, 4, 0);
            var members = new List<object>(); foreach (var kv in th) { bool inj; if (W.IsProcessInJob(kv.Value, dup, out inj) && inj) members.Add(kv.Key); }
            d["members"] = members; jobs.Add(d);
          } finally { W.CloseHandle(dup); }
        }
      } finally { W.CloseHandle(ownerH); foreach (var x in th.Values) W.CloseHandle(x); }
    }
    var r = Ok(); r["systemHandles"] = total; r["jobTypeIndex"] = typeIdx; r["ownerJobHandles"] = ownerJobs; r["jobs"] = jobs; return r;
  }

  // Path B for §8.5 (review S4-PROCGUARD-06): orchestrad (Node) owns the pipe server but cannot hand us its
  // HANDLE, so walk its File handles, duplicate each and ask GetNamedPipeServer/ClientProcessId. Never reads
  // object names. Each query runs on its own thread with a timeout: I/O on a synchronous file object that has
  // a pending read in the owner can block; a stuck query is abandoned (thread and duplicate leak by design).
  static Dictionary<string, object> PipePeers(Dictionary<string, object> a) {
    uint owner = Convert.ToUInt32(a["ownerPid"]); int perMs = a.ContainsKey("perHandleMs") ? Convert.ToInt32(a["perHandleMs"]) : 250;
    var sa = new W.SA { len = Marshal.SizeOf(typeof(W.SA)) };
    IntPtr probe = W.CreateFileW("NUL", 0x80000000u, 7, ref sa, 3, 0, IntPtr.Zero); if (probe == new IntPtr(-1)) throw new Win32("CreateFile(NUL)");
    var sw = Stopwatch.StartNew(); int typeIdx; long total; List<long> hs;
    try { hs = HandlesOfType(owner, probe, out total, out typeIdx); } finally { W.CloseHandle(probe); }
    double scanMs = sw.Elapsed.TotalMilliseconds;
    if (typeIdx < 0) return Err("file-type-not-found");
    IntPtr ownerH = W.OpenProcess(W.PDUP, false, owner); if (ownerH == IntPtr.Zero) throw new Win32("OpenProcess(DUP)");
    var pipes = new List<object>(); int dupFail = 0, notPipe = 0, timeouts = 0;
    try {
      foreach (long hv in hs) {
        IntPtr dup; if (!W.DuplicateHandle(ownerH, new IntPtr(hv), W.GetCurrentProcess(), out dup, 0, false, 2)) { dupFail++; continue; }
        uint type = 0, srv = 0, cli = 0; bool gs = false, gc = false; IntPtr d = dup;
        var t = new Thread(delegate () { type = W.GetFileType(d); if (type == 3) { gs = W.GetNamedPipeServerProcessId(d, out srv); gc = W.GetNamedPipeClientProcessId(d, out cli); } });
        t.IsBackground = true; t.Start();
        if (!t.Join(perMs)) { timeouts++; continue; }
        W.CloseHandle(dup);
        if (type != 3 || !gs) { notPipe++; continue; } // sockets also report FILE_TYPE_PIPE; they fail the pipe query
        var e = new Dictionary<string, object>(); e["handle"] = hv; e["serverPid"] = srv; e["clientPid"] = gc ? (object)cli : null; pipes.Add(e);
      }
    } finally { W.CloseHandle(ownerH); }
    var r = Ok(); r["systemHandles"] = total; r["ownerFileHandles"] = hs.Count; r["scanMs"] = scanMs; r["dupFailed"] = dupFail; r["notPipe"] = notPipe; r["timeouts"] = timeouts; r["pipes"] = pipes; return r;
  }

  // Opens a named job only for a moment (caller must not do this before the owner's last handle closes,
  // or the extra handle would postpone KILL_ON_JOB_CLOSE).
  static Dictionary<string, object> JobOpen(Dictionary<string, object> a) {
    IntPtr h = W.OpenJobObjectW(W.JOB_QUERY, false, S(a, "name"));
    if (h == IntPtr.Zero) { var e = Err("open-failed"); e["win32"] = Marshal.GetLastWin32Error(); return e; }
    try { return Acct(h); } finally { W.CloseHandle(h); }
  }

  static Dictionary<string, object> InJob(Dictionary<string, object> a) {
    IntPtr jh = S(a, "job") == null ? IntPtr.Zero : GetJob(S(a, "job")).H;
    var r = Ok(); r["results"] = InJobList(jh, L(a, "pids")); return r;
  }

  static Dictionary<string, object> InJobNamed(Dictionary<string, object> a) {
    IntPtr h = W.OpenJobObjectW(W.JOB_QUERY, false, S(a, "name"));
    if (h == IntPtr.Zero) { var e = Err("open-failed"); e["win32"] = Marshal.GetLastWin32Error(); return e; }
    try { var r = Ok(); r["results"] = InJobList(h, L(a, "pids")); return r; } finally { W.CloseHandle(h); }
  }

  static List<object> InJobList(IntPtr jh, IEnumerable<object> pids) {
    var res = new List<object>();
    foreach (var o in pids) {
      uint pid = Convert.ToUInt32(o); var d = new Dictionary<string, object>(); d["pid"] = pid;
      IntPtr h = W.OpenProcess(W.PQLI, false, pid);
      if (h == IntPtr.Zero) { d["error"] = Marshal.GetLastWin32Error(); res.Add(d); continue; }
      bool any, mine = false; W.IsProcessInJob(h, IntPtr.Zero, out any); d["inAnyJob"] = any;
      if (jh != IntPtr.Zero) { if (W.IsProcessInJob(h, jh, out mine)) d["inJob"] = mine; else d["inJobError"] = Marshal.GetLastWin32Error(); }
      W.CloseHandle(h); res.Add(d);
    }
    return res;
  }

  static bool InOurJobs(uint pid) {
    IntPtr h = W.OpenProcess(W.PQLI, false, pid); if (h == IntPtr.Zero) return false;
    try { lock (JobLock) foreach (var j in Jobs.Values) { bool b; if (W.IsProcessInJob(h, j.H, out b) && b) return true; } } finally { W.CloseHandle(h); }
    return false;
  }

  // ---------- snapshot ----------
  static int LastRaw, LastZombie, LastOpenFail, LastErr;
  static List<Proc> Snapshot(bool wantCmd) {
    var list = new List<Proc>(); int raw = 0, zom = 0, of = 0;
    IntPtr s = W.CreateToolhelp32Snapshot(2, 0); if (s == new IntPtr(-1)) throw new Win32("CreateToolhelp32Snapshot");
    try {
      var e = new W.PE32(); e.dwSize = (uint)Marshal.SizeOf(typeof(W.PE32));
      if (!W.Process32FirstW(s, ref e)) return list;
      do {
        raw++; var p = new Proc { Pid = e.pid, Ppid = e.ppid, Name = e.exe };
        IntPtr h = e.pid == 0 ? IntPtr.Zero : W.OpenProcess(W.PQLI, false, e.pid);
        if (h != IntPtr.Zero) {
          uint code; bool zombie = W.GetExitCodeProcess(h, out code) && code != W.STILL_ACTIVE;
          long c, x, k, u; if (W.GetProcessTimes(h, out c, out x, out k, out u)) p.Create = c;
          W.PMC m; if (W.K32GetProcessMemoryInfo(h, out m, Marshal.SizeOf(typeof(W.PMC)))) p.Ws = (long)m.ws.ToUInt64();
          if (wantCmd) p.Cmd = CmdLine(h);
          W.CloseHandle(h);
          if (zombie) { zom++; continue; }
        } else of++;
        list.Add(p);
      } while (W.Process32NextW(s, ref e));
      LastErr = Marshal.GetLastWin32Error();
    } finally { W.CloseHandle(s); }
    LastRaw = raw; LastZombie = zom; LastOpenFail = of;
    return list;
  }

  // NtQueryInformationProcess(ProcessCommandLineInformation = 60) needs only PROCESS_QUERY_LIMITED_INFORMATION.
  static string CmdLine(IntPtr h) {
    int len = 2048;
    for (int tries = 0; tries < 3; tries++) {
      IntPtr buf = Marshal.AllocHGlobal(len);
      try {
        int ret; int st = W.NtQueryInformationProcess(h, 60, buf, len, out ret);
        if (st == 0) { int bytes = (ushort)Marshal.ReadInt16(buf, 0); IntPtr p = Marshal.ReadIntPtr(buf, 8); return p == IntPtr.Zero ? "" : Marshal.PtrToStringUni(p, bytes / 2); }
        if ((uint)st == 0xC0000004 && ret > len) { len = ret; continue; }
        return null;
      } finally { Marshal.FreeHGlobal(buf); }
    }
    return null;
  }

  static string ImagePath(uint pid) {
    IntPtr h = W.OpenProcess(W.PQLI, false, pid); if (h == IntPtr.Zero) return null;
    try { var sb = new StringBuilder(1024); int n = sb.Capacity; return W.QueryFullProcessImageNameW(h, 0, sb, ref n) ? sb.ToString() : null; } finally { W.CloseHandle(h); }
  }

  // Cheap liveness by identity: no enumeration, just OpenProcess + create time + exit code per entry.
  static Dictionary<string, object> AliveCmd(Dictionary<string, object> a) {
    var live = new List<object>();
    foreach (var o in L(a, "procs")) {
      var d = (Dictionary<string, object>)o; uint pid = Convert.ToUInt32(d["pid"]); string ct = S(d, "createTime");
      IntPtr h = W.OpenProcess(W.PQLI, false, pid); if (h == IntPtr.Zero) continue;
      long c, x, k, u; uint code;
      bool ok = W.GetProcessTimes(h, out c, out x, out k, out u) && c.ToString() == ct && W.GetExitCodeProcess(h, out code) && code == W.STILL_ACTIVE;
      W.CloseHandle(h); if (ok) live.Add(pid + ":" + ct);
    }
    var r = Ok(); r["alive"] = live; return r;
  }

  static long CreateTimeOf(uint pid) {
    IntPtr h = W.OpenProcess(W.PQLI, false, pid); if (h == IntPtr.Zero) return 0;
    try { long c, x, k, u; return W.GetProcessTimes(h, out c, out x, out k, out u) ? c : 0; } finally { W.CloseHandle(h); }
  }

  static Dictionary<string, object> PD(Proc p, bool cmd) {
    var d = new Dictionary<string, object>(); d["pid"] = p.Pid; d["ppid"] = p.Ppid; d["name"] = p.Name; d["createTime"] = p.Create.ToString(); d["ws"] = p.Ws;
    if (cmd) d["cmdline"] = p.Cmd; return d;
  }

  static Dictionary<string, object> SnapshotCmd(Dictionary<string, object> a) {
    bool cmd = B(a, "cmdline", true); var sw = Stopwatch.StartNew();
    var snap = Snapshot(cmd); double enumMs = sw.Elapsed.TotalMilliseconds;
    IEnumerable<Proc> sel = snap;
    if (a.ContainsKey("under")) { var u = (Dictionary<string, object>)a["under"]; int pr; sel = Tree(snap, Convert.ToUInt32(u["pid"]), long.Parse(S(u, "createTime")), out pr); }
    if (a.ContainsKey("pids")) { var want = new HashSet<uint>(L(a, "pids").Select(o => Convert.ToUInt32(o))); sel = sel.Where(p => want.Contains(p.Pid)); }
    var jobs = L(a, "jobs").Select(o => GetJob(Convert.ToString(o))).ToList();
    var outl = new List<object>();
    foreach (var p in sel) {
      var d = PD(p, cmd);
      if (jobs.Count > 0) { var m = new Dictionary<string, object>(); foreach (var j in jobs) { var r = InJobList(j.H, new object[] { p.Pid }); m[j.Id] = ((Dictionary<string, object>)r[0]).ContainsKey("inJob") ? ((Dictionary<string, object>)r[0])["inJob"] : null; } d["inJob"] = m; }
      outl.Add(d);
    }
    var res = Ok(); res["total"] = snap.Count; res["cmdlineNull"] = cmd ? snap.Count(p => p.Cmd == null) : -1; res["enumMs"] = enumMs; res["raw"] = LastRaw; res["zombies"] = LastZombie; res["openFailed"] = LastOpenFail; res["lastError"] = LastErr; res["procs"] = outl;
    return res;
  }

  // Safe traversal (§10.5): an edge parent->child counts only if child.Create >= parent.Create; else PID reuse, prune.
  static List<Proc> Tree(List<Proc> snap, uint rootPid, long rootCreate, out int pruned) {
    pruned = 0; var res = new List<Proc>(); var seen = new HashSet<uint>();
    if (rootCreate == 0) return res; // root identity unknown (process not openable): no edge can be checked
    var byParent = snap.ToLookup(p => p.Ppid);
    var root = snap.FirstOrDefault(p => p.Pid == rootPid && p.Create == rootCreate);
    if (root != null) res.Add(root);
    var q = new Queue<KeyValuePair<uint, long>>(); q.Enqueue(new KeyValuePair<uint, long>(rootPid, rootCreate)); seen.Add(rootPid);
    while (q.Count > 0) {
      var cur = q.Dequeue();
      foreach (var c in byParent[cur.Key]) {
        if (c.Pid == cur.Key || seen.Contains(c.Pid)) continue;
        if (c.Create == 0 || c.Create < cur.Value) { pruned++; continue; }
        seen.Add(c.Pid); res.Add(c); q.Enqueue(new KeyValuePair<uint, long>(c.Pid, c.Create));
      }
    }
    return res;
  }

  // ---------- kill-tree ----------
  static string Classify(Proc p, bool synthetic) {
    string n = (p.Name ?? "").ToLowerInvariant(), c = (p.Cmd ?? "").ToLowerInvariant();
    if (p.Pid == SelfPid) return "procguard-self";
    if (p.Pid == ParentPid && p.Create == ParentCreate) return "orchestrad";
    if (Critical.Contains(n)) return "critical:" + n;
    if (ProtectPids.Contains(p.Pid)) return "protected-pid";
    string host = HostReason(p, n, c, synthetic);
    if (host == null) return null;
    if (!synthetic && InOurJobs(p.Pid)) return host == "browser-not-ours" ? null : "owned-host:" + host; // our lease browser is ours; our own hosts go through the reaper (§10.5 item 3)
    return host;
  }

  // Hosts by image name + command line (§10.5 item 3). The parent-chain rule and a configurable list of
  // UI browsers are not implemented in this spike.
  static string HostReason(Proc p, string n, string c, bool synthetic) {
    if (ProtectedNames.Contains(n)) return "host:" + n;
    if (n == "chrome.exe" || n == "msedge.exe") return "browser-not-ours";
    string img = synthetic ? "" : (ImagePath(p.Pid) ?? "").ToLowerInvariant();
    if (n == "codex.exe" && c.Contains("app-server")) return "codex-app-server";
    if (n == "codex.exe" && img.Contains("\\windowsapps\\")) return "codex-desktop";
    if (n == "claude.exe" && (img.Contains("\\windowsapps\\") || img.Contains("anthropicclaude"))) return "claude-desktop";
    if (n == "node.exe" || n == "bun.exe") {
      if (c.Contains(".ds-bot")) return "ds-bot-engine";
      if (c.Contains("dsh") && c.Contains(" web")) return "dsh-web-host";
      if (c.Contains("dsh") && c.Contains("desktop")) return "dsh-desktop-host";
    }
    if (n == "bash.exe" && c.Contains("watchdog")) return "watchdog-bash";
    return null;
  }

  static Dictionary<string, object> KillTree(Dictionary<string, object> a) {
    uint pid = Convert.ToUInt32(a["pid"]); string ct = S(a, "createTime");
    // §10.5 item 4: by default only the descendants below the harness process; the root itself needs its token.
    bool includeRoot = B(a, "includeRoot", false), dry = B(a, "dryRun", false), synthetic = a.ContainsKey("procs");
    if (synthetic && !dry) return Err("procs-override-requires-dryRun");
    if (ct == null || ct == "0") return Err("identity-unknown"); // no create time: PID reuse cannot be ruled out
    var confirm = new HashSet<string>(L(a, "confirm").Select(o => Convert.ToString(o)));
    var snap = synthetic ? L(a, "procs").Select(o => { var d = (Dictionary<string, object>)o; return new Proc { Pid = Convert.ToUInt32(d["pid"]), Ppid = Convert.ToUInt32(d["ppid"]), Name = S(d, "name"), Create = long.Parse(S(d, "createTime")), Cmd = S(d, "cmdline") }; }).ToList() : Snapshot(true);
    var root = snap.FirstOrDefault(p => p.Pid == pid);
    if (root == null) return Err("not-found");
    if (root.Create == 0) return Err("identity-unknown"); // root cannot be opened, so its create time is unknown
    if (root.Create.ToString() != ct) { var e = Err("create-time-mismatch"); e["actual"] = root.Create.ToString(); return e; }
    int pruned; var tree = Tree(snap, root.Pid, root.Create, out pruned);
    var targets = tree.Where(p => includeRoot || p != root).ToList();
    var prot = new List<object>(); bool refuse = false;
    // The root is always classified, even when only its descendants die: the children of a protected
    // multi-session host (dsh web, explorer, ...) are not ours to kill either.
    string rootWhy = Classify(root, synthetic);
    if (rootWhy == null && includeRoot) rootWhy = "harness-root";
    foreach (var t in targets.Where(p => p != root).Concat(rootWhy != null ? new[] { root } : new Proc[0])) {
      if (t != root && IsOwnConhost(t, tree)) continue; // a conhost whose console client is being killed is not your terminal
      string why = t == root ? rootWhy : Classify(t, synthetic); if (why == null) continue;
      bool ok = !why.StartsWith("critical") && why != "procguard-self" && why != "orchestrad" && confirm.Contains(t.Pid + ":" + t.Create);
      var d = new Dictionary<string, object>(); d["pid"] = t.Pid; d["name"] = t.Name; d["reason"] = why; d["confirmed"] = ok; prot.Add(d);
      if (!ok) refuse = true;
    }
    if (refuse) { var e = Err("protected"); e["protected"] = prot; e["pruned"] = pruned; return e; }
    if (dry) { var r0 = Ok(); r0["dryRun"] = true; r0["plan"] = targets.Select(p => (object)PD(p, false)).ToList(); r0["pruned"] = pruned; r0["protected"] = prot; return r0; }
    var killed = new List<object>(); int rounds = 0;
    for (rounds = 1; rounds <= 5 && targets.Count > 0; rounds++) {
      foreach (var t in targets) if (KillExact(t.Pid, t.Create)) killed.Add(PD(t, false));
      Thread.Sleep(30);
      int pr2; snap = Snapshot(true);
      var againFull = Tree(snap, root.Pid, root.Create, out pr2);
      var again = againFull.Where(p => includeRoot || !(p.Pid == root.Pid && p.Create == root.Create)).ToList();
      var fresh = again.Where(p => !IsOwnConhost(p, againFull) && Classify(p, false) != null && !confirm.Contains(p.Pid + ":" + p.Create)).ToList();
      if (fresh.Count > 0) { var e = Err("protected-appeared"); e["killed"] = killed; e["rounds"] = rounds; return e; }
      targets = again;
    }
    var r = Ok(); r["killed"] = killed; r["rounds"] = rounds - 1; r["remaining"] = targets.Count; r["pruned"] = pruned; r["protected"] = prot;
    if (targets.Count > 0) r["ok"] = false;
    return r;
  }

  static bool IsOwnConhost(Proc p, List<Proc> set) {
    if (!string.Equals(p.Name, "conhost.exe", StringComparison.OrdinalIgnoreCase)) return false;
    return set.Any(q => q.Pid == p.Ppid && q.Create <= p.Create && q != p);
  }

  static bool KillExact(uint pid, long create) {
    IntPtr h = W.OpenProcess(W.PTERM | W.PQLI, false, pid); if (h == IntPtr.Zero) return false;
    try { long c, x, k, u; if (!W.GetProcessTimes(h, out c, out x, out k, out u) || c != create) return false; return W.TerminateProcess(h, 1); } finally { W.CloseHandle(h); }
  }

  // ---------- pipe-client-pid ----------
  static Dictionary<string, object> PipeClientPid(Dictionary<string, object> a) {
    uint client;
    if (a.ContainsKey("ownerPid")) { // orchestrad owns the server end: duplicate its handle and ask
      IntPtr owner = W.OpenProcess(W.PDUP, false, Convert.ToUInt32(a["ownerPid"])); if (owner == IntPtr.Zero) throw new Win32("OpenProcess(DUP)");
      IntPtr dup; bool ok = W.DuplicateHandle(owner, new IntPtr(Convert.ToInt64(a["handle"])), W.GetCurrentProcess(), out dup, 0, false, 2);
      int e = Marshal.GetLastWin32Error(); W.CloseHandle(owner); if (!ok) throw new Win32("DuplicateHandle", e);
      bool got = W.GetNamedPipeClientProcessId(dup, out client); e = Marshal.GetLastWin32Error(); W.CloseHandle(dup); if (!got) throw new Win32("GetNamedPipeClientProcessId", e);
    } else { // helper owns the server end
      int timeout = a.ContainsKey("timeoutMs") ? Convert.ToInt32(a["timeoutMs"]) : 5000;
      using (var srv = new NamedPipeServerStream(S(a, "name"), PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous)) {
        var ar = srv.BeginWaitForConnection(null, null);
        if (!ar.AsyncWaitHandle.WaitOne(timeout)) return Err("timeout");
        srv.EndWaitForConnection(ar);
        if (!W.GetNamedPipeClientProcessId(srv.SafePipeHandle.DangerousGetHandle(), out client)) throw new Win32("GetNamedPipeClientProcessId");
        var bytes = Encoding.ASCII.GetBytes("ok\n"); srv.Write(bytes, 0, bytes.Length); srv.Flush();
      }
    }
    var r = Ok(); r["clientPid"] = client; long cc = CreateTimeOf(client); r["clientCreateTime"] = cc.ToString();
    var snap = Snapshot(false); var chain = new List<object>(); uint cur = client; long curC = cc;
    for (int i = 0; i < 16; i++) { var me = snap.FirstOrDefault(p => p.Pid == cur); if (me == null) break; var par = snap.FirstOrDefault(p => p.Pid == me.Ppid); if (par == null || par.Create == 0 || par.Create > curC) break; chain.Add(par.Pid); cur = par.Pid; curC = par.Create; }
    r["ancestors"] = chain; return r;
  }

  // ---------- one-shot mode ----------
  static int OneShot(string[] args) {
    string osName = null, allow = null; bool noWin = false; int i = 1;
    for (; i < args.Length; i++) {
      if (args[i] == "--") { i++; break; }
      else if (args[i] == "--job") i++;
      else if (args[i] == "--name") osName = args[++i];
      else if (args[i] == "--env-allowlist") allow = args[++i];
      else if (args[i] == "--no-window") noWin = true;
      else { Console.Error.WriteLine("procguard: unknown option " + args[i]); return 2; }
    }
    if (i >= args.Length) { Console.Error.WriteLine("usage: procguard run-in-job [--name N] [--env-allowlist F] [--no-window] -- cmd [args]"); return 2; }
    string cmdline = string.Join(" ", args.Skip(i).Select(Quote).ToArray());
    IntPtr env = IntPtr.Zero; int cnt;
    try {
      IntPtr job = CreateKillOnCloseJob(osName);
      if (allow != null) env = BuildEnv(File.ReadAllLines(allow), out cnt);
      var si = new W.SI(); si.cb = Marshal.SizeOf(typeof(W.SI)); si.flags = 0x100;
      si.hIn = W.GetStdHandle(-10); si.hOut = W.GetStdHandle(-11); si.hErr = W.GetStdHandle(-12);
      W.PI pi;
      if (!W.CreateProcessW(null, new StringBuilder(cmdline, 32768), IntPtr.Zero, IntPtr.Zero, true, W.CREATE_SUSPENDED | W.CREATE_UNICODE_ENV | (noWin ? W.CREATE_NO_WINDOW : 0), env, null, ref si, out pi)) throw new Win32("CreateProcess");
      if (!W.AssignProcessToJobObject(job, pi.hProcess)) { int e = Marshal.GetLastWin32Error(); W.TerminateProcess(pi.hProcess, 1); throw new Win32("AssignProcessToJobObject", e); }
      W.ResumeThread(pi.hThread); W.CloseHandle(pi.hThread);
      W.WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
      uint code; W.GetExitCodeProcess(pi.hProcess, out code);
      return (int)code; // returning closes the Job handle: leftovers in the Job die with us
    } catch (Win32 e) { Console.Error.WriteLine("procguard: " + e.Message); return 125; }
  }

  // ---------- small helpers ----------
  static Dictionary<string, object> Ok() { var d = new Dictionary<string, object>(); d["ok"] = true; return d; }
  static Dictionary<string, object> Err(string code) { var d = new Dictionary<string, object>(); d["ok"] = false; d["error"] = code; return d; }
  static string S(Dictionary<string, object> a, string k) { object v; return a.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : null; }
  static bool B(Dictionary<string, object> a, string k, bool def) { object v; return a.TryGetValue(k, out v) && v != null ? Convert.ToBoolean(v) : def; }
  static IEnumerable<object> L(Dictionary<string, object> a, string k) { object v; if (!a.TryGetValue(k, out v) || v == null || v is string) return new object[0]; return ((IEnumerable)v).Cast<object>(); }
}

class Win32 : Exception {
  public Win32(string where) : this(where, Marshal.GetLastWin32Error()) { }
  public Win32(string where, int code) : base(where + " failed, win32=" + code) { Data["win32"] = code; }
}
}
