// ProcGuard.cs - orchestrad's process guard for its owned sessions (r4 D4: every owned child tree in a Job
// of its own that dies when it closes). Grown from the S4 spike (spikes/s4-procguard, REPORT.md); only
// what the owned sessions need is kept. C# 5 / .NET Framework 4.x, built only by the system csc.exe with
// the fixed flags of src/os/spawn.ts CSC_FLAGS (src/os/procguard.ts builds it into
// ORCHESTRA_HOME\runtime\procguard\<sha256 of this file>\ and pins the result by its sha256).
//
//   procguard.exe run-in-job --name <job> --env-allowlist <file> -- <exe> [args]
//       One-shot, one per owned session. Makes a Job named <job> (KILL_ON_JOB_CLOSE; no BREAKAWAY_OK, no
//       SILENT_BREAKAWAY_OK, no UI limits; an existing name is refused, never joined), creates <exe>
//       suspended and already inside the Job (PROC_THREAD_ATTRIBUTE_JOB_LIST: no moment outside it, even
//       when we die during the start), with an environment built from zero (each name in <file>, its
//       value copied from ours), letting it inherit only our three std handles
//       (PROC_THREAD_ATTRIBUTE_HANDLE_LIST); checks it is in the Job (IsProcessInJob; assigns it when
//       not, as a second guard), resumes it, waits for it and exits with its exit code. Our stdio is the child's, so the
//       session's JSON-RPC or host pipes pass straight through. However we exit (the child exited,
//       orchestrad killed us, orchestrad died and its own Job took us), the Job's last handle closes with
//       us and every process still in it dies. Our own failures exit 125 with one line on stderr.
//   procguard.exe
//       Resident, one per orchestrad: one JSON command per line on stdin, one JSON result per line on
//       stdout; on stdin EOF it lets the commands it took answer (at most DrainMs), then exits.
//       ping; job-info {name}; kill-job {name, waitMs}; alive {procs}.
//       It opens a Job by name only for the command and closes it before it answers.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace ProcGuard {

static class W {
  public const uint KILL_ON_JOB_CLOSE = 0x2000, CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENV = 0x400, EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  public const uint PQLI = 0x1000, JOB_QUERY = 0x4, JOB_TERMINATE = 0x8, STILL_ACTIVE = 259;
  public const int ERROR_ALREADY_EXISTS = 183, ERROR_FILE_NOT_FOUND = 2, ERROR_MORE_DATA = 234;
  /** ProcThreadAttributeValue(ProcThreadAttributeHandleList = 2 / ProcThreadAttributeJobList = 13, input). */
  public static readonly IntPtr ATTR_HANDLE_LIST = new IntPtr(0x20002), ATTR_JOB_LIST = new IntPtr(0x2000D);
  [StructLayout(LayoutKind.Sequential)] public struct BASIC_LIMIT { public long PerProc, PerJob; public uint LimitFlags; public UIntPtr MinWs, MaxWs; public uint ActiveLimit; public UIntPtr Affinity; public uint Prio, Sched; }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] public struct EXT_LIMIT { public BASIC_LIMIT Basic; public IO_COUNTERS Io; public UIntPtr ProcMem, JobMem, PeakProcMem, PeakJobMem; }
  [StructLayout(LayoutKind.Sequential)] public struct ACCT { public long TU, TK, PU, PK; public uint Faults, TotalProcesses, ActiveProcesses, TotalTerminated; }
  [StructLayout(LayoutKind.Sequential)] public struct SI { public int cb; public IntPtr r, desk, title; public int x, y, xs, ys, xc, yc, fill, flags; public short show, cbr2; public IntPtr r2, hIn, hOut, hErr; }
  [StructLayout(LayoutKind.Sequential)] public struct SIEX { public SI si; public IntPtr attrs; }
  [StructLayout(LayoutKind.Sequential)] public struct PI { public IntPtr hProcess, hThread; public uint pid, tid; }
  [StructLayout(LayoutKind.Sequential)] public struct SA { public int len; public IntPtr sd; public int inherit; }
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObjectW(ref SA sa, string name);
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr OpenJobObjectW(uint acc, bool inh, string name);
  [DllImport("kernel32", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT_LIMIT info, int len);
  [DllImport("kernel32", SetLastError = true)] public static extern bool QueryInformationJobObject(IntPtr job, int cls, out ACCT info, int len, IntPtr ret);
  [DllImport("kernel32", SetLastError = true, EntryPoint = "QueryInformationJobObject")] public static extern bool QueryJobRaw(IntPtr job, int cls, IntPtr buf, int len, IntPtr ret);
  [DllImport("kernel32", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32", SetLastError = true)] public static extern bool IsProcessInJob(IntPtr proc, IntPtr job, out bool result);
  [DllImport("kernel32", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inh, uint flags, IntPtr env, string cwd, ref SIEX si, out PI pi);
  [DllImport("kernel32", SetLastError = true)] public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32", SetLastError = true)] public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr val, IntPtr size, IntPtr prev, IntPtr ret);
  [DllImport("kernel32")] public static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32", SetLastError = true)] public static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32", SetLastError = true)] public static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32", SetLastError = true)] public static extern IntPtr OpenProcess(uint acc, bool inh, uint pid);
  [DllImport("kernel32", SetLastError = true)] public static extern bool GetProcessTimes(IntPtr h, out long c, out long e, out long k, out long u);
  [DllImport("kernel32", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32", SetLastError = true)] public static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr h, uint f, StringBuilder sb, ref int size);
  [DllImport("advapi32", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint rev, out IntPtr sd, IntPtr size);
  [DllImport("kernel32")] public static extern IntPtr LocalFree(IntPtr h);
}

class Fail : Exception {
  public Fail(string where) : this(where, Marshal.GetLastWin32Error()) { }
  public Fail(string where, int code) : base(where + " failed, win32=" + code) { }
}

static class P {
  /** The Job names orchestrad gives (src/os/procguard.ts PROCGUARD_JOB_RE). */
  static readonly Regex JobName = new Regex("^orchestra-job-[0-9a-f]{32}$");
  static readonly Regex EnvName = new Regex("^[A-Za-z_][A-Za-z0-9_]*$");
  // Who may open a Job by its name: only its owner (OW), and only to query and terminate it (and wait on
  // it). Nobody can open it by name to change its limits (BREAKAWAY_OK) or its DACL. The handle the
  // creator gets back from CreateJobObject has every right; a process of the same user can still
  // duplicate that one out of this process (the residual of the plan's D4 entry).
  const string JobSddl = "D:P(A;;0x0010000C;;;OW)";
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1 << 20, RecursionLimit = 16 };
  static readonly object OutLock = new object();
  static StreamWriter Out;
  /** Commands taken and not yet answered; at stdin EOF they get at most DrainMs (a kill-job waits at most 10 s). */
  static int Pending;
  static readonly object PendingLock = new object();
  const int DrainMs = 15000;
  /** The most Job members one answer lists (an answer is one line, and orchestrad reads at most 1 MiB of one). */
  const int MaxListed = 4096;

  static int Main(string[] args) {
    if (args.Length > 0 && args[0] == "run-in-job") return OneShot(args);
    if (args.Length > 0) { Console.Error.WriteLine("procguard: unknown arguments"); return 2; }
    return Serve();
  }

  // ---------- one-shot: run-in-job ----------
  static int OneShot(string[] args) {
    string name = null, allow = null; int i = 1;
    for (; i < args.Length; i++) {
      if (args[i] == "--") { i++; break; }
      if (args[i] == "--name" && i + 1 < args.Length) name = args[++i];
      else if (args[i] == "--env-allowlist" && i + 1 < args.Length) allow = args[++i];
      else { Console.Error.WriteLine("procguard: unknown option"); return 2; }
    }
    if (name == null || allow == null || i >= args.Length) { Console.Error.WriteLine("procguard: usage: run-in-job --name <job> --env-allowlist <file> -- <exe> [args]"); return 2; }
    if (!JobName.IsMatch(name)) { Console.Error.WriteLine("procguard: bad job name"); return 2; }
    string exe = args[i];
    if (!Path.IsPathRooted(exe)) { Console.Error.WriteLine("procguard: the program must be an absolute path"); return 2; }
    string cmdline = string.Join(" ", args.Skip(i).Select(Quote).ToArray());
    IntPtr env = IntPtr.Zero, attrs = IntPtr.Zero, hlist = IntPtr.Zero, jlist = IntPtr.Zero;
    try {
      env = BuildEnv(File.ReadAllLines(allow));
      IntPtr job = CreateKillOnCloseJob(name);
      var si = new W.SIEX(); si.si.cb = Marshal.SizeOf(typeof(W.SIEX)); si.si.flags = 0x100; // STARTF_USESTDHANDLES
      si.si.hIn = W.GetStdHandle(-10); si.si.hOut = W.GetStdHandle(-11); si.si.hErr = W.GetStdHandle(-12);
      // Only our own std handles reach the child (review fix of the spike: no other inheritable handle).
      var own = new List<IntPtr>();
      foreach (var h in new[] { si.si.hIn, si.si.hOut, si.si.hErr }) if (h != IntPtr.Zero && h != new IntPtr(-1) && !own.Contains(h)) own.Add(h);
      uint flags = W.CREATE_SUSPENDED | W.CREATE_UNICODE_ENV | W.EXTENDED_STARTUPINFO_PRESENT;
      // The child is made inside the Job (the job list), so it is never outside it, not even suspended
      // between its creation and an assignment (review fix: a wrapper killed in between left it outside).
      int nattr = own.Count > 0 ? 2 : 1;
      IntPtr size = IntPtr.Zero; W.InitializeProcThreadAttributeList(IntPtr.Zero, nattr, 0, ref size);
      attrs = Marshal.AllocHGlobal(size);
      if (!W.InitializeProcThreadAttributeList(attrs, nattr, 0, ref size)) { int e = Marshal.GetLastWin32Error(); Marshal.FreeHGlobal(attrs); attrs = IntPtr.Zero; throw new Fail("InitializeProcThreadAttributeList", e); }
      if (own.Count > 0) {
        hlist = Marshal.AllocHGlobal(own.Count * IntPtr.Size);
        for (int k = 0; k < own.Count; k++) Marshal.WriteIntPtr(hlist, k * IntPtr.Size, own[k]);
        if (!W.UpdateProcThreadAttribute(attrs, 0, W.ATTR_HANDLE_LIST, hlist, new IntPtr(own.Count * IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Fail("UpdateProcThreadAttribute(handle list)");
      }
      jlist = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jlist, job);
      if (!W.UpdateProcThreadAttribute(attrs, 0, W.ATTR_JOB_LIST, jlist, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Fail("UpdateProcThreadAttribute(job list)");
      si.attrs = attrs;
      W.PI pi;
      if (!W.CreateProcessW(exe, new StringBuilder(cmdline, 32768), IntPtr.Zero, IntPtr.Zero, own.Count > 0, flags, env, null, ref si, out pi)) throw new Fail("CreateProcess");
      // The second guard: still suspended, it must be in the Job before it runs a single instruction.
      bool inJob;
      if (!W.IsProcessInJob(pi.hProcess, job, out inJob)) { int e = Marshal.GetLastWin32Error(); W.TerminateProcess(pi.hProcess, 1); throw new Fail("IsProcessInJob", e); }
      if (!inJob && !W.AssignProcessToJobObject(job, pi.hProcess)) { int e = Marshal.GetLastWin32Error(); W.TerminateProcess(pi.hProcess, 1); throw new Fail("AssignProcessToJobObject", e); }
      if (W.ResumeThread(pi.hThread) == 0xFFFFFFFF) { int e = Marshal.GetLastWin32Error(); W.TerminateJobObject(job, 1); throw new Fail("ResumeThread", e); }
      W.CloseHandle(pi.hThread);
      W.WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
      uint code; W.GetExitCodeProcess(pi.hProcess, out code);
      return (int)code; // the process ends, the Job's one handle closes: what is left in it dies
    } catch (Fail e) {
      Console.Error.WriteLine("procguard: " + e.Message); return 125;
    } catch (IOException) {
      Console.Error.WriteLine("procguard: cannot read the env allowlist"); return 125;
    } catch (UnauthorizedAccessException) {
      Console.Error.WriteLine("procguard: cannot read the env allowlist"); return 125;
    } finally {
      if (attrs != IntPtr.Zero) { W.DeleteProcThreadAttributeList(attrs); Marshal.FreeHGlobal(attrs); }
      if (hlist != IntPtr.Zero) Marshal.FreeHGlobal(hlist);
      if (jlist != IntPtr.Zero) Marshal.FreeHGlobal(jlist);
      if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
    }
  }

  static IntPtr CreateKillOnCloseJob(string name) {
    IntPtr sd;
    if (!W.ConvertStringSecurityDescriptorToSecurityDescriptorW(JobSddl, 1, out sd, IntPtr.Zero)) throw new Fail("ConvertStringSecurityDescriptor");
    IntPtr h;
    int err;
    try {
      var sa = new W.SA { len = Marshal.SizeOf(typeof(W.SA)), sd = sd, inherit = 0 };
      h = W.CreateJobObjectW(ref sa, name);
      err = Marshal.GetLastWin32Error();
    } finally { W.LocalFree(sd); }
    if (h == IntPtr.Zero) throw new Fail("CreateJobObject", err);
    if (err == W.ERROR_ALREADY_EXISTS) { W.CloseHandle(h); throw new Fail("CreateJobObject (the name exists)", err); }
    var info = new W.EXT_LIMIT();
    info.Basic.LimitFlags = W.KILL_ON_JOB_CLOSE; // no BREAKAWAY_OK, no SILENT_BREAKAWAY_OK, no UI restrictions
    if (!W.SetInformationJobObject(h, 9, ref info, Marshal.SizeOf(typeof(W.EXT_LIMIT)))) { int e = Marshal.GetLastWin32Error(); W.CloseHandle(h); throw new Fail("SetInformationJobObject", e); }
    return h;
  }

  // An environment from zero: each listed name with our own value, when we have one. The list holds names
  // only (a line with '=' is refused): no value comes from the file, so the child sees nothing orchestrad
  // did not hand to us. Sorted without regard to case, as Windows wants an environment block.
  static IntPtr BuildEnv(string[] lines) {
    var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    foreach (var raw in lines) {
      string l = raw.Trim(); if (l.Length == 0 || l[0] == '#') continue;
      if (!EnvName.IsMatch(l)) throw new Fail("env allowlist: not a variable name", 87);
      string v = Environment.GetEnvironmentVariable(l); if (v != null) env[l] = v;
    }
    var sb = new StringBuilder();
    foreach (var kv in env) sb.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
    sb.Append('\0'); if (env.Count == 0) sb.Append('\0');
    return Marshal.StringToHGlobalUni(sb.ToString());
  }

  // MSVCRT argv quoting: what CommandLineToArgvW and Node read back as the same argv.
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

  // ---------- resident ----------
  static int Serve() {
    Out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)); Out.AutoFlush = true;
    var ready = new Dictionary<string, object>(); ready["event"] = "ready"; using (var me = Process.GetCurrentProcess()) ready["pid"] = me.Id;
    Emit(ready);
    var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    string line;
    while ((line = input.ReadLine()) != null) {
      if (line.Trim().Length == 0) continue;
      string l = line;
      lock (PendingLock) Pending++;
      ThreadPool.QueueUserWorkItem(delegate {
        try { Handle(l); } finally { lock (PendingLock) { Pending--; Monitor.PulseAll(PendingLock); } }
      });
    }
    // stdin EOF: orchestrad is gone or stopping. What it asked before (the check after a session's end
    // during its stop, above all) still runs and answers, at most DrainMs; then we exit.
    var sw = Stopwatch.StartNew();
    lock (PendingLock) {
      while (Pending > 0) { long left = DrainMs - sw.ElapsedMilliseconds; if (left <= 0) break; Monitor.Wait(PendingLock, (int)left); }
    }
    Environment.Exit(0);
    return 0;
  }

  static void Handle(string line) {
    object id = null; Dictionary<string, object> r;
    try {
      var a = Json.Deserialize<Dictionary<string, object>>(line);
      a.TryGetValue("id", out id);
      switch (S(a, "cmd")) {
        case "ping": r = Ok(); break;
        case "job-info": r = JobInfo(a); break;
        case "kill-job": r = KillJob(a); break;
        case "alive": r = Alive(a); break;
        default: r = Err("unknown-command"); break;
      }
    } catch (Exception e) { r = Err("exception"); r["message"] = e.GetType().Name + ": " + e.Message; }
    r["id"] = id;
    string s = Json.Serialize(r);
    // A reader gone (orchestrad exited before the answer came) is no reason to crash: nobody hears it.
    try { lock (OutLock) Out.WriteLine(s); } catch (IOException) { } catch (ObjectDisposedException) { }
  }

  static void Emit(Dictionary<string, object> r) { string s = Json.Serialize(r); lock (OutLock) Out.WriteLine(s); }

  /** The Job by its name, or IntPtr.Zero when no such Job exists (any more). Other failures throw. */
  static IntPtr OpenJob(Dictionary<string, object> a, uint access) {
    string name = S(a, "name");
    if (name == null || !JobName.IsMatch(name)) throw new Fail("bad job name", 87);
    IntPtr h = W.OpenJobObjectW(access, false, name);
    if (h != IntPtr.Zero) return h;
    int e = Marshal.GetLastWin32Error();
    if (e == W.ERROR_FILE_NOT_FOUND) return IntPtr.Zero;
    throw new Fail("OpenJobObject", e);
  }

  static W.ACCT Acct(IntPtr h) {
    W.ACCT acct; if (!W.QueryInformationJobObject(h, 1, out acct, Marshal.SizeOf(typeof(W.ACCT)), IntPtr.Zero)) throw new Fail("QueryInformationJobObject");
    return acct;
  }

  /**
   * The processes in the Job now: pid, create time (FILETIME as a decimal string) and image name; at most
   * MaxListed of them (truncated: more were in it). A buffer too small is ERROR_MORE_DATA: asked again with
   * room for MaxListed, and past that only what the answer put in the buffer is listed.
   */
  static List<object> Members(IntPtr h, out bool truncated) {
    truncated = false;
    int n = 1024; IntPtr buf = Marshal.AllocHGlobal(8 + 8 * n); var res = new List<object>();
    try {
      for (;;) {
        Marshal.WriteInt64(buf, 0, 0); // both counts 0 unless the answer writes them
        if (W.QueryJobRaw(h, 3, buf, 8 + 8 * n, IntPtr.Zero)) break;
        int e = Marshal.GetLastWin32Error();
        if (e != W.ERROR_MORE_DATA) throw new Fail("QueryInformationJobObject(pids)", e);
        if (n >= MaxListed) { truncated = true; break; }
        n = MaxListed; Marshal.FreeHGlobal(buf); buf = Marshal.AllocHGlobal(8 + 8 * n);
      }
      int cnt = Math.Min(Math.Max(Marshal.ReadInt32(buf, 4), 0), n);
      if (Marshal.ReadInt32(buf, 0) > cnt) truncated = true;
      for (int i = 0; i < cnt; i++) {
        uint pid = (uint)Marshal.ReadInt64(buf, 8 + 8 * i); var d = new Dictionary<string, object>(); d["pid"] = pid;
        IntPtr p = W.OpenProcess(W.PQLI, false, pid);
        if (p == IntPtr.Zero) { d["createTime"] = null; d["image"] = null; res.Add(d); continue; }
        try {
          long c, x, k, u; d["createTime"] = W.GetProcessTimes(p, out c, out x, out k, out u) ? c.ToString() : null;
          var sb = new StringBuilder(1024); int len = sb.Capacity;
          d["image"] = W.QueryFullProcessImageNameW(p, 0, sb, ref len) ? Path.GetFileName(sb.ToString()) : null;
        } finally { W.CloseHandle(p); }
        res.Add(d);
      }
    } finally { Marshal.FreeHGlobal(buf); }
    return res;
  }

  static Dictionary<string, object> JobInfo(Dictionary<string, object> a) {
    IntPtr h = OpenJob(a, W.JOB_QUERY);
    var r = Ok();
    if (h == IntPtr.Zero) { r["found"] = false; return r; }
    try {
      var acct = Acct(h); r["found"] = true; r["activeProcesses"] = acct.ActiveProcesses; r["totalProcesses"] = acct.TotalProcesses;
      bool truncated; r["procs"] = Members(h, out truncated); if (truncated) r["truncated"] = true;
    } finally { W.CloseHandle(h); }
    return r;
  }

  // The brake and the reaper: every process in the Job ends now (TerminateJobObject), then we wait, at most
  // waitMs, until the Job's accounting counts none active. "before" is the count at the moment we came
  // (one fixed-size query, then the kill at once: nothing that grows with the Job runs before it, review
  // fix); "procs" lists, last and best effort, what is still in it after the wait (normally nobody). A
  // count before that could not be read still lets the kill run, and the answer is then an error (unknown).
  static Dictionary<string, object> KillJob(Dictionary<string, object> a) {
    IntPtr h = OpenJob(a, W.JOB_QUERY | W.JOB_TERMINATE);
    var r = Ok();
    if (h == IntPtr.Zero) { r["found"] = false; return r; }
    try {
      int waitMs = a.ContainsKey("waitMs") ? Math.Min(Math.Max(Convert.ToInt32(a["waitMs"]), 0), 10000) : 2000;
      W.ACCT before = new W.ACCT(); Fail beforeFailed = null;
      try { before = Acct(h); } catch (Fail f) { beforeFailed = f; }
      if (!W.TerminateJobObject(h, 1)) throw new Fail("TerminateJobObject");
      if (beforeFailed != null) throw beforeFailed;
      r["found"] = true; r["before"] = before.ActiveProcesses;
      var sw = Stopwatch.StartNew(); W.ACCT acct;
      while (true) { acct = Acct(h); if (acct.ActiveProcesses == 0 || sw.ElapsedMilliseconds > waitMs) break; Thread.Sleep(5); }
      r["after"] = acct.ActiveProcesses; r["ms"] = sw.Elapsed.TotalMilliseconds;
      try { bool truncated; r["procs"] = Members(h, out truncated); if (truncated) r["truncated"] = true; }
      catch (Exception e) { r["procs"] = new object[0]; r["procsError"] = e.GetType().Name + ": " + e.Message; }
    } finally { W.CloseHandle(h); }
    return r;
  }

  // Which of the given (pid, createTime) still run: by identity, never by pid alone (a pid is reused).
  static Dictionary<string, object> Alive(Dictionary<string, object> a) {
    var live = new List<object>();
    object v; IEnumerable procs = a.TryGetValue("procs", out v) && v is IEnumerable && !(v is string) ? (IEnumerable)v : new object[0];
    foreach (var o in procs) {
      var d = o as Dictionary<string, object>; if (d == null) continue;
      uint pid = Convert.ToUInt32(d["pid"]); string ct = S(d, "createTime");
      IntPtr h = W.OpenProcess(W.PQLI, false, pid); if (h == IntPtr.Zero) continue;
      long c, x, k, u; uint code;
      bool ok = W.GetProcessTimes(h, out c, out x, out k, out u) && c.ToString() == ct && W.GetExitCodeProcess(h, out code) && code == W.STILL_ACTIVE;
      W.CloseHandle(h); if (ok) live.Add(pid + ":" + ct);
    }
    var r = Ok(); r["alive"] = live; return r;
  }

  static Dictionary<string, object> Ok() { var d = new Dictionary<string, object>(); d["ok"] = true; return d; }
  static Dictionary<string, object> Err(string code) { var d = new Dictionary<string, object>(); d["ok"] = false; d["error"] = code; return d; }
  static string S(Dictionary<string, object> a, string k) { object v; return a.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : null; }
}
}
