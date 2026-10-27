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
    // agent 日志目录：留空 = ~/.thincoder/logs（真值）；自检夹具把它指到临时目录，绝不碰真实日志
    public static string LogDir = "";
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
    public int newestSlotTurns;                 // 本会话轮次（最新槽位的 turnCount）
    public long newestSessionStartMs;           // 本会话的铸造时刻（sessionId 里的 ms；解不出 = 0）

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
              o.newestSlotTurns = turns;
              o.newestSessionStartMs = MintMsOf(sid, nowMs);
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
        if (s.ms > o.newestSlotMs) {
          o.newestSlotMs = s.ms; o.newestSlotId = s.sessionId ?? ""; o.newestSlotNo = "1"; o.newestSlotTurns = s.turns;
          o.newestSessionStartMs = MintMsOf(s.sessionId, nowMs);
        }
      }
      foreach (var r in acc.Values) o.projects.Add(r);
      o.projects.Sort(delegate (ProjRec a, ProjRec b) { return b.lastMs.CompareTo(a.lastMs); });
      foreach (var r in o.projects) {
        o.todayTurns += r.todayTurns; o.todaySessions += r.todaySessions;
        o.weekTurns += r.weekTurns; o.weekSessions += r.weekSessions;
      }
      return o;
    }

    // 会话起点：槽位 sessionId 的形状是 <pid>-<铸造时刻 ms>-<随机>（真机 49 份 manifest 同一个形状）。
    //   解析不出返回 0：上层退回「按天窗口」口径，不编一个假起点。
    private static long MintMsOf(string sid, long nowMs) {
      if (string.IsNullOrEmpty(sid)) return 0L;
      var m = Regex.Match(sid, "^\\d+-(\\d{12,})-[A-Za-z0-9]+$");
      if (!m.Success) return 0L;
      long v;
      if (!long.TryParse(m.Groups[1].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out v)) return 0L;
      long lo = new DateTimeOffset(new DateTime(2020, 1, 1)).ToUnixTimeMilliseconds();
      if (v < lo || v > nowMs + 86400000L) return 0L;   // 不像个铸造时刻就别拿它切
      return v;
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

  // ==================== 当前进展（唯一出处）====================
  // 2026-10-27 用户拍板：「会话 11:08:40」是误导 —— 那是 ThinCoder 进程开了多久（含空闲），
  //   不是「现在在干什么」。改成从 agent 日志推出来的真进展：正在干活 / 等你回答 / 空闲 + 当前这一步已多久。
  //
  // 判据（全部来自 ~/.thincoder/logs/agent-<本地日期>.log 的 JSONL，一次一行，字段 ts/ev 打头）：
  //   最后一条事件是 turn:end        → 这一轮已交付，等你回答（有活进程）/ 空闲（没有）
  //   最后一条事件是别的（turn:start / llm:start / llm:done / tool:call / tool:done / child:* / susp:*）
  //                                 → 正在干活（「这一步多久」不再上屏，见下）
  //   最后一条事件已经超过 PROGRESS_STALE_MIN 分钟 → 不再算「正在干活」（进程可能已经没了或卡死）
  //   日志读不到（不存在 / 读不动 / 一行事件都解不出）→ 词条只按活进程判，**计时那一整行不显示**
  //     （用户原话：不显示 0、也不显示「—」）
  //
  // 本会话轮次：取 ~/.thincoder/sessions/<hash>.json.manifest 里最新槽位的 turnCount（真数据实测 151/152 轮）。
  //
  // 本会话模型累计运行（2026-10-27 用户拍板）：卡片上那个大字要回答的是「大模型真正在跑的时间」——
  //   不是「上一个事件到现在」（那是等待时长），更不是进程开了多久。
  //   口径 = agent 日志里每一条 llm:done 的 ms 累加 + 还没收到 llm:done 的 llm:start 距今（在飞）。
  //   只看本会话：起点 = 最新槽位 sessionId 里的铸造时刻（解不出则退回「今天 + 昨天」整天）。
  //   日志按天分文件（agent-YYYY-MM-DD.log）：先读昨天、再读今天，跨零点的同一次调用也能配对
  //   （配对 = 同一条 stream（child id；主 agent 为空）内后进先出：done 收掉最近一条 start）。
  //   子代理的 llm:* 也算：那是同一个模型在替这次会话干活。
  //   一条 llm:* 都没有（或日志读不到）→ 这个数推不出来 → 计时不上屏（不是 0、也不是「—」）。
  //   超过 MODEL_OPEN_CAP_MS 还没收到 done 的 start 视为残留（可能崩了/日志截断），不再累加。
  //
  // 子代理：日志里**有专门的事件**（child:spawn / child:start，带 id="coder#1"）——
  //   同一 id 只要出现任意一条非 spawn/start 的 child:*（结束事件，名字随宿主版本），就算它收了；
  //   剩下的就是「在跑」。一条都没有（或读不到日志）→ 这个数推不出来 → 那一行不显示。
  internal sealed class Progress {
    public const int PROGRESS_STALE_MIN = 30;   // 一步超过它还没有任何日志 = 不再算「正在干活」
    public const long MODEL_OPEN_CAP_MS = 30L * 60000L;   // 在飞的 llm:start 超过它 = 残留，不再累加
    public string state = "idle";               // work / wait / idle
    public string word = "空闲", color = "#8A909C";
    public bool logOk;                          // 日志读到并至少解出一条事件
    public bool haveSince;                      // 最后一条事件时刻可用（三态判据用）
    public long sinceMs;                        // 最后一条事件的时刻
    public int turns; public bool haveTurns;    // 本会话轮次（0/缺 = 不显示）
    public int children;                        // 在跑的子代理数
    public long longestChildMs;                 // 最长的那个跑了多久
    public bool haveChildren;                   // 子代理数推得出来（今天至少出现过一条 child:*）
    public string lastEvent = "", logPath = "", why = "";
    public long lastEventMs;
    // 本会话模型累计运行（口径见上）
    public long modelDoneMs;                    // llm:done 的 ms 累加（本会话）
    public long[] modelOpenStarts = new long[0];// 还没收到 done 的 llm:start（在飞）
    public int modelCalls;                      // 参与累加的 llm:done 条数（读数/自检用）
    public bool haveModel;                      // 日志里至少有 llm:* 事件（推得出来）

    // 在飞按「读的这一刻」算：缓存没变时也每秒走（ElapsedText 每秒被调一次）
    public long ModelElapsedMs(long nowMs) {
      long total = modelDoneMs;
      for (int i = 0; i < modelOpenStarts.Length; i++) {
        long d = nowMs - modelOpenStarts[i];
        if (d > 0 && d <= MODEL_OPEN_CAP_MS) total += d;
      }
      return total;
    }
    public string ElapsedText() {
      if (!haveModel) return "";
      long ms = ModelElapsedMs(Fmt.NowMs());
      if (ms <= 0) return "";
      return "模型 " + Fmt.Duration(ms / 1000.0);
    }
    // 计时行到底上不上屏（推不出来 → 不显示；不是 0、也不是「—」）
    public bool ShowTiming { get { return haveModel && ModelElapsedMs(Fmt.NowMs()) > 0; } }
    // 子代理行：0 个就不显示（能少写字就少写字；推不出来也不许瞎猜）
    public string ChildText() {
      if (!haveChildren || children <= 0) return "";
      return "子代理 " + children + " 个在跑 · 最长 " + Fmt.AgeShort(longestChildMs / 1000.0);
    }

    private static void Word(Progress o) {
      if (o.state == "work") { o.word = "正在干活"; o.color = "#35D07F"; }
      else if (o.state == "wait") { o.word = "等你回答"; o.color = "#F2C94C"; }
      else { o.word = "空闲"; o.color = "#8A909C"; }
    }

    // logDir：留空 = ~/.thincoder/logs（自检夹具会把它指到临时目录）
    public static Progress Read(long nowMs, bool processAlive, int turns, string logDir) {
      return Read(nowMs, processAlive, turns, 0L, logDir);
    }
    // sessionStartMs：本会话的铸造时刻（0 = 不知道 → 退回「今天 + 昨天」按天窗口）
    public static Progress Read(long nowMs, bool processAlive, int turns, long sessionStartMs, string logDir) {
      var o = new Progress();
      o.turns = turns; o.haveTurns = turns > 0;
      string path, why;
      ParseLog(logDir, out path, out why);
      ParseModelTime(logDir);
      o.logPath = path; o.why = why;
      o.logOk = ProgressCache.ok;
      o.modelDoneMs = ModelCache.DoneSince(sessionStartMs);
      o.modelOpenStarts = ModelCache.OpenSince(sessionStartMs);
      o.modelCalls = ModelCache.CallsSince(sessionStartMs);
      o.haveModel = ModelCache.ok && (o.modelCalls > 0 || o.modelOpenStarts.Length > 0);
      if (!o.logOk) {
        // 日志读不到：词条只按「有没有活着的 ThinCoder 进程」判；计时与轮次那一行整行不显示
        o.state = processAlive ? "wait" : "idle";
        Word(o);
        return o;
      }
      o.lastEvent = ProgressCache.lastEv;
      o.lastEventMs = ProgressCache.lastTs;
      o.sinceMs = ProgressCache.lastTs;
      o.haveSince = true;
      bool ended = ProgressCache.lastEv == "turn:end";
      bool stale = (nowMs - ProgressCache.lastTs) > (long)PROGRESS_STALE_MIN * 60000L;
      if (!ended && !stale) o.state = "work";
      else o.state = processAlive ? "wait" : "idle";
      Word(o);
      o.children = ProgressCache.children; o.longestChildMs = nowMs - ProgressCache.childOldestMs;
      if (o.longestChildMs < 0) o.longestChildMs = 0;
      o.haveChildren = ProgressCache.sawChild;
      return o;
    }

    // 昨天那份：跨零点要回看前一天（日志按天分文件）
    private static string PickLog(string logDir) {
      string dir = logDir;
      if (string.IsNullOrEmpty(dir)) dir = Path.Combine(Sessions.BaseDir(), "logs");
      if (!Directory.Exists(dir)) return null;
      string best = null; long bestMs = -1;
      for (int d = 0; d >= -1; d--) {
        string p = Path.Combine(dir, "agent-" + DateTime.Today.AddDays(d).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + ".log");
        if (!File.Exists(p)) continue;
        long ms = new DateTimeOffset(File.GetLastWriteTimeUtc(p)).ToUnixTimeMilliseconds();
        if (ms > bestMs) { bestMs = ms; best = p; }   // 取「最近还在写的那份」
      }
      return best;
    }

    private static void ParseLog(string logDir, out string path, out string why) {
      why = ""; path = PickLog(logDir);
      if (path == null) { why = "没有 agent 日志（" + (string.IsNullOrEmpty(logDir) ? Path.Combine(Sessions.BaseDir(), "logs") : logDir) + "）"; ProgressCache.Reset(); return; }
      long len = 0, mtime = 0;
      try { var fi = new FileInfo(path); len = fi.Length; mtime = fi.LastWriteTimeUtc.Ticks; } catch (Exception ex) { why = ex.Message; ProgressCache.Reset(); return; }
      if (ProgressCache.Same(path, len, mtime)) return;   // 没变就不重解（5 秒一轮，别白烧 CPU）
      ProgressCache.Reset();
      ProgressCache.path = path; ProgressCache.len = len; ProgressCache.mtime = mtime;
      try {
        string text = Io.ReadAllTextShared(path);
        // 只看尾部：日志一天能长到几 MB，状态只跟最后几条走（子代理的 spawn 也在这个窗口里）
        const int TAIL_CHARS = 2 * 1024 * 1024;
        if (text.Length > TAIL_CHARS) text = text.Substring(text.Length - TAIL_CHARS);
        var lines = text.Split('\n');
        var open = new Dictionary<string, long>();
        var closed = new Dictionary<string, bool>();
        bool sawLast = false;
        for (int i = 0; i < lines.Length; i++) {
          string line = lines[i];
          if (line.Length < 12 || line[0] != '{') continue;
          long ts; string ev;
          if (!Head(line, out ts, out ev)) continue;
          if (ev == "memory:maintain") continue;      // 后台维护，不属于任何一轮
          ProgressCache.lastTs = ts; ProgressCache.lastEv = ev; sawLast = true;
          if (ev.StartsWith("child:", StringComparison.Ordinal)) {
            string id = Field(line, "\"id\":\"");
            if (id == null) continue;
            ProgressCache.sawChild = true;
            if (ev == "child:spawn" || ev == "child:start") {
              long prev;
              if (!open.TryGetValue(id, out prev) || ts < prev) open[id] = ts;
            } else {
              closed[id] = true;                        // 任何非 spawn/start 的 child:* = 它收工了
            }
          }
        }
        if (!sawLast) { why = "日志里没有可解析的事件（" + lines.Length + " 行）"; ProgressCache.Reset(); return; }
        long oldest = 0;
        foreach (var kv in open) {
          if (closed.ContainsKey(kv.Key)) continue;
          ProgressCache.children++;
          if (oldest == 0 || kv.Value < oldest) oldest = kv.Value;
        }
        ProgressCache.childOldestMs = oldest;
        ProgressCache.ok = true;
      } catch (Exception ex) { why = ex.Message; ProgressCache.Reset(); }
    }

    // 模型累计运行：今天 + 昨天两份 agent 日志（跨零点回看前一天）。
    //   缓存键 = 两份文件各自的「路径/长度/修改时刻」；没变就不重解（面板 5 秒问一次）。
    //   先昨天、后今天：同一次调用跨零点也能配上对（同一条 stream 内后进先出）。
    private static void ParseModelTime(string logDir) {
      string dir = logDir;
      if (string.IsNullOrEmpty(dir)) dir = Path.Combine(Sessions.BaseDir(), "logs");
      string today = PickLogByDay(dir, 0), yest = PickLogByDay(dir, -1);
      string key = StampOf(yest) + "|" + StampOf(today);
      if (ModelCache.Same(key)) return;
      ModelCache.Reset(); ModelCache.key = key;
      var open = new Dictionary<string, List<long>>();
      var dts = new List<long>(); var dms = new List<long>();
      bool saw = false;
      for (int pass = 0; pass < 2; pass++) {
        string p = pass == 0 ? yest : today;
        if (string.IsNullOrEmpty(p) || !File.Exists(p)) continue;
        string text;
        try { text = Io.ReadAllTextShared(p); } catch { continue; }
        var lines = text.Split('\n');
        for (int i = 0; i < lines.Length; i++) {
          string line = lines[i];
          if (line.Length < 12 || line[0] != '{') continue;
          long ts; string ev;
          if (!Head(line, out ts, out ev)) continue;
          if (ev != "llm:start" && ev != "llm:done") continue;
          saw = true;
          string stream = Field(line, "\"child\":\"") ?? "";
          List<long> st;
          if (!open.TryGetValue(stream, out st)) { st = new List<long>(); open[stream] = st; }
          if (ev == "llm:start") { st.Add(ts); continue; }
          long start = 0;
          if (st.Count > 0) { start = st[st.Count - 1]; st.RemoveAt(st.Count - 1); }
          long ms = LongField(line, "\"ms\":");
          if (ms <= 0 && start > 0 && ts > start) ms = ts - start;   // 缺 ms 的旧行：用起止时刻兜底
          dts.Add(ts); dms.Add(ms > 0 ? ms : 0);
        }
      }
      ModelCache.doneTs = dts.ToArray(); ModelCache.doneMsArr = dms.ToArray(); ModelCache.ok = saw;
      var left = new List<long>();
      foreach (var kv in open) foreach (long t in kv.Value) left.Add(t);
      left.Sort();
      ModelCache.open = left.ToArray();
    }

    private static string PickLogByDay(string dir, int dayOffset) {
      return Path.Combine(dir, "agent-" + DateTime.Today.AddDays(dayOffset).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + ".log");
    }
    private static string StampOf(string p) {
      try {
        if (string.IsNullOrEmpty(p) || !File.Exists(p)) return "-";
        var fi = new FileInfo(p);
        return fi.Length.ToString(CultureInfo.InvariantCulture) + ":" + fi.LastWriteTimeUtc.Ticks.ToString(CultureInfo.InvariantCulture);
      } catch { return "?"; }
    }
    private static long LongField(string line, string key) {
      int i = line.IndexOf(key, StringComparison.Ordinal);
      if (i < 0) return 0;
      int b = i + key.Length, e = b;
      while (e < line.Length && line[e] >= '0' && line[e] <= '9') e++;
      long v;
      return e > b && long.TryParse(line.Substring(b, e - b), NumberStyles.Integer, CultureInfo.InvariantCulture, out v) ? v : 0;
    }

    // 每行头两个字段就是 ts 与 ev（`{"ts":"…","ev":"…"`）—— 按行首剥，别被 head 里的正文带跑偏
    private static bool Head(string line, out long ts, out string ev) {
      ts = 0; ev = null;
      var m = Regex.Match(line, "^\\{\"ts\":\"([^\"]+)\",\"ev\":\"([^\"]+)\"");
      if (!m.Success) return false;
      DateTimeOffset dto;
      if (!DateTimeOffset.TryParse(m.Groups[1].Value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out dto)) return false;
      ts = dto.ToUnixTimeMilliseconds(); ev = m.Groups[2].Value;
      return true;
    }
    private static string Field(string line, string key) {
      int i = line.IndexOf(key, StringComparison.Ordinal);
      if (i < 0) return null;
      int b = i + key.Length, e = line.IndexOf('"', b);
      return e > b ? line.Substring(b, e - b) : null;
    }

    // 模型累计的解析缓存（键 = 昨天 + 今天两份文件的 路径/长度/修改时刻）
    //   存逐条 (ts, ms)：会话边界一变就能现算，不用重解日志。
    private static class ModelCache {
      public static string key = "";
      public static long[] doneTs = new long[0], doneMsArr = new long[0];
      public static long[] open = new long[0];
      public static bool ok;
      public static void Reset() { key = ""; doneTs = new long[0]; doneMsArr = new long[0]; open = new long[0]; ok = false; }
      public static bool Same(string k) { return key.Length > 0 && key == k; }
      public static int CallsSince(long sinceMs) {
        int n = 0;
        for (int i = 0; i < doneTs.Length; i++) if (sinceMs <= 0 || doneTs[i] >= sinceMs) n++;
        return n;
      }
      public static long DoneSince(long sinceMs) {
        long t = 0;
        for (int i = 0; i < doneTs.Length; i++) if (sinceMs <= 0 || doneTs[i] >= sinceMs) t += doneMsArr[i];
        return t;
      }
      public static long[] OpenSince(long sinceMs) {
        var l = new List<long>();
        for (int i = 0; i < open.Length; i++) if (sinceMs <= 0 || open[i] >= sinceMs) l.Add(open[i]);
        return l.ToArray();
      }
    }

    // 解析结果缓存（键 = 文件 + 长度 + 修改时刻）：面板每 5 秒问一次，日志没变就别重解
    private static class ProgressCache {
      public static string path = "", lastEv = "";
      public static long len = -1, mtime = -1, lastTs, childOldestMs;
      public static int children;
      public static bool ok, sawChild;
      public static void Reset() {
        lastEv = ""; lastTs = 0; children = 0; childOldestMs = 0; ok = false; sawChild = false;
      }
      public static bool Same(string p, long l, long m) { return ok && path == p && len == l && mtime == m; }
    }
  }

  // ==================== 余额节奏（唯一出处）====================
  // 用户口径（2026-10-27 拍板）：「最近 ¥10 用了多久」—— 充值不算消耗；**充值之后重新起算**，
  //   跨过充值那一段时间不许算进去；充值后没花够 ¥10 → 「充值后花了 ¥X · 用时 Y」；
  //   近 24 小时没花钱 → 「最近 24 小时没花钱」；**绝不许出现 Infinity**（永远是个具体时长或一句固定话）。
  //
  // 数据：<安装根>/data/history/<平台>.jsonl，每行 {ts, ok, totalBalance|balance, …}（采集器每 5 分钟追加一行）。
  //   只看 ok 为真的样本；余额**上升 > ¥1** 记一次充值（小额抖动不算）；只把**下降**累计成消耗。
  internal sealed class Cadence {
    public const double TOPUP_RISE = 1.0;     // ¥1：一次余额上升超过它才算充值
    public const double BLOCK = 10.0;         // 「最近 ¥10」那一块
    public const double NO_SPEND_HOURS = 24.0;
    public bool ok; public string why = "", text = "";
    public double spent; public int topups; public int blocks;
    public static string PathOf(string dataRoot, string key) {
      return Path.Combine(Path.Combine(Path.Combine(dataRoot ?? "", "data"), "history"), key + ".jsonl");
    }
    public static Cadence Read(string dataRoot, string key, long nowMs) {
      var o = new Cadence();
      if (string.IsNullOrEmpty(dataRoot)) { o.why = "没有数据目录"; return o; }   // 别把相对路径当根（会读到仓里的 data/）
      string p = PathOf(dataRoot, key);
      if (!File.Exists(p)) { o.why = "没有 " + key + ".jsonl"; return o; }
      string balKey = key == "glm" ? "\"balance\":" : "\"totalBalance\":";
      var ts = new List<long>(); var val = new List<double>();
      try {
        foreach (string line in Io.ReadAllTextShared(p).Split('\n')) {
          if (line.Length < 16 || line[0] != '{') continue;
          if (line.IndexOf("\"ok\":false", StringComparison.Ordinal) >= 0) continue;   // 采失败的样本不参与
          long t; double v;
          if (!Num(line, "\"ts\":", out t)) continue;
          if (!Dbl(line, balKey, out v)) continue;
          if (ts.Count > 0 && t <= ts[ts.Count - 1]) continue;   // 时间必须往前走（乱序行丢掉）
          ts.Add(t); val.Add(v);
        }
      } catch (Exception ex) { o.why = ex.Message; return o; }
      int n = ts.Count;
      if (n < 2) { o.why = "历史只有 " + n + " 行"; return o; }
      // 最后一次充值（余额单次上升 > TOPUP_RISE）
      int start = 0;
      for (int i = 1; i < n; i++) if (val[i] - val[i - 1] > TOPUP_RISE) { start = i; o.topups++; }
      // 起算之后的消耗曲线（只累计下降；上升已经当充值切开了）
      double cum = 0; long lastSpendMs = 0;
      for (int i = start + 1; i < n; i++) {
        double d = val[i - 1] - val[i];
        if (d <= 0.0) continue;
        cum += d; lastSpendMs = ts[i];
      }
      o.ok = true; o.spent = cum;
      bool noSpend = lastSpendMs == 0 || (nowMs - lastSpendMs) > (long)(NO_SPEND_HOURS * 3600000.0);
      if (noSpend) { o.text = "最近 24 小时没花钱"; return o; }
      double k = Math.Floor(cum / BLOCK + 1e-9);          // 起算以来花完了几块 ¥10
      o.blocks = (int)k;
      if (k >= 1.0) {
        double lo = (k - 1.0) * BLOCK, hi = k * BLOCK;
        long tLo = lo <= 0.0 ? ts[start] : 0, tHi = 0; double acc = 0;
        for (int i = start + 1; i < n; i++) {
          double d = val[i - 1] - val[i];
          if (d <= 0.0) continue;
          acc += d;
          if (tLo == 0 && acc >= lo) tLo = ts[i];
          if (acc >= hi) { tHi = ts[i]; break; }
        }
        if (tHi > 0 && tHi > tLo) {
          o.text = "最近 ¥10 用了 " + Fmt.AgeShort((tHi - tLo) / 1000.0);
          return o;
        }
      }
      // 充值后还没花够 ¥10（或这份历史里从来没有充值过 → 从最早那行起算）
      double sec = Math.Max(0.0, (nowMs - ts[start]) / 1000.0);
      string head = start > 0 ? "充值后花了 " : "花了 ";
      o.text = head + Fmt.Money("¥", cum) + " · 用时 " + Fmt.AgeShort(sec);
      return o;
    }
    private static bool Num(string line, string key, out long v) {
      v = 0; int i = line.IndexOf(key, StringComparison.Ordinal);
      if (i < 0) return false;
      int b = i + key.Length, e = b;
      while (e < line.Length && line[e] >= '0' && line[e] <= '9') e++;
      return e > b && long.TryParse(line.Substring(b, e - b), NumberStyles.Integer, CultureInfo.InvariantCulture, out v);
    }
    private static bool Dbl(string line, string key, out double v) {
      v = 0; int i = line.IndexOf(key, StringComparison.Ordinal);
      if (i < 0) return false;
      int b = i + key.Length, e = b;
      while (e < line.Length && (line[e] == '-' || line[e] == '.' || (line[e] >= '0' && line[e] <= '9'))) e++;
      return e > b && double.TryParse(line.Substring(b, e - b), NumberStyles.Float, CultureInfo.InvariantCulture, out v);
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

  // 状态四态（今天是「正在运行 / 等你回答 / 已完成 / 今天没用过」）已在 2026-10-27 换成 Progress 的三态
  //   （正在干活 / 等你回答 / 空闲）—— 四态里「正在运行」只看文件 20 秒内有写入，
  //   把「agent 停下等你」也算成运行，用户看到的正是那条误导的「会话 H:MM:SS」。三态的唯一出处在 Progress。

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
    public Progress progress = new Progress();
    public readonly Dictionary<string, Cadence> cadence = new Dictionary<string, Cadence>();
    public double fivePct, weekPct, fiveRemain, weekRemain;
    public bool codexOk;
    public string fiveSub = "—", weekSub = "—", fiveSubColor = "#6E7581", weekSubColor = "#6E7581";
    public string resetLine = "—", resetColor = "#D9A05B";
    public string snapText = "";
    public string lastText = "—", todayLine = "今天 0 轮 · 读不到会话记录", weekLine = "近 7 天 —";
    public int todayTurns;
    public bool ok; public string quotaLabel = "Codex", quotaAlt = "";
    public double quotaRemain, quotaUsed, qWarnUsed = 80.0, qCritUsed = 95.0;
    public string sessId = ""; public long slotMs; public string slotNo = "";
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
      o.Finish(act, act.livePeers > 0);
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
      o.Finish(act, act.livePeers > 0);
      return o;
    }

    // 进展 / 余额节奏的重读入口（面板每 5 秒走一次，不必重读余额与额度）
    public void RefreshLive(bool processAlive) {
      nowMs = Fmt.NowMs();
      progress = Progress.Read(nowMs, processAlive, sess != null ? sess.newestSlotTurns : 0, sess != null ? sess.newestSessionStartMs : 0L, Ctx.LogDir);
    }

    private void Finish(Activity act, bool processAlive) {
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
      slotMs = sess.newestSlotMs; slotNo = sess.newestSlotNo ?? "";
      bal = bal ?? new BalSnapshot();
      balView = BalView.Build(bal, 9, 100.0);
      balPick = balView.tightest;
      if (balPick == null && balView.groupCount > 0) balPick = balView.groups[0];
      // 当前进展（三态 + 已 X + 本会话轮次 + 在跑的子代理）与余额节奏（每家的「最近 ¥10 用了多久」）
      progress = Progress.Read(nowMs, processAlive, sess != null ? sess.newestSlotTurns : 0, sess != null ? sess.newestSessionStartMs : 0L, Ctx.LogDir);
      cadence.Clear();
      foreach (var g in balView.groups) cadence[g.key] = Cadence.Read(Ctx.DataRoot, g.key, nowMs);
    }

    public Cadence CadenceOf(string key) {
      Cadence c;
      return cadence.TryGetValue(key, out c) && c != null ? c : new Cadence();
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
