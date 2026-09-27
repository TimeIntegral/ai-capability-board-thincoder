// 常驻悬浮看板 —— 数据读取与口径（唯一出处；口径全部照抄原型，一条不许丢，见设计档 2.2.6）
// 纪律：一律只读（唯一写面是面板自己的状态文件）；解析失败按「读不到」处理；
//      读不到写「—」且不画圈/弧，绝不假装 0（字段缺了就当读不到：[double]null 会变成 0，靠 null 判据拦不住）。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace Board {
  internal static class Fmt {
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public static string Num(double v) { return v.ToString("0.###", Inv); }

    // 百分比：四舍五入到整数（与看板一致的显示分辨率）
    public static string Pct(double v) { return ((double)Math.Round(v, MidpointRounding.AwayFromZero)).ToString("N0", Inv) + "%"; }

    public static string Money(string sym, double v) {
      if (v < 0.0) v = 0.0;
      return sym + v.ToString("#,##0.00", Inv);
    }

    public static string Amount(double v, string unit) {
      return "¥" + v.ToString("#,##0", Inv);
    }

    public static string HM(long ms) {
      if (ms <= 0) return "—";
      return FromMs(ms).ToString("HH:mm", Inv);
    }
    public static string MD(long ms) {
      if (ms <= 0) return "—";
      return FromMs(ms).ToString("M/d HH:mm", Inv);
    }
    private static DateTime FromMs(long ms) { return DateTimeOffset.FromUnixTimeMilliseconds(ms).ToLocalTime().DateTime; }

    public static long NowMs() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }

    public static string Ago(long ms) {
      if (ms <= 0) return "—";
      double s = (DateTime.UtcNow - DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime).TotalSeconds;
      if (s < 60) return "刚刚";
      double m = s / 60.0;
      if (m < 60) return ((double)Math.Round(m, MidpointRounding.AwayFromZero)).ToString("N0", Inv) + " 分钟前";
      double h = m / 60.0;
      if (h < 24) return ((double)Math.Round(h, MidpointRounding.AwayFromZero)).ToString("N0", Inv) + " 小时前";
      return ((double)Math.Round(h / 24.0, MidpointRounding.AwayFromZero)).ToString("N0", Inv) + " 天前";
    }

    // 「还有多久」：数据是旧快照时不许拿它当「下一次刷新」
    public static string Remain(long ms) {
      long s = (ms - NowMs()) / 1000;
      if (s <= 0) return "已过";
      if (s < 3600) return ((int)Math.Round(s / 60.0)).ToString(Inv) + " 分钟后";
      int h = (int)Math.Floor(s / 3600.0), m = (int)Math.Floor((s % 3600) / 60.0);
      if (h < 24) return h + "h " + m + "m 后";
      return (int)Math.Floor(h / 24.0) + " 天 " + (h % 24) + "h 后";
    }

    // 会话时长：不足 1 小时 mm:ss；1 小时以上 h:mm:ss
    public static string Duration(double seconds) {
      if (seconds < 0) seconds = 0;
      long t = (long)Math.Floor(seconds);
      long h = t / 3600, m = (t % 3600) / 60, s = t % 60;
      if (h > 0) return h + ":" + m.ToString("00", Inv) + ":" + s.ToString("00", Inv);
      return m.ToString("00", Inv) + ":" + s.ToString("00", Inv);
    }

    public static string AgeShort(double sec) {
      if (sec < 0) return "—";
      if (sec < 60) return ((int)Math.Floor(sec)).ToString(Inv) + "s";
      if (sec < 3600) return ((int)Math.Floor(sec / 60)).ToString(Inv) + "m";
      if (sec < 86400) return ((int)Math.Floor(sec / 3600)).ToString(Inv) + "h" + ((int)Math.Floor((sec % 3600) / 60)).ToString("00", Inv) + "m";
      return ((int)Math.Floor(sec / 86400)).ToString(Inv) + "d";
    }
  }

  // ==================== 运行上下文（唯一出处）====================
  internal static class Ctx {
    public static string DataRoot = "";       // dashboard-data.js / data/attribution.json 那一层
    public static string RootDir = "";        // 安装根（程序\bin\ 的上一级）—— 只为了读自己的开关状态与升级事务文件
    public static string StatePath = "";      // 面板状态文件（用户数据目录）
    public static string DataPath { get { return Path.Combine(DataRoot, "dashboard-data.js"); } }

    public static string DefaultStatePath() {
      string baseDir = Environment.GetEnvironmentVariable("LOCALAPPDATA");
      if (string.IsNullOrEmpty(baseDir)) {
        try { baseDir = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData); } catch { baseDir = ""; }
      }
      if (string.IsNullOrEmpty(baseDir)) baseDir = Environment.GetEnvironmentVariable("TEMP");
      if (string.IsNullOrEmpty(baseDir)) baseDir = ".";
      return Path.Combine(Path.Combine(baseDir, "AICapabilityBoard"), "panel-state.json");
    }

    // 「剩余」口径（唯一出处）：剩余 = 100 − 已用 —— 先把减法做完，再取整（四舍五入、夹 0~100）
    public static double RemainPct(double usedPct) {
      double v = 100.0 - usedPct;
      double r = Math.Round(v, MidpointRounding.AwayFromZero);
      if (r < 0.0) r = 0.0;
      if (r > 100.0) r = 100.0;
      return r;
    }

    // 颜色分档跟看板一致：剩余 ≤ 100−critical 红、≤ 100−warn 黄、其余绿
    public static string ColorOfRemain(double remainPct, double warnUsedPct, double critUsedPct) {
      if (remainPct <= (100.0 - critUsedPct)) return "#FF6B5A";
      if (remainPct <= (100.0 - warnUsedPct)) return "#F2C94C";
      return "#35D07F";
    }
  }

  // ==================== Codex 额度快照 ====================
  internal sealed class QuotaSnap {
    public bool ok; public string err = "";
    public double? fivePct, weekPct;
    public long fiveResetAt, weekResetAt, atMs;
    public string snapText = "";
    public double warn5hUsed = 80.0, crit5hUsed = 95.0, warnWeekUsed = 80.0;

    public static QuotaSnap Read(string path) {
      var o = new QuotaSnap();
      if (!File.Exists(path)) { o.err = "找不到 " + path; return o; }
      try {
        // 采集器是**原地重写**这个文件（截断后写）——读到半截就再读一次，别把一次竞态当成「读不到」
        string raw = Io.ReadAllTextRetry(path, 3, 150);
        var d = Json.Obj(Json.ParseJsWrap(raw));
        if (d == null) { o.err = "文件里没有 JSON 主体"; return o; }
        var c = Json.Obj(Json.Get(d, "codex"));
        if (c == null) { o.err = "JSON 里没有 codex 段"; return o; }
        var five = Json.Obj(Json.Get(c, "fiveHour"));
        var week = Json.Obj(Json.Get(c, "weekly"));
        if (five == null || week == null || Json.Num(Json.Get(five, "usedPercent")) == null || Json.Num(Json.Get(week, "usedPercent")) == null) {
          o.err = "codex 段缺 fiveHour/weekly.usedPercent（结构变了？）";
          return o;
        }
        o.fivePct = Json.Num(Json.Get(five, "usedPercent"));
        o.weekPct = Json.Num(Json.Get(week, "usedPercent"));
        o.fiveResetAt = Json.Long(Json.Get(five, "resetAt")) ?? 0L;
        o.weekResetAt = Json.Long(Json.Get(week, "resetAt")) ?? 0L;
        o.atMs = Json.Long(Json.Get(c, "atMs")) ?? 0L;
        var th = Json.Obj(Json.Get(d, "thresholds"));
        if (th != null) {
          double? v;
          v = Json.Num(Json.Get(th, "codex5hWarn")); if (v.HasValue) o.warn5hUsed = v.Value;
          v = Json.Num(Json.Get(th, "codex5hCritical")); if (v.HasValue) o.crit5hUsed = v.Value;
          v = Json.Num(Json.Get(th, "codexWeekWarn")); if (v.HasValue) o.warnWeekUsed = v.Value;
        }
        o.snapText = Fmt.MD(o.atMs);
        o.ok = true;
      } catch (Exception ex) { o.err = ex.Message; }
      return o;
    }
  }

  // 采集器可能正在写这个文件 —— 只读打开、同时允许别人写
  internal static class Io {
    public static string ReadAllTextShared(string path) {
      using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
        using (var sr = new StreamReader(fs, new UTF8Encoding(false))) return sr.ReadToEnd();
      }
    }

    // 重试读（唯一入口）：采集器正在原地重写时，一次读可能拿到半截 —— 隔一小会儿再读
    //   只在**失败**时重试（成功一次就返回），所以正常路径零开销；抛出的仍是最后一次的异常
    public static string ReadAllTextRetry(string path, int tries, int delayMs) {
      Exception last = null;
      int n = tries < 1 ? 1 : tries;
      for (int i = 0; i < n; i++) {
        try { return ReadAllTextShared(path); }
        catch (Exception ex) { last = ex; }
        if (i + 1 < n && delayMs > 0) Thread.Sleep(delayMs);
      }
      throw last;
    }

    // 解析重试（唯一入口）：文本读到了但解不出主体（半截文件就是这样）→ 重读重解
    public static object ReadJsRetry(string path, int tries, int delayMs, out string err) {
      err = "";
      int n = tries < 1 ? 1 : tries;
      for (int i = 0; i < n; i++) {
        try {
          object o = Json.ParseJsWrap(ReadAllTextShared(path));
          if (o != null) return o;
          err = "文件里没有 JSON 主体";
        } catch (Exception ex) { err = ex.Message; }
        if (i + 1 < n && delayMs > 0) Thread.Sleep(delayMs);
      }
      return null;
    }
  }

  // ==================== ThinCoder 会话（槽位）====================
  internal sealed class SlotRec {
    public long ms; public int turns; public string cwd = ""; public string sessionId = "";
  }

  internal sealed class ProjRec {
    public string cwd = "", name = "";
    public int todayTurns, todaySessions, weekTurns, weekSessions, slots;
    public long lastMs;
  }

  internal sealed class Sessions {
    public bool ok; public string err = "", dir = "";
    public List<ProjRec> projects = new List<ProjRec>();
    public int todayTurns, todaySessions, weekTurns, weekSessions, files, slots;
    public long newestWriteMs;
    public long newestSlotMs; public string newestSlotId = "", newestSlotNo = "";

    public static string HomeDir() {
      string h = Environment.GetEnvironmentVariable("USERPROFILE");
      if (string.IsNullOrEmpty(h)) h = Environment.GetEnvironmentVariable("HOME");
      if (string.IsNullOrEmpty(h)) h = ".";
      return h;
    }
    public static string BaseDir() { return Path.Combine(HomeDir(), ".thincoder"); }

    public static Sessions Read() {
      var o = new Sessions();
      string dir = Path.Combine(BaseDir(), "sessions");
      o.dir = dir;
      if (!Directory.Exists(dir)) { o.err = "目录不存在：" + dir; return o; }
      long nowMs = Fmt.NowMs();
      long todayStart = new DateTimeOffset(DateTime.Today).ToUnixTimeMilliseconds();
      long weekStart = nowMs - 7L * 86400000L;
      var acc = new Dictionary<string, ProjRec>();
      try {
        foreach (string full in Directory.GetFiles(dir)) {
          string name = Path.GetFileName(full);
          var fi = new FileInfo(full);
          if (Regex.IsMatch(name, "\\.json\\.\\d+$")) {
            long wms = new DateTimeOffset(fi.LastWriteTimeUtc).ToUnixTimeMilliseconds();
            if (wms > o.newestWriteMs) o.newestWriteMs = wms;
          }
          var m = Regex.Match(name, "^([0-9a-f]{40})\\.json\\.manifest$");
          if (!m.Success) continue;
          o.files++;
          var j = Json.Obj(Json.Parse(ReadAllTextSafe(full)));
          if (j == null) continue;
          var slots = Json.Obj(Json.Get(j, "slots"));
          if (slots == null) continue;
          var slotSessions = Json.Obj(Json.Get(j, "slotSessions"));
          string topSession = Json.Str(Json.Get(j, "sessionId"));
          foreach (var kv in slots) {
            string slotNo = kv.Key;
            var s = Json.Obj(kv.Value);
            if (s == null) continue;
            long ts = Json.Long(Json.Get(s, "updatedAt")) ?? (Json.Long(Json.Get(s, "ts")) ?? 0L);
            int turns = (int)(Json.Long(Json.Get(s, "turnCount")) ?? 0L);
            string cwd = "";
            string head = Path.Combine(dir, m.Groups[1].Value + ".json." + slotNo);
            if (File.Exists(head)) {
              try {
                using (var fs = new FileStream(head, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
                  var buf = new byte[600];
                  int n = fs.Read(buf, 0, 600);
                  string txt = Encoding.UTF8.GetString(buf, 0, n);
                  var mm = Regex.Match(txt, "\"cwd\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
                  if (mm.Success) cwd = UnescapeJson(mm.Groups[1].Value);
                }
              } catch { }
            }
            string sid = slotSessions != null ? Json.Str(Json.Get(slotSessions, slotNo)) : null;
            if (string.IsNullOrEmpty(sid)) sid = topSession;
            if (ts > o.newestSlotMs) {
              o.newestSlotMs = ts; o.newestSlotId = sid ?? ""; o.newestSlotNo = slotNo;
            }
            string key = cwd.ToLowerInvariant();
            ProjRec r;
            if (!acc.TryGetValue(key, out r)) {
              r = new ProjRec();
              r.cwd = cwd;
              r.name = cwd.Length == 0 ? "（无路径记录）" : TrimDirName(cwd);
              acc[key] = r;
            }
            r.slots++; o.slots++;
            if (ts > r.lastMs) r.lastMs = ts;
            if (ts >= todayStart) { r.todayTurns += turns; r.todaySessions++; }
            if (ts >= weekStart) { r.weekTurns += turns; r.weekSessions++; }
          }
        }
        foreach (var r in acc.Values) o.projects.Add(r);
        o.projects.Sort(delegate (ProjRec a, ProjRec b) { return b.lastMs.CompareTo(a.lastMs); });
        foreach (var r in o.projects) {
          o.todayTurns += r.todayTurns; o.todaySessions += r.todaySessions;
          o.weekTurns += r.weekTurns; o.weekSessions += r.weekSessions;
        }
        o.ok = true;
      } catch (Exception ex) { o.err = ex.Message; }
      return o;
    }

    // 自检夹具入口：直接喂一组槽位（不动真实会话文件）
    public static Sessions FromSlots(List<SlotRec> list, long nowMs) {
      var o = new Sessions();
      o.ok = true;
      long todayStart = new DateTimeOffset(DateTime.Today).ToUnixTimeMilliseconds();
      long weekStart = nowMs - 7L * 86400000L;
      var acc = new Dictionary<string, ProjRec>();
      foreach (var s in list) {
        ProjRec r;
        string key = (s.cwd ?? "").ToLowerInvariant();
        if (!acc.TryGetValue(key, out r)) {
          r = new ProjRec();
          r.cwd = s.cwd ?? "";
          r.name = string.IsNullOrEmpty(s.cwd) ? "（无路径记录）" : TrimDirName(s.cwd);
          acc[key] = r;
        }
        r.slots++; o.slots++;
        if (s.ms > r.lastMs) r.lastMs = s.ms;
        if (s.ms >= todayStart) { r.todayTurns += s.turns; r.todaySessions++; }
        if (s.ms >= weekStart) { r.weekTurns += s.turns; r.weekSessions++; }
        if (s.ms > o.newestSlotMs) { o.newestSlotMs = s.ms; o.newestSlotId = s.sessionId ?? ""; o.newestSlotNo = "1"; }
      }
      foreach (var r in acc.Values) o.projects.Add(r);
      o.projects.Sort(delegate (ProjRec a, ProjRec b) { return b.lastMs.CompareTo(a.lastMs); });
      foreach (var r in o.projects) {
        o.todayTurns += r.todayTurns; o.todaySessions += r.todaySessions;
        o.weekTurns += r.weekTurns; o.weekSessions += r.weekSessions;
      }
      return o;
    }

    private static string ReadAllTextSafe(string path) {
      try { return Io.ReadAllTextShared(path); } catch { return null; }
    }
    private static string TrimDirName(string cwd) {
      string t = cwd.TrimEnd('\\', '/');
      int i = t.LastIndexOfAny(new char[] { '\\', '/' });
      return i >= 0 ? t.Substring(i + 1) : t;
    }
    private static string UnescapeJson(string s) {
      return s.Replace("\\\\", "\u0001").Replace("\\\"", "\"").Replace("\\/", "/")
              .Replace("\\n", "\n").Replace("\\t", "\t").Replace("\\r", "\r").Replace("\u0001", "\\");
    }
  }

  // 会话 id（形如 <pid>-<铸造毫秒>-<随机>）→ 铸造时刻
  internal static class SessionId {
    public static long MintMs(string id) {
      if (string.IsNullOrEmpty(id)) return 0L;
      var m = Regex.Match(id, "^[^-]+-(\\d{12,})-");
      if (!m.Success) return 0L;
      long v;
      return long.TryParse(m.Groups[1].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out v) ? v : 0L;
    }
  }

  // ==================== 近 7 天（attribution.json）====================
  internal sealed class Att7 {
    public bool ok, found; public long turns7, sessions7; public string err = "";
    public static Att7 Read(string dataRoot, string projCwd) {
      var o = new Att7();
      string p = Path.Combine(dataRoot, "data", "attribution.json");
      if (!File.Exists(p)) { o.err = "找不到 " + p; return o; }
      try {
        var d = Json.Obj(Json.Parse(Io.ReadAllTextShared(p)));
        if (d == null) { o.err = "解析失败"; return o; }
        var tc = Json.Obj(Json.Get(d, "thinCoder"));
        var rows = tc != null ? Json.Arr(Json.Get(tc, "projects")) : null;
        o.ok = true;
        if (!string.IsNullOrEmpty(projCwd) && rows != null) {
          string want = projCwd.ToLowerInvariant();
          foreach (var one in rows) {
            var r = Json.Obj(one);
            string cwd = Json.Str(Json.Get(r, "cwd"));
            if (cwd != null && cwd.ToLowerInvariant() == want) {
              o.found = true;
              o.turns7 = Json.Long(Json.Get(r, "turns7")) ?? 0L;
              o.sessions7 = Json.Long(Json.Get(r, "sessions7")) ?? 0L;
              break;
            }
          }
        }
      } catch (Exception ex) { o.err = ex.Message; }
      return o;
    }
  }

  // ==================== 活动信号 / 状态四态 ====================
  internal sealed class Activity {
    public long sessionMs, logMs, peerMs, maxMs;
    public string maxWhat = "";
    public int livePeers; public bool peersAliveChecked;

    public static Activity Read() {
      var o = new Activity();
      string baseDir = Sessions.BaseDir();
      long now = Fmt.NowMs();
      string sdir = Path.Combine(baseDir, "sessions");
      if (Directory.Exists(sdir)) {
        foreach (string f in Directory.GetFiles(sdir)) {
          string n = Path.GetFileName(f);
          if (!Regex.IsMatch(n, "\\.json\\.\\d+$")) continue;
          long ms = new DateTimeOffset(new FileInfo(f).LastWriteTimeUtc).ToUnixTimeMilliseconds();
          if (ms > o.sessionMs) o.sessionMs = ms;
        }
      }
      string ldir = Path.Combine(baseDir, "logs");
      if (Directory.Exists(ldir)) {
        foreach (string f in Directory.GetFiles(ldir, "agent-*.log")) {
          long ms = new DateTimeOffset(new FileInfo(f).LastWriteTimeUtc).ToUnixTimeMilliseconds();
          if (ms > o.logMs) o.logMs = ms;
        }
      }
      string pdir = Path.Combine(baseDir, "peers");
      if (Directory.Exists(pdir)) {
        foreach (string f in Directory.GetFiles(pdir, "*.json")) {
          long ms = new DateTimeOffset(new FileInfo(f).LastWriteTimeUtc).ToUnixTimeMilliseconds();
          if (ms > o.peerMs) o.peerMs = ms;
          try {
            var j = Json.Obj(Json.Parse(Io.ReadAllTextShared(f)));
            long? pid = Json.Long(Json.Get(j, "pid"));
            if (pid.HasValue && pid.Value > 0 && pid.Value < int.MaxValue) {
              try { var pr = System.Diagnostics.Process.GetProcessById((int)pid.Value); o.livePeers++; } catch { }
            }
          } catch { }
        }
      }
      o.peersAliveChecked = true;
      o.maxMs = o.sessionMs; o.maxWhat = "会话正文";
      if (o.logMs > o.maxMs) { o.maxMs = o.logMs; o.maxWhat = "agent 日志"; }
      if (o.peerMs > o.maxMs) { o.maxMs = o.peerMs; o.maxWhat = "peers 心跳"; }
      return o;
    }
  }

  internal sealed class StatusInfo {
    public string kind = "none", word = "今天没用过", color = "#6E7581";
    public int ageSec = -1; public int livePeers;
    public string State() {
      if (kind == "running") return "● 正在运行";
      if (kind == "waiting") return "● 等你回答";
      if (kind == "done") return "○ 已完成";
      return "— 今天没用过";
    }
  }

  internal static class StatusLogic {
    // 状态是文件推断（近似）：运行 = 20 秒内有写入；等回答 = 有活进程但没写入；已完成 = 今天用过没进程；没用过 = 今天无活动
    public static StatusInfo Compute(long nowMs, long sessionMs, long logMs, long peerMs, int livePeers, int todaySessions) {
      var o = new StatusInfo();
      long maxMs = sessionMs; string what = "会话正文";
      if (logMs > maxMs) { maxMs = logMs; what = "agent 日志"; }
      if (peerMs > maxMs) { maxMs = peerMs; what = "peers 心跳"; }
      o.ageSec = maxMs > 0 ? (int)((nowMs - maxMs) / 1000) : -1;
      o.livePeers = livePeers;
      if (o.ageSec >= 0 && o.ageSec <= Geo.RUNNING_FRESH_SEC) {
        o.kind = "running"; o.word = "正在运行"; o.color = "#35D07F";
      } else if (livePeers > 0) {
        o.kind = "waiting"; o.word = "等你回答"; o.color = "#F2C94C";
      } else if (todaySessions > 0) {
        o.kind = "done"; o.word = "已完成"; o.color = "#8A909C";
      } else {
        o.kind = "none"; o.word = "今天没用过"; o.color = "#6E7581";
      }
      return o;
    }
  }

  // ==================== 余额（DeepSeek / 智谱 GLM）+ 圈 ====================
  internal sealed class BalPlat {
    public string key = "", name = "", color = "", sym = "¥", cur = "CNY", note = "";
    public bool known, carried, depleted, hidden;
    public double value, low = 5.0, crit = 2.0;
    public long atMs;
  }

  internal sealed class BalSnapshot {
    public bool ok; public string err = "", path = ""; public long genMs; public string genText = "数据 —";
    public Dictionary<string, BalPlat> plat = new Dictionary<string, BalPlat>();
    public static BalSnapshot Read(string dataRoot) {
      var o = new BalSnapshot();
      string p = Path.Combine(dataRoot, "dashboard-data.js");
      o.path = p;
      if (!File.Exists(p)) { o.err = "找不到 " + p; return o; }
      try {
        string perr;
        var d = Json.Obj(Io.ReadJsRetry(p, 3, 150, out perr));
        if (d == null) { o.err = perr; return o; }
        long? gen = Json.Long(Json.Get(d, "generatedAtMs"));
        if (gen.HasValue) { o.genMs = gen.Value; o.genText = "数据 " + Fmt.MD(o.genMs); }
        double dsLow = 5.0, dsCrit = 2.0, glmLow = 5.0, glmCrit = 2.0;
        var th = Json.Obj(Json.Get(d, "thresholds"));
        if (th != null) {
          double? v;
          v = Json.Num(Json.Get(th, "dsLow")); if (v.HasValue) dsLow = v.Value;
          v = Json.Num(Json.Get(th, "dsCritical")); if (v.HasValue) dsCrit = v.Value;
          v = Json.Num(Json.Get(th, "glmLow")); if (v.HasValue) glmLow = v.Value;
          v = Json.Num(Json.Get(th, "glmCritical")); if (v.HasValue) glmCrit = v.Value;
        }
        o.plat["deepseek"] = ReadPlat(Json.Obj(Json.Get(d, "deepseek")), "deepseek", dsLow, dsCrit);
        o.plat["glm"] = ReadPlat(Json.Obj(Json.Get(d, "glm")), "glm", glmLow, glmCrit);
        var cards = Json.Obj(Json.Get(d, "cards"));
        foreach (string k in new string[] { "deepseek", "glm" }) {
          bool hide = false;
          if (cards != null) {
            var sec = Json.Obj(Json.Get(cards, k));
            bool? show = sec != null ? Json.Bool(Json.Get(sec, "show")) : null;
            if (show.HasValue && !show.Value) hide = true;   // 缺该字段 = 都显示
          }
          o.plat[k].hidden = hide;
        }
        o.ok = true;
      } catch (Exception ex) { o.err = ex.Message; }
      return o;
    }

    private static BalPlat ReadPlat(Dictionary<string, object> sec, string key, double low, double crit) {
      var o = new BalPlat();
      o.key = key; o.low = low; o.crit = crit;
      o.name = key == "deepseek" ? "DeepSeek" : "智谱 GLM";
      o.color = key == "deepseek" ? "#F5A623" : "#FF5C5C";
      if (sec == null) { o.note = "读不到"; return o; }
      bool? okv = Json.Bool(Json.Get(sec, "ok"));
      if (okv.HasValue && !okv.Value) {
        o.note = "读不到";
        bool? dis = Json.Bool(Json.Get(sec, "disabled"));
        if (dis.HasValue && dis.Value) o.note = "平台已关闭";
        return o;
      }
      object vRaw = key == "deepseek" ? Json.Get(sec, "totalBalance") : Json.Get(sec, "balance");
      double? v = Json.Num(vRaw);
      if (!v.HasValue) { o.note = "读不到（字段缺）"; return o; }
      o.value = v.Value;
      o.carried = Json.Bool(Json.Get(sec, "carried")) ?? false;
      o.depleted = Json.Bool(Json.Get(sec, "depleted")) ?? false;
      o.atMs = Json.Long(Json.Get(sec, "atMs")) ?? 0L;
      if (key == "deepseek") {
        string cur = Json.Str(Json.Get(sec, "currency"));
        if (!string.IsNullOrEmpty(cur)) {
          o.cur = cur;
          if (o.cur != "CNY") o.sym = o.cur + " ";   // 外币：金额照实写币种，圈不画（圈是 ¥100 进制）
        }
      }
      o.known = true;
      return o;
    }
  }

  // 尺度规则（「每 ¥100 一圈」的唯一出处）：单元 = ¥100 × 10^k，取最小的那个能让最大余额 ≤ 9 个圈
  internal sealed class RingSpec {
    public int full; public double partialPct; public double[] pcts; public bool floored; public string ratioText = "";
    public static double BalanceUnit(double maxValue, double unitBase, int maxRings) {
      double u = unitBase;
      if (maxValue > 0) { while (!(maxValue <= maxRings * u)) u = u * 10.0; }
      return u;
    }
    public static RingSpec For(double value, double unit, double minArcDeg) {
      if (value < 0) value = 0.0;
      if (unit <= 0) unit = 100.0;
      double eps = 0.000001;
      var o = new RingSpec();
      int full = (int)Math.Floor(value / unit + eps);
      double rem = value - full * unit;
      var list = new List<double>();
      for (int i = 0; i < full; i++) list.Add(100.0);
      o.full = full;
      if (rem > eps) {
        double pct = rem / unit * 100.0;
        o.partialPct = pct;
        double floorPct = 100.0 * minArcDeg / 360.0;
        if (pct < floorPct) { pct = floorPct; o.floored = true; }
        list.Add(pct);
      }
      if (list.Count == 0) list.Add(0.0);
      o.pcts = list.ToArray();
      double ratio = value / unit;
      if (ratio <= 0.0) o.ratioText = "0 圈";
      else if (Math.Round(ratio, 2, MidpointRounding.AwayFromZero) <= 0.0) o.ratioText = "<0.01 圈";
      else o.ratioText = Fmt.Num(Math.Round(ratio, 2, MidpointRounding.AwayFromZero)) + " 圈";
      return o;
    }
  }

  internal sealed class BalGroup {
    public string key = "", name = "", color = "", sym = "¥", cur = "CNY", note = "", marks = "", sig = "";
    public bool known, carried, depleted, drawable;
    public double value, low, crit;
    public long atMs;
    public string amountText = "—", amountColor = "#6E7581";
    public double[] rings = new double[0];
    public int ringCount;
  }

  internal sealed class BalView {
    public bool ok; public string err = "", dataText = "数据 —";
    public double unit, unitBase = 100.0, maxValue; public bool unitHi; public string unitText = "";
    public List<BalGroup> groups = new List<BalGroup>();
    public BalGroup tightest;
    public int groupCount { get { return groups.Count; } }

    public static BalView Build(BalSnapshot bal, int maxRings, double unitBase) {
      const string C_TXT = "#F2F4F8", C_DIM = "#6E7581", C_BAD = "#FF6B5A", C_WARN = "#F2C94C";
      var all = new List<BalPlat>();
      foreach (string key in new string[] { "deepseek", "glm" }) {
        BalPlat g = null;
        if (bal != null && bal.plat.ContainsKey(key)) g = bal.plat[key];
        if (g == null) {
          g = new BalPlat();
          g.key = key; g.name = key == "deepseek" ? "DeepSeek" : "智谱 GLM";
          g.color = key == "deepseek" ? "#F5A623" : "#FF5C5C";
          g.note = "读不到";
        }
        all.Add(g);
      }
      var shown = new List<BalPlat>();
      foreach (var g in all) if (!g.hidden) shown.Add(g);
      double mx = 0.0;
      foreach (var g in shown) if (g.known && g.sym == "¥" && g.value > mx) mx = g.value;
      double unit = RingSpec.BalanceUnit(mx, unitBase, maxRings);
      var view = new BalView();
      view.unit = unit; view.unitBase = unitBase; view.maxValue = mx;
      view.unitHi = unit > unitBase;
      if (view.unitHi) view.unitText = "1 圈 = ¥" + unit.ToString("#,##0", CultureInfo.InvariantCulture);
      foreach (var g in shown) {
        var o = new BalGroup();
        o.key = g.key; o.name = g.name; o.color = g.color; o.known = g.known; o.value = g.value;
        o.sym = g.sym; o.cur = g.cur; o.note = g.note; o.carried = g.carried; o.depleted = g.depleted;
        o.low = g.low; o.crit = g.crit; o.atMs = g.atMs;
        if (o.known) {
          o.amountText = o.sym + o.value.ToString("#,##0.00", CultureInfo.InvariantCulture);
          o.amountColor = C_TXT;
          if (o.depleted || o.value < o.crit) o.amountColor = C_BAD;
          else if (o.value < o.low) o.amountColor = C_WARN;
          if (o.sym == "¥") {
            var spec = RingSpec.For(o.value, unit, 1.0);
            o.rings = spec.pcts; o.ringCount = spec.pcts.Length;
            var mk = new List<string>();
            if (spec.floored) mk.Add("<0.01 圈");
            if (o.carried) mk.Add("沿用");
            o.marks = string.Join(" · ", mk.ToArray());
            o.drawable = true;
            o.sig = Fmt.Num(unit) + "|" + string.Join(",", Array.ConvertAll<double, string>(spec.pcts, delegate (double d) { return Fmt.Num(d); }));
          } else {
            o.marks = o.cur;
          }
        }
        view.groups.Add(o);
      }
      foreach (var o in view.groups)
        if (o.known && o.sym == "¥" && (view.tightest == null || o.value < view.tightest.value)) view.tightest = o;
      if (bal != null) { view.ok = bal.ok; view.err = bal.err; view.dataText = bal.genText; }
      return view;
    }
  }

  // ==================== 上屏模型（两个形态共用一次读取）====================
  internal sealed class Model {
    public QuotaSnap codex = new QuotaSnap();
    public Sessions sess = new Sessions();
    public ProjRec proj;
    public string projName = "（读不到会话记录）", projCwd = "";
    public Att7 att7 = new Att7();
    public StatusInfo status = new StatusInfo();
    public double fivePct, weekPct, fiveRemain, weekRemain;
    public bool codexOk;
    public string fiveSub = "—", weekSub = "—", fiveSubColor = "#6E7581", weekSubColor = "#6E7581";
    public string resetLine = "—", resetColor = "#D9A05B";
    public string snapText = "";
    public string lastText = "—", todayLine = "今天 0 轮 · 读不到会话记录", weekLine = "近 7 天 —";
    public int todayTurns;
    public bool ok; public string quotaLabel = "Codex", quotaAlt = "";
    public double quotaRemain, quotaUsed, qWarnUsed = 80.0, qCritUsed = 95.0;
    public string sessId = ""; public long mintMs; public long slotMs; public string slotNo = "";
    public BalSnapshot bal = new BalSnapshot();
    public bool balRetained, codexRetained;   // 这一份是不是「上一份好数据」的沿用（读失败时的降级，不是假装新数据）
    public BalView balView = new BalView();
    public BalGroup balPick;
    public int balN { get { return balView.groupCount; } }
    public long nowMs;

    public static Model Build() { return Build(null); }

    // 现场读（唯一入口）：面板启动与每 30 秒重读都走这里 —— 额度与余额**都必须在这条路上真读一遍**。
    // 2026-09-27 的缺陷复盘：这条路上只读了额度，余额那一段拿的是个空快照（`new BalSnapshot()`），
    //   于是面板永远显示「数据 —」+ 两家「—」，连被看板关掉的平台也照样出现；
    //   而自检因为自己先调用了 BalSnapshot.Read 再喂给 BuildFor，把产品漏掉的那一步替它做了，所以全绿。
    // prev：上一份模型；这一份读失败时保留上一份好数据（按陈旧规则变暗，绝不假装 0、也不清空）。
    public static Model Build(Model prev) {
      var o = new Model();
      o.nowMs = Fmt.NowMs();
      o.codex = QuotaSnap.Read(Ctx.DataPath);
      if (!o.codex.ok && prev != null && prev.codex != null && prev.codex.ok) { o.codex = prev.codex; o.codexRetained = true; }
      o.ReadBalance(prev);
      o.sess = Sessions.Read();
      if (o.sess.ok && o.sess.projects.Count > 0) { o.proj = o.sess.projects[0]; o.projName = o.proj.name; o.projCwd = o.proj.cwd; }
      o.att7 = Att7.Read(Ctx.DataRoot, o.projCwd);
      var act = Activity.Read();
      o.status = StatusLogic.Compute(o.nowMs, act.sessionMs, act.logMs, act.peerMs, act.livePeers, o.sess.todaySessions);
      o.Finish(act);
      return o;
    }

    // 余额快照的现场读（唯一入口）：读真文件；读失败时保留上一份好数据（口径：读不到 ≠ 0，也 ≠ 清空）
    public void ReadBalance(Model prev) {
      bal = BalSnapshot.Read(Ctx.DataRoot);
      if (!bal.ok && prev != null && prev.bal != null && prev.bal.ok) { bal = prev.bal; balRetained = true; }
    }

    // 自检夹具入口：给定快照与会话，不动真实文件
    public static Model BuildFor(QuotaSnap codex, Sessions sess, Att7 att7, BalSnapshot bal, long nowMs, Activity act) {
      var o = new Model();
      o.nowMs = nowMs;
      o.codex = codex; o.sess = sess; o.att7 = att7; o.bal = bal;
      if (sess.ok && sess.projects.Count > 0) { o.proj = sess.projects[0]; o.projName = o.proj.name; o.projCwd = o.proj.cwd; }
      if (act == null) act = new Activity();
      o.status = StatusLogic.Compute(nowMs, act.sessionMs, act.logMs, act.peerMs, act.livePeers, sess.todaySessions);
      o.Finish(act);
      return o;
    }

    private void Finish(Activity act) {
      var cx = codex;
      double five = 0.0, week = 0.0;
      if (cx.ok) {
        if (cx.fivePct.HasValue) five = cx.fivePct.Value;
        if (cx.weekPct.HasValue) week = cx.weekPct.Value;
      }
      fivePct = five; weekPct = week;
      fiveRemain = Ctx.RemainPct(five); weekRemain = Ctx.RemainPct(week);
      codexOk = cx.ok && cx.fivePct.HasValue && cx.weekPct.HasValue;
      long now = nowMs;
      if (cx.ok) {
        fiveSub = (cx.fiveResetAt > now ? "刷新 " : "已过 ") + Fmt.HM(cx.fiveResetAt);
        weekSub = (cx.weekResetAt > now ? "刷新 " : "已过 ") + Fmt.MD(cx.weekResetAt);
        fiveSubColor = cx.fiveResetAt > now ? "#8A909C" : "#D9A05B";
        weekSubColor = cx.weekResetAt > now ? "#8A909C" : "#D9A05B";
        if (cx.fiveResetAt > now) { resetLine = "下次刷新 5h 窗口 " + Fmt.Remain(cx.fiveResetAt); resetColor = "#8A909C"; }
        else if (cx.weekResetAt > now) { resetLine = "下次刷新 7 天窗口 " + Fmt.Remain(cx.weekResetAt); resetColor = "#8A909C"; }
        else { resetLine = "刷新窗口都已过 · 数据 " + Fmt.Ago(cx.atMs); resetColor = "#D9A05B"; }
        snapText = cx.snapText;
      } else {
        fiveSub = "—"; weekSub = "—"; fiveSubColor = "#6E7581"; weekSubColor = "#6E7581";
        resetLine = "读不到 dashboard-data.js：" + cx.err; resetColor = "#D9A05B";
      }
      // C 段：今天 · 这个项目
      if (proj != null) {
        lastText = Fmt.MD(proj.lastMs);
        todayTurns = proj.todayTurns;
        if (sess.todayTurns > 0) todayLine = "今天 " + proj.todayTurns + " 轮 · 占今天 " + Math.Round(100.0 * proj.todayTurns / sess.todayTurns, MidpointRounding.AwayFromZero).ToString("N0", CultureInfo.InvariantCulture) + "%";
        else todayLine = "今天 " + proj.todayTurns + " 轮 · 今天还没有活动";
        if (att7.ok && att7.found) weekLine = "近 7 天 " + att7.turns7 + " 轮 · " + att7.sessions7 + " 个会话（attribution.json）";
        else weekLine = "近 7 天 " + proj.weekTurns + " 轮 · " + proj.weekSessions + " 个会话（现算）";
      } else {
        lastText = "—"; todayTurns = 0;
        todayLine = "今天 0 轮 · 读不到会话记录"; weekLine = "近 7 天 —";
      }
      // 微型：最紧的那个 Codex 额度
      ok = false; quotaLabel = "Codex"; quotaRemain = 0; quotaUsed = 0; quotaAlt = "";
      if (codexOk) {
        if (fiveRemain <= weekRemain) {
          quotaLabel = "Codex 5h"; quotaRemain = fiveRemain; quotaUsed = five;
          qWarnUsed = cx.warn5hUsed; qCritUsed = cx.crit5hUsed;
          quotaAlt = "7 天 还剩 " + Fmt.Pct(weekRemain);
        } else {
          quotaLabel = "Codex 7 天"; quotaRemain = weekRemain; quotaUsed = week;
          qWarnUsed = cx.warnWeekUsed; qCritUsed = 95.0;
          quotaAlt = "5h 还剩 " + Fmt.Pct(fiveRemain);
        }
        ok = true;
      }
      sessId = sess.newestSlotId ?? "";
      mintMs = SessionId.MintMs(sessId);
      slotMs = sess.newestSlotMs; slotNo = sess.newestSlotNo ?? "";
      bal = bal ?? new BalSnapshot();
      balView = BalView.Build(bal, 9, 100.0);
      balPick = balView.tightest;
      if (balPick == null && balView.groupCount > 0) balPick = balView.groups[0];
    }

    public double SessionElapsedSec() {
      if (mintMs <= 0) return -1.0;
      return (Fmt.NowMs() - mintMs) / 1000.0;
    }

    // 陈旧判据（唯一出处）：按数据源各算各的 —— 额度看 codex.atMs（45 分钟）、余额看每家自己的 atMs（10 分钟）
    public Fresh Freshness() {
      var fr = new Fresh();
      fr.nowMs = Fmt.NowMs();
      if (codex.ok && codex.atMs > 0) {
        fr.quotaAgeMin = (fr.nowMs - codex.atMs) / 60000.0;
        fr.quotaStale = fr.quotaAgeMin > Geo.STALE_QUOTA_MIN;
      }
      long gen = bal != null ? bal.genMs : 0L;
      if (gen > 0) fr.fileAgeMin = (fr.nowMs - gen) / 60000.0;
      if (balView != null) {
        foreach (var g in balView.groups) {
          long ms = g.atMs > 0 ? g.atMs : gen;
          double age = -1.0; bool st = false;
          if (ms > 0) { age = (fr.nowMs - ms) / 60000.0; st = age > Geo.STALE_BAL_MIN; }
          fr.balAge[g.key] = age;
          fr.balStaleEnv[g.key] = st;
          if (st && !fr.balStale) { fr.balStale = true; fr.balAgeMin = age; }
        }
      }
      return fr;
    }
  }

  internal sealed class Fresh {
    public long nowMs;
    public double quotaAgeMin = -1.0; public bool quotaStale;
    public double balAgeMin = -1.0; public bool balStale;
    public double fileAgeMin = -1.0;
    public Dictionary<string, double> balAge = new Dictionary<string, double>();
    public Dictionary<string, bool> balStaleEnv = new Dictionary<string, bool>();
    public bool StaleOf(string key) { return balStaleEnv.ContainsKey(key) && balStaleEnv[key]; }
  }
}
