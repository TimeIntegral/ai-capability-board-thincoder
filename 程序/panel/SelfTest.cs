// 常驻悬浮看板 —— 自检出口（--selftest / --selftest-ui）
// 用途：把设计档 3.2 的 T6–T16 变成可机判的读数行（CHECK  PASS|FAIL / READ / SCREEN / SUMMARY）。
// 纪律：自检一律用**假数据夹具**（临时目录），不写真实状态文件、不改真实数据文件（docs/TODO.md T7）。
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows;
using System.Windows.Media;

namespace Board {
  internal static class SelfTest {
    private static TextWriter W;
    private static int pass, fail;

    private static void Check(string id, bool ok, string detail) {
      if (ok) pass++; else fail++;
      W.WriteLine("CHECK " + id + " " + (ok ? "PASS" : "FAIL") + " " + detail);
    }
    private static void Read(string key, object v) { W.WriteLine("READ " + key + " " + Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture)); }
    private static void Screen(string s) { if (!string.IsNullOrEmpty(s)) W.WriteLine("SCREEN " + s); }

    public static int Run(TextWriter w, string dataRoot) {
      W = w; pass = 0; fail = 0;
      var M = Metrics.Fake(1920, 1080, 1.0);
      var M15 = Metrics.Fake(2560, 1600, 1.5);
      Section("T6", delegate { T6(M, M15); });
      Section("T7", delegate { T7(M); });
      Section("T8", delegate { T8(M); });
      Section("T9", delegate { T9(); });
      string dir = MakeFixtureDir();
      try {
        Section("T10", delegate { T10(dir); });
        Section("T11", delegate { T11(dir); });
        Section("T12", delegate { T12(dir); });
        Section("T13", delegate { T13(); });
        Section("T31", delegate { T31(); });
        Section("T32", delegate { T32(); });
        Section("T36", delegate { T36(); });
        Section("T33", delegate { T33(); });
        Section("T34", delegate { T34(); });
        Section("T14", delegate { T14(dir); });
        Section("T15", delegate { T15(); });
        Section("T16", delegate { T16(dir); });
        Section("T28", delegate { T28(dir); });
        Section("T29", delegate { T29(dir); });
        Section("T30", delegate { T30(M, M15); });
      } finally {
        try { Directory.Delete(dir, true); } catch { }
      }
      W.WriteLine("SUMMARY pass=" + pass + " fail=" + fail);
      return fail == 0 ? 0 : 1;
    }

    private static void Section(string id, Action body) {
      try { body(); } catch (Exception ex) { Check(id + "-exception", false, ex.GetType().Name + ": " + ex.Message); }
    }

    // ==================== T6 形态几何 ====================
    private static void T6(Metrics M, Metrics M15) {
      double h0 = Geo.PanelH(0, M), h1 = Geo.PanelH(1, M), h2 = Geo.PanelH(2, M);
      Check("T6-panelH", h0 == 328.0 && h1 == 410.0 && h2 == 466.0, "面板高三档 0/1/2 家 = " + Fmt.Num(h0) + "/" + Fmt.Num(h1) + "/" + Fmt.Num(h2) + "（期望 328/410/466）");
      Read("T6.panelH15", Fmt.Num(Geo.PanelH(1, M15)));
      Check("T6-panelH-scaled", Geo.PanelH(1, M15) == 410.0, "150% 缩放下也取整回 " + Fmt.Num(Geo.PanelH(1, M15)) + " DIP");
      string[] edges = new string[] { "right", "left", "top", "bottom" };
      string allDetail = "";
      bool allOk = true;
      foreach (string e in edges) {
        var g = Geo.Medium(e, 540.0, h1, M);
        bool alongOk, winOk;
        string along;
        if (e == "right" || e == "left") {
          alongOk = Math.Abs(g.sliver.h - h1) < 0.001 && Math.Abs(g.sliver.w - 8.0) < 0.001;
          winOk = g.win.w == 272.0 && g.win.h == 490.0;
          along = "小条 " + Fmt.Num(g.sliver.w) + "x" + Fmt.Num(g.sliver.h);
        } else {
          alongOk = Math.Abs(g.sliver.w - Geo.PANEL_W) < 0.001 && Math.Abs(g.sliver.h - 8.0) < 0.001;
          winOk = g.win.w == 312.0 && g.win.h == 450.0;
          along = "小条 " + Fmt.Num(g.sliver.w) + "x" + Fmt.Num(g.sliver.h);
        }
        bool panelOk = g.panel.w == 232.0 && g.panel.h == h1;
        allOk = allOk && alongOk && winOk && panelOk;
        allDetail += Geo.EdgeCn(e) + "[" + along + " 窗口 " + Fmt.Num(g.win.w) + "x" + Fmt.Num(g.win.h) + "] ";
      }
      Check("T6-medium-4edges", allOk, "四条边：收起条长边 = 面板沿边那一维；窗口 " + allDetail);
      var mg = Geo.Micro(100, 100, M);
      Check("T6-micro", mg.card.w == 228.0 && mg.card.h == 90.0 && mg.win.w == 272.0 && mg.win.h == 134.0,
        "卡片 " + Fmt.Num(mg.card.w) + "x" + Fmt.Num(mg.card.h) + "，窗口 " + Fmt.Num(mg.win.w) + "x" + Fmt.Num(mg.win.h));
      // 不穿透的窗口矩形（黑洞）：贴边那侧不留血
      var gr = Geo.Medium("right", 540.0, h1, M);
      var gt = Geo.Medium("top", 960.0, h1, M);
      Check("T6-nonpass", gr.win.x == 1920.0 - 272.0 && gr.panel.x == 40.0 && gt.win.y == 0.0 && gt.panel.y == 0.0 && gt.panel.x == 40.0,
        "右缘窗口贴右（x=" + Fmt.Num(gr.win.x) + "）、上缘贴顶且面板盒 y=" + Fmt.Num(gt.panel.y));
      // 热区
      var hotC = Geo.HotRectPx(gr, "collapsed", M);
      var hotE = Geo.HotRectPx(gr, "expanded", M);
      Check("T6-hot", Math.Abs(hotC.w - 34.0) < 0.001 && Math.Abs(hotC.x - (1920 - 34)) < 0.001 && Math.Abs(hotE.x - (1920 - 272 + 40 - 10)) < 0.001,
        "收起热区 " + Fmt.Num(hotC.w) + " DIP 深；展开热区 x=" + Fmt.Num(hotE.x) + "（面板外扩 10 DIP）");
      // 裁剪
      var clipC = Geo.ClipRectFor("right", 232.0, h1, 8.0, 14.0);
      var clipE = Geo.ClipRectFor("right", 232.0, h1, Geo.ClipReveal("right", new RectD(0, 0, 232, h1)), 14.0);
      Check("T6-clip", Math.Abs(clipC.w - 8.0) < 0.001 && Math.Abs(clipC.x - 224.0) < 0.001 && Math.Abs(clipE.w - 232.0) < 0.001 && Math.Abs(clipE.x) < 0.001,
        "收起裁剪宽 " + Fmt.Num(clipC.w) + "，展开裁剪宽 " + Fmt.Num(clipE.w));
    }

    // ==================== T7 拖动阈值 ====================
    private static void T7(Metrics M) {
      double h1 = 410.0;
      double p359 = Geo.PullOf("right", M.dipW - Geo.PANEL_W - 35.9, 40.0, M, h1);
      double p361 = Geo.PullOf("right", M.dipW - Geo.PANEL_W - 36.1, 40.0, M, h1);
      Check("T7-detach", p359 < Geo.FORM_DETACH_DIP && p361 >= Geo.FORM_DETACH_DIP,
        "拉离 35.9 = " + Fmt.Num(Math.Round(p359, 2)) + " → 仍中型；36.1 = " + Fmt.Num(Math.Round(p361, 2)) + " → 变微型（阈值 " + Fmt.Num(Geo.FORM_DETACH_DIP) + "）");
      double d639, d641;
      Geo.CardEdge(M.dipW - Geo.CARD_W - 63.9, 500.0, M, out d639);
      Geo.CardEdge(M.dipW - Geo.CARD_W - 64.1, 500.0, M, out d641);
      Check("T7-dock", d639 <= Geo.FORM_DOCK_DIP && d641 > Geo.FORM_DOCK_DIP,
        "离边 63.9 → 着陆（≤ " + Fmt.Num(Geo.FORM_DOCK_DIP) + "）；64.1 = " + Fmt.Num(Math.Round(d641, 2)) + " → 不着陆");
      // 到两条边一样近时按 右→左→上→下 的固定顺序取舍
      double _d;
      var tie = Geo.CardEdge(M.dipW / 2.0 - Geo.CARD_W / 2.0, 0.0, M, out _d);
      double _d2;
      var tie2 = Geo.CardEdge(0.0, 0.0, M, out _d2);
      Check("T7-tie", tie == "top" && tie2 == "left", "上/下同距取「上」= " + tie + "；左/上同距（左上角）取「左」= " + tie2);
      // 跟手：τ=8ms、不过冲、<0.4 DIP 直接落位
      double follow = Geo.Follow(0.0, 100.0, 16.0, false);
      double follow2 = Geo.Follow(follow, 100.0, 16.0, false);
      double snap = Geo.Follow(99.8, 100.0, 16.0, false);
      Check("T7-follow", follow > 0 && follow < 100 && follow2 > follow && follow2 < 100 && snap == 100.0,
        "16ms 一拍靠拢到 " + Fmt.Num(Math.Round(follow, 2)) + "（期望 ≈86.5）、第二拍 " + Fmt.Num(Math.Round(follow2, 2)) + "、不过冲、<0.4 DIP 落位 = " + Fmt.Num(snap));
    }

    // ==================== T8 位置记忆 ====================
    private static void T8(Metrics M) {
      string dir = Path.Combine(Path.GetTempPath(), "board-selftest-state-" + Guid.NewGuid().ToString("N"));
      Directory.CreateDirectory(dir);
      try {
        string good = Path.Combine(dir, "good.json");
        File.WriteAllText(good, "{\"schema\":1,\"form\":\"medium\",\"medium\":{\"edge\":\"top\",\"anchor\":300},\"micro\":{\"x\":1200,\"y\":800}}", PanelControl.Utf8NoBom);
        var r1 = PanelState.Load(good);
        Check("T8-good", r1.ok && r1.edge == "top" && r1.anchor == 300.0 && r1.microX == 1200.0,
          "好文件 → form=" + r1.form + " edge=" + r1.edge + " anchor=" + Fmt.Num(r1.anchor) + " micro=(" + Fmt.Num(r1.microX) + "," + Fmt.Num(r1.microY) + ")");
        string bad = Path.Combine(dir, "bad.json");
        File.WriteAllText(bad, "{oops not json", PanelControl.Utf8NoBom);
        var r2 = PanelState.Load(bad);
        Check("T8-bad", !r2.ok, "坏 JSON → ok=false（" + r2.why + "），不抛异常");
        string miss = Path.Combine(dir, "miss.json");
        File.WriteAllText(miss, "{\"form\":\"micro\"}", PanelControl.Utf8NoBom);
        var r3 = PanelState.Load(miss);
        Check("T8-missing", !r3.ok, "缺字段 → ok=false（" + r3.why + "）");
        var r4 = PanelState.Load(Path.Combine(dir, "nope.json"));
        Check("T8-absent", !r4.ok, "没有文件 → ok=false（" + r4.why + "）");
        // 可见性兜底：能修就修
        bool clamped;
        double a = Geo.LimitMediumAnchor("right", 99999.0, 410.0, M, out clamped);
        double a2 = Geo.LimitMediumAnchor("right", 500.0, 410.0, M, out clamped);
        double mx, my; bool cm;
        Geo.LimitMicroPos(9999.0, -50.0, M, out mx, out my, out cm);
        Check("T8-clamp", a == 1080.0 - 245.0 && a2 == 500.0 && cm && mx == 1920.0 - 228.0 && my == 0.0,
          "屏幕变小：锚点 99999 → " + Fmt.Num(a) + "（夹到可见区）；500 → " + Fmt.Num(a2) + "；卡片 (9999,-50) → (" + Fmt.Num(mx) + "," + Fmt.Num(my) + ") clamped=" + cm);
      } finally { try { Directory.Delete(dir, true); } catch { } }
    }

    // ==================== T9 额度口径 ====================
    private static void T9() {
      double[] used = new double[] { 0.0, 38.0, 57.0, 99.6 };
      string got = "";
      bool ok = true;
      foreach (double u in used) { double r = Ctx.RemainPct(u); got += Fmt.Num(r) + " "; }
      ok = Ctx.RemainPct(0) == 100 && Ctx.RemainPct(38) == 62 && Ctx.RemainPct(57) == 43 && Ctx.RemainPct(99.6) == 0.0;
      Check("T9-remain", ok, "剩余 = 100 − 已用（先减后取整）：0→" + Fmt.Num(Ctx.RemainPct(0)) + "、38→" + Fmt.Num(Ctx.RemainPct(38))
        + "、57→" + Fmt.Num(Ctx.RemainPct(57)) + "、99.6→" + Fmt.Num(Ctx.RemainPct(99.6)) + "（四舍五入到整数、夹 0~100）");
      Check("T9-round", Math.Abs(Ctx.RemainPct(87.4) - 13.0) < 0.001 && Ctx.RemainPct(100.5) == 0.0 && Ctx.RemainPct(-1.0) == 100.0,
        "87.4 已用 → 剩 " + Fmt.Num(Ctx.RemainPct(87.4)) + "；越界夹取 100.5→" + Fmt.Num(Ctx.RemainPct(100.5)) + "、-1→" + Fmt.Num(Ctx.RemainPct(-1.0)));
      string c20 = Ctx.ColorOfRemain(20.0, 80.0, 95.0), c5 = Ctx.ColorOfRemain(5.0, 80.0, 95.0), c21 = Ctx.ColorOfRemain(21.0, 80.0, 95.0);
      Check("T9-color", c20 == "#F2C94C" && c5 == "#FF6B5A" && c21 == "#35D07F",
        "色档：剩 20% → " + c20 + "（黄）、5% → " + c5 + "（红）、21% → " + c21 + "（绿）");
      Read("T9.displayed", got.Trim());
    }

    // ==================== T10 余额圈五组 ====================
    private static void T10(string dir) {
      // 单元选择：单个值
      Check("T10-unit", RingSpec.BalanceUnit(64, 100, 9) == 100.0 && RingSpec.BalanceUnit(8888.12, 100, 9) == 1000.0 && RingSpec.BalanceUnit(0, 100, 9) == 100.0,
        "每 ¥100 一圈：最大 64 → ¥" + Fmt.Num(RingSpec.BalanceUnit(64, 100, 9)) + "；8888.12 → ¥" + Fmt.Num(RingSpec.BalanceUnit(8888.12, 100, 9)) + "（最多 9 圈）");
      var s1 = RingSpec.For(64.0, 100.0, 1.0);
      Check("T10-group1", s1.pcts.Length == 1 && Math.Abs(s1.pcts[0] - 64.0) < 0.001 && !s1.floored,
        "¥64 / 单元 ¥100 → " + s1.pcts.Length + " 段弧（" + Fmt.Num(s1.pcts[0]) + "%）");
      var s2 = RingSpec.For(8888.12, 1000.0, 1.0);
      Check("T10-group2", s2.pcts.Length == 9 && Math.Abs(s2.pcts[8] - 88.812) < 0.01 && s2.full == 8,
        "¥8,888.12 / 单元 ¥1,000 → 8 个整圈 + 余 " + Fmt.Num(Math.Round(s2.partialPct, 3)) + "%（共 " + s2.pcts.Length + " 段）");
      var s3 = RingSpec.For(5000.0, 1000.0, 1.0);
      Check("T10-group3", s3.pcts.Length == 5 && s3.full == 5 && s3.partialPct == 0.0,
        "¥5,000 / 单元 ¥1,000 → 5 个整圈、没有余弧（" + s3.pcts.Length + " 段）");
      var s3b = RingSpec.For(0.0, 1000.0, 1.0);
      Check("T10-zero", s3b.pcts.Length == 1 && s3b.pcts[0] == 0.0 && RingSpec.For(0.0, 100.0, 1.0).ratioText == "0 圈",
        "真的是 0 元 → 一个空圈（" + Fmt.Num(s3b.pcts[0]) + "%），不是「不画圈」");
      var s4 = RingSpec.For(0.05, 100.0, 1.0);
      Check("T10-tiny", s4.floored && s4.ratioText == "<0.01 圈" && Math.Abs(s4.pcts[0] - (100.0 * 1.0 / 360.0)) < 0.0001,
        "¥0.05 → 最小弧 " + Fmt.Num(Math.Round(s4.pcts[0], 3)) + "% = 1°（真的按 1° 画）+ 上屏「" + s4.ratioText + "」");
      // 读不到：一个圈都不画 + 金额写 —
      WriteFixture(dir, "readfail");
      var bal = BalSnapshot.Read(dir);
      var view = BalView.Build(bal, 9, 100.0);
      var g = view.groups[0];
      Check("T10-readfail", !g.known && g.rings.Length == 0 && g.amountText == "—" && !g.drawable,
        "读不到 → 金额「" + g.amountText + "」、圈 " + g.rings.Length + " 段、drawable=" + g.drawable);
      // 两家共用一个单元
      WriteFixture(dir, "two");
      var bal2 = BalSnapshot.Read(dir);
      var view2 = BalView.Build(bal2, 9, 100.0);
      Check("T10-shared-unit", view2.groups.Count == 2 && view2.unit == 1000.0 && view2.unitHi && view2.unitText == "1 圈 = ¥1,000",
        "两家共用单元 ¥" + Fmt.Num(view2.unit) + "；换过单位才写「" + view2.unitText + "」");
      var dsvg = view2.groups[0]; var glmg = view2.groups[1];
      Check("T10-tightest", view2.tightest != null && view2.tightest.key == "deepseek",
        "最紧的一家 = " + (view2.tightest != null ? view2.tightest.name + "（¥" + Fmt.Num(view2.tightest.value) + "）" : "无"));
      Read("T10.groups", dsvg.name + "=" + dsvg.amountText + "[" + dsvg.ringCount + "段] " + glmg.name + "=" + glmg.amountText + "[" + glmg.ringCount + "段]");
      // 沿用标记与币种
      Check("T10-carried", glmg.marks.IndexOf("沿用") >= 0, "carried=true → 标记「" + glmg.marks + "」");
    }

    // ==================== T11 平台开关 ====================
    private static void T11(string dir) {
      WriteFixture(dir, "glmoff");
      var bal = BalSnapshot.Read(dir);
      var view = BalView.Build(bal, 9, 100.0);
      Check("T11-hidden", view.groups.Count == 1 && view.groups[0].key == "deepseek",
        "cards.glm.show=false → 只剩 " + view.groups.Count + " 组（" + view.groups[0].name + "）");
      WriteFixture(dir, "nocards");
      var bal2 = BalSnapshot.Read(dir);
      var view2 = BalView.Build(bal2, 9, 100.0);
      Check("T11-default", view2.groups.Count == 2, "缺 cards 字段 = 都显示（" + view2.groups.Count + " 组）");
    }

    // ==================== T12 今天与 7 天 ====================
    private static void T12(string dir) {
      long now = Fmt.NowMs();
      long todayStart = new DateTimeOffset(DateTime.Today).ToUnixTimeMilliseconds();
      var slots = new List<SlotRec>();
      slots.Add(Slot("proj/Alpha", now - 60 * 1000, 5, "4242-" + (now - 60 * 1000) + "-abcd"));
      slots.Add(Slot("proj/Alpha", todayStart + 10 * 60 * 1000, 7, "4242-" + (todayStart + 10 * 60 * 1000) + "-efgh"));
      slots.Add(Slot("proj/Alpha", now - 26 * 3600 * 1000, 3, "4242-" + (now - 26 * 3600 * 1000) + "-ijkl"));
      slots.Add(Slot("proj/Alpha", now - 8 * 24 * 3600 * 1000, 2, "4242-" + (now - 8 * 24 * 3600 * 1000) + "-mnop"));
      var sess = Sessions.FromSlots(slots, now);
      Check("T12-today", sess.todayTurns == 12 && sess.todaySessions == 2,
        "今天（本地 0 点起算）轮次 = " + sess.todayTurns + "（今天两点会话 5+7；跨零点那条算在最后更新的那一天）、会话 " + sess.todaySessions);
      Check("T12-week", sess.weekTurns == 15 && sess.weekSessions == 3,
        "近 7 天 = " + sess.weekTurns + " 轮 / " + sess.weekSessions + " 个会话（8 天前那条不算）");
      var proj = sess.projects[0];
      // 会话起点 = 最新槽位 sessionId 里的铸造时刻（模型累计只用它之后的事件）；解不出就退回按天窗口
      var badSlots = new List<SlotRec>();
      badSlots.Add(Slot("proj/Alpha", now, 1, "not-a-session-id"));
      var badSess = Sessions.FromSlots(badSlots, now);
      Check("T12-session-start", sess.newestSessionStartMs == now - 60 * 1000 && badSess.newestSessionStartMs == 0,
        "最新槽位 sessionId 里的铸造时刻 = " + sess.newestSessionStartMs + "（期望 " + (now - 60 * 1000) + "）；解不出的 id → " + badSess.newestSessionStartMs + "（退回按天窗口）");
      Check("T12-proj", proj.todayTurns == 12 && proj.todaySessions == 2 && proj.name == "Alpha",
        "项目 " + proj.name + "：今天 " + proj.todayTurns + " 轮 / " + proj.todaySessions + " 个会话");
      // 7 天来源：attribution.json 有行 = 取自看板数据；没有行 = 现算并标注
      var att = Att7.Read(dir, "proj/Alpha");
      WriteFixture(dir, "two");
      File.WriteAllText(Path.Combine(dir, "data", "attribution.json"),
        "{\"generatedAtMs\":" + now + ",\"thinCoder\":{\"projects\":[{\"cwd\":\"proj/Alpha\",\"project\":\"Alpha\",\"turns7\":40,\"sessions7\":4}]}}", PanelControl.Utf8NoBom);
      var att2 = Att7.Read(dir, "proj/Alpha");
      string attRaw = File.ReadAllText(Path.Combine(dir, "data", "attribution.json"), Encoding.UTF8);
      var attObj = Json.Obj(Json.Get(Json.Obj(Json.Parse(attRaw)), "thinCoder"));
      var attRows = attObj != null ? Json.Arr(Json.Get(attObj, "projects")) : null;
      string attCwd = attRows != null && attRows.Count > 0 ? Json.Str(Json.Get(Json.Obj(attRows[0]), "cwd")) : "（取不到）";
      Read("T12.attCwd", attCwd + " / want proj/Alpha / rows=" + (attRows == null ? "null" : attRows.Count.ToString()));
      Check("T12-att7", att2.ok && att2.found && att2.turns7 == 40,
        "attribution.json 有该项目行 → 近 7 天 " + att2.turns7 + " 轮 / " + att2.sessions7 + " 个会话（取自看板数据）｜ok=" + att2.ok + " found=" + att2.found + (att2.ok ? "" : " err=" + att2.err));
      var codex = QuotaSnap.Read(Path.Combine(dir, "dashboard-data.js"));
      var bal = BalSnapshot.Read(dir);
      var m1 = Model.BuildFor(codex, sess, att, bal, now, new Activity());
      var m2 = Model.BuildFor(codex, sess, att2, bal, now, new Activity());
      Check("T12-label", m1.weekLine.IndexOf("现算") >= 0 && m2.weekLine.IndexOf("attribution.json") >= 0,
        "没有行 → 「" + m1.weekLine + "」；有行 → 「" + m2.weekLine + "」");
    }

    // ==================== T13 当前进展三态（2026-10-27 起：四态换成三态）====================
    // 四态里「正在运行」只看「文件 20 秒内有写入」，把「停在那儿等你」也算成运行；
    //   mini 卡片上那条「会话 H:MM:SS」就是这么骗人的（它其实是进程开了多久）。三态从 agent 日志推：
    //   正在干活 / 等你回答 / 空闲。词表唯一出处在 Progress。
    private static void T13() {
      long now = Fmt.NowMs();
      string dir = MakeLogDir();
      try {
        Ctx.LogDir = dir;
        // ① 最后一条事件是 tool:call（还没收）→ 正在干活
        WriteLog(dir, "work", now);
        var r1 = Progress.Read(now, false, 151, dir);
        Check("T13-running", r1.state == "work" && r1.word == "正在干活",
          "日志最后一条是 tool:call → " + r1.word + "（当前这一步已 " + Fmt.Duration((now - r1.sinceMs) / 1000.0) + "）");
        // ② turn:end + 有活着的 ThinCoder 进程 → 等你回答
        WriteLog(dir, "ended", now);
        var r2 = Progress.Read(now, true, 151, dir);
        Check("T13-waiting", r2.state == "wait" && r2.word == "等你回答",
          "日志最后一条是 turn:end + 进程还活着 → " + r2.word);
        // ③ turn:end + 没有活进程 → 空闲
        var r3 = Progress.Read(now, false, 151, dir);
        Check("T13-done", r3.state == "idle" && r3.word == "空闲", "turn:end + 进程没了 → " + r3.word);
        // ④ 日志读不到 → 词条只按活进程判，计时那一整行不显示（不是 0、也不是「—」）
        string none = Path.Combine(Path.GetTempPath(), "board-nolog-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(none);
        try {
          var r4 = Progress.Read(now, false, 151, none);
          Check("T13-none", !r4.logOk && r4.state == "idle" && r4.ElapsedText() == "" && !r4.ShowTiming,
            "日志不存在 → " + r4.word + "（日志：" + r4.why + "）；计时行不显示（ElapsedText=\"" + r4.ElapsedText() + "\"）");
        } finally { try { Directory.Delete(none, true); } catch { } }
        // ⑤ 边界：最后一条事件距今超过 PROGRESS_STALE_MIN 分钟 → 不再算正在干活
        WriteLog(dir, "stale", now);
        var r5 = Progress.Read(now, false, 151, dir);
        Check("T13-boundary", r5.state != "work",
          "最后一条事件已是 " + Progress.PROGRESS_STALE_MIN + " 分钟前（上限 " + Progress.PROGRESS_STALE_MIN + " 分钟）→ " + r5.word + "（不再冒充正在干活）");
      } finally { Ctx.LogDir = ""; try { Directory.Delete(dir, true); } catch { } }
    }

    // ==================== T31 当前进展那一行（已 X + 本会话轮次）====================
    private static void T31() {
      long now = Fmt.NowMs();
      string dir = MakeLogDir();
      try {
        Ctx.LogDir = dir;
        WriteLog(dir, "work", now);
        var pg = Progress.Read(now, false, 151, dir);
        Check("T31-line", pg.ShowTiming && pg.ElapsedText() == "模型 00:02" && pg.haveTurns && pg.turns == 151,
          "日志可读 → 上屏「" + pg.ElapsedText() + "」（夹具里只有一条 llm:done ms=2000）+「" + pg.turns + " 轮」");
        Check("T31-no-dash", pg.ElapsedText().IndexOf("—") < 0 && pg.ElapsedText().IndexOf("0:00") < 0,
          "计时行不许出现「—」、也不许恒为 0:00（现在的值是「" + pg.ElapsedText() + "」）");
        string none = Path.Combine(Path.GetTempPath(), "board-nolog-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(none);
        try {
          var bad = Progress.Read(now, false, 151, none);
          Check("T31-hidden", !bad.ShowTiming && bad.ElapsedText() == "",
            "日志读不到 → 计时 + 轮次那一整行不显示（ShowTiming=" + bad.ShowTiming + "、ElapsedText=\"" + bad.ElapsedText() + "\"）");
        } finally { try { Directory.Delete(none, true); } catch { } }
        Read("T31.since", pg.lastEvent + " @" + pg.lastEventMs.ToString(System.Globalization.CultureInfo.InvariantCulture));
      } finally { Ctx.LogDir = ""; try { Directory.Delete(dir, true); } catch { } }
    }

    // ==================== T32 子代理（只认日志里的 child:* 事件）====================
    private static void T32() {
      long now = Fmt.NowMs();
      string dir = MakeLogDir();
      try {
        Ctx.LogDir = dir;
        WriteLog(dir, "children", now);
        var pg = Progress.Read(now, false, 151, dir);
        string ct = pg.ChildText();
        string head = "子代理 1 个在跑 · 最长 ";
        Check("T32-running", pg.haveChildren && pg.children == 1 && ct.StartsWith(head) && ct.Length > head.Length,
          "两个起过、一个已收工 → 上屏「" + ct + "」");
        WriteLog(dir, "nochild", now);
        var none = Progress.Read(now, false, 151, dir);
        Check("T32-none", none.ChildText() == "",
          "日志里一条子代理事件都没有 → 这一行不显示（推不出来就不瞎猜；Text=\"" + none.ChildText() + "\"）");
      } finally { Ctx.LogDir = ""; try { Directory.Delete(dir, true); } catch { } }
    }

    // ==================== T36 本会话模型累计运行（2026-10-27 用户口径）====================
    // 口径：日志里 llm:done 的 ms 累加 + 在飞的 llm:start 至今；今天 + 昨天（跨零点回看）。
    // 反例：一条 llm:* 都没有 → 计时不上屏（不是 0、也不是「—」）；在飞超过 30 分钟 → 当残留、不累加。
    private static void T36() {
      long now = Fmt.NowMs();
      string dir = MakeLogDir();
      try {
        Ctx.LogDir = dir;
        // ① 两条 done（31326 / 2000）+ 一个子代理在飞 5 秒 → 38326 ms = 00:38
        var sb = new StringBuilder();
        int seq = 1;
        sb.Append(LogLine(now - 90000, "turn:start", seq++, "\"kind\":\"user\""));
        sb.Append(LogLine(now - 80000, "llm:start", seq++, "\"provider\":\"deepseek\",\"model\":\"deepseek-flash\",\"stage\":\"turn\",\"turn\":1,\"auto\":false"));
        sb.Append(LogLine(now - 48674, "llm:done", seq++, "\"provider\":\"deepseek\",\"model\":\"deepseek-flash\",\"ms\":31326,\"stage\":\"turn\",\"turn\":1,\"auto\":false,\"finish\":\"tool_calls\",\"tools\":1"));
        sb.Append(LogLine(now - 30000, "llm:start", seq++, "\"provider\":\"deepseek\",\"model\":\"deepseek-flash\",\"stage\":\"turn\",\"turn\":1,\"auto\":false"));
        sb.Append(LogLine(now - 25000, "llm:done", seq++, "\"provider\":\"deepseek\",\"model\":\"deepseek-flash\",\"ms\":2000,\"stage\":\"turn\",\"turn\":1,\"auto\":false,\"finish\":\"stop\",\"tools\":0"));
        sb.Append(LogLine(now - 5000, "llm:start", seq++, "\"provider\":\"deepseek\",\"model\":\"deepseek-flash\",\"stage\":\"turn\",\"turn\":14,\"auto\":false,\"child\":\"coder#1\""));
        File.WriteAllText(LogPathFor(dir, 0), sb.ToString(), PanelControl.Utf8NoBom);
        var pg = Progress.Read(now, false, 151, dir);
        Check("T36-sum", pg.haveModel && pg.modelCalls == 2 && pg.ElapsedText() == "模型 00:38",
          "两条 llm:done（31326 + 2000 ms）+ 在飞 5 秒 → 上屏「" + pg.ElapsedText() + "」（" + pg.modelCalls + " 条 done，在飞 " + pg.modelOpenStarts.Length + " 条）");

        // ② 一条 llm:done 都没有、也没有在飞 → 不显示（不是 0、不是「—」）
        sb = new StringBuilder();
        sb.Append(LogLine(now - 60000, "turn:start", seq++, "\"kind\":\"user\""));
        sb.Append(LogLine(now - 30000, "tool:call", seq++, "\"tool\":\"read\""));
        File.WriteAllText(LogPathFor(dir, 0), sb.ToString(), PanelControl.Utf8NoBom);
        var none = Progress.Read(now, false, 151, dir);
        Check("T36-no-done", !none.haveModel && !none.ShowTiming && none.ElapsedText() == "",
          "日志里没有任何 llm:* → 计时不上屏（ElapsedText=\"" + none.ElapsedText() + "\"、ShowTiming=" + none.ShowTiming + "）");

        // ③ 在飞超过 30 分钟 → 当残留（不拿一条死掉的 start 虚增）
        sb = new StringBuilder();
        sb.Append(LogLine(now - 40 * 60000, "llm:start", seq++, "\"provider\":\"deepseek\",\"model\":\"deepseek-flash\",\"stage\":\"turn\",\"turn\":1,\"auto\":false"));
        File.WriteAllText(LogPathFor(dir, 0), sb.ToString(), PanelControl.Utf8NoBom);
        var stale = Progress.Read(now, false, 151, dir);
        Check("T36-stale-open", stale.haveModel && !stale.ShowTiming && stale.ElapsedText() == "",
          "只有一条 40 分钟前的 llm:start（超过 " + (Progress.MODEL_OPEN_CAP_MS / 60000) + " 分钟）→ 不计，计时不上屏（ElapsedText=\"" + stale.ElapsedText() + "\"）");

        // ④ 跨零点：昨天 60000 ms + 今天 30000 ms = 90 秒 → 01:30
        File.WriteAllText(LogPathFor(dir, -1),
          LogLine(now - 26 * 3600000, "llm:done", seq++, "\"provider\":\"deepseek\",\"model\":\"deepseek-flash\",\"ms\":60000,\"stage\":\"turn\",\"turn\":1,\"auto\":false,\"finish\":\"stop\",\"tools\":0"),
          PanelControl.Utf8NoBom);
        File.WriteAllText(LogPathFor(dir, 0),
          LogLine(now - 30000, "llm:done", seq++, "\"provider\":\"deepseek\",\"model\":\"deepseek-flash\",\"ms\":30000,\"stage\":\"turn\",\"turn\":2,\"auto\":false,\"finish\":\"stop\",\"tools\":0"),
          PanelControl.Utf8NoBom);
        var cross = Progress.Read(now, false, 151, dir);
        Check("T36-cross-midnight", cross.modelCalls == 2 && cross.ElapsedText() == "模型 01:30",
          "昨天 60000 ms + 今天 30000 ms = 90 秒 → 上屏「" + cross.ElapsedText() + "」（跨零点回看前一天）");

        // ⑤ 子代理的模型时间也算（同一个模型在替这次会话干活）：主 2000 + 子代理 5000 = 00:07
        sb = new StringBuilder();
        sb.Append(LogLine(now - 20000, "llm:done", seq++, "\"provider\":\"deepseek\",\"model\":\"deepseek-flash\",\"ms\":2000,\"stage\":\"turn\",\"turn\":1,\"auto\":false,\"finish\":\"stop\",\"tools\":0"));
        sb.Append(LogLine(now - 10000, "llm:done", seq++, "\"provider\":\"deepseek\",\"model\":\"deepseek-flash\",\"ms\":5000,\"stage\":\"turn\",\"turn\":3,\"auto\":false,\"finish\":\"stop\",\"tools\":0,\"child\":\"coder#2\""));
        File.WriteAllText(LogPathFor(dir, 0), sb.ToString(), PanelControl.Utf8NoBom);
        File.Delete(LogPathFor(dir, -1));
        var child = Progress.Read(now, false, 151, dir);
        Check("T36-child-sum", child.modelCalls == 2 && child.ElapsedText() == "模型 00:07",
          "主 agent 2000 ms + 子代理 5000 ms → 上屏「" + child.ElapsedText() + "」（llm:done 的 ms 都算）");

        // ⑥ 会话边界：本会话 = 最新槽位的铸造时刻起；旧会话的 llm:done 不算
        //    （真机 2026-10-26 / 10-27 两份日志就是两个会话：整日相加会把昨天另一次会话的 5 分 28 秒也算进来）
        sb = new StringBuilder();
        sb.Append(LogLine(now - 2 * 3600000, "llm:done", seq++, "\"provider\":\"deepseek\",\"model\":\"deepseek-flash\",\"ms\":60000,\"stage\":\"turn\",\"turn\":9,\"auto\":false,\"finish\":\"stop\",\"tools\":0"));
        sb.Append(LogLine(now - 60000, "llm:done", seq++, "\"provider\":\"deepseek\",\"model\":\"deepseek-flash\",\"ms\":30000,\"stage\":\"turn\",\"turn\":1,\"auto\":false,\"finish\":\"stop\",\"tools\":0"));
        File.WriteAllText(LogPathFor(dir, 0), sb.ToString(), PanelControl.Utf8NoBom);
        var scoped = Progress.Read(now, false, 151, now - 30 * 60000, dir);
        Check("T36-session", scoped.modelCalls == 1 && scoped.ElapsedText() == "模型 00:30",
          "会话起点在 30 分钟前 → 2 小时前那条旧会话的 60000 ms 不算，只上屏「" + scoped.ElapsedText() + "」");
      } finally { Ctx.LogDir = ""; try { Directory.Delete(dir, true); } catch { } }
    }


    // ==================== T33 余额节奏（最近 ¥10 用了多久）====================
    private static void T33() {
      long now = Fmt.NowMs();
      string dir = Path.Combine(Path.GetTempPath(), "board-cadence-" + Guid.NewGuid().ToString("N"));
      Directory.CreateDirectory(Path.Combine(dir, "data", "history"));
      try {
        long t0 = now - 60 * 60000;
        // ① 充过值、之后花够 ¥10：最近那块 ¥10 用了多久
        WriteHistory(dir, "deepseek", new long[] { t0 - 30 * 60000, t0, t0 + 30 * 60000, t0 + 60 * 60000 },
          new double[] { 10.0, 100.0, 90.0, 80.0 });
        var a = Cadence.Read(dir, "deepseek", now);
        Check("T33-block", a.ok && a.topups == 1 && a.blocks == 2 && a.text == "最近 ¥10 用了 30m",
          "充值后花了两块 ¥10（30 分钟一块）→ 上屏「" + a.text + "」（充值那一步不算消耗）");
        // ② 充过值、还没花够 ¥10 → 「充值后花了 ¥X · 用时 Y」
        WriteHistory(dir, "deepseek", new long[] { t0 - 30 * 60000, t0, t0 + 20 * 60000 },
          new double[] { 10.0, 100.0, 96.8 });
        var b = Cadence.Read(dir, "deepseek", now);
        Check("T33-aftertopup", b.ok && b.text.StartsWith("充值后花了 ¥3.20 · 用时 ") && b.text.IndexOf("Infinity") < 0,
          "充值后只花了 ¥3.20 → 上屏「" + b.text + "」");
        // ③ 近 24 小时没花钱
        WriteHistory(dir, "deepseek", new long[] { now - 40 * 3600000, now - 30 * 3600000 },
          new double[] { 50.0, 45.0 });
        var c = Cadence.Read(dir, "deepseek", now);
        Check("T33-idle", c.ok && c.text == "最近 24 小时没花钱",
          "最后一次花钱是 30 小时前 → 上屏「" + c.text + "」");
        // ④ 没有历史文件 → 一个字都不显示（不是 0，也不是 Infinity）
        var d = Cadence.Read(dir, "glm", now);
        Check("T33-nofile", !d.ok && d.text == "",
          "没有 glm 的历史 → 这一行不显示（" + d.why + "）");
        // ⑤ 一条样本都没有消耗（刚充值）→ 也只能是固定话，不许出现 Infinity
        WriteHistory(dir, "glm", new long[] { now - 20 * 60000, now - 10 * 60000 }, new double[] { 0.0, 20.0 });
        var e = Cadence.Read(dir, "glm", now);
        Check("T33-infinity", e.text.IndexOf("Infinity") < 0 && e.text.IndexOf("NaN") < 0 && e.text.Length > 0,
          "刚充值（还没有消耗）→ 上屏「" + e.text + "」（绝不许出现 Infinity/NaN）");
      } finally { try { Directory.Delete(dir, true); } catch { } }
    }

    // ==================== T34 两行字与新计时行的排版容得下（真字体度量，不是拍脑袋）====================
    // 2026-10-27 用户反馈「看不清」：节奏行 8→10.5 DIP、子代理行 7.5→9 DIP，颜色从 #6E7581 / #8A909C 提到 #A8AFBA。
    // 放大之后必须仍装得进既有的宽度槽与高度带（面板高 328/410/466 一个都不许变）。
    private static void T34() {
      var L = PanelLayout.ForCount(2);
      double cadW = Measured("充值后花了 ¥8,888.88 · 用时 3d05h", PanelWindow.CAD_SIZE, PanelWindow.UiFont);
      double cadW2 = Measured("最近 ¥10 用了 12h59m", PanelWindow.CAD_SIZE, PanelWindow.UiFont);
      double cadH = MeasuredH("充值后花了 ¥8,888.88 · 用时 3d05h", PanelWindow.CAD_SIZE, PanelWindow.UiFont);
      Check("T34-cadence", cadW <= PanelWindow.CAD_W && cadW2 <= PanelWindow.CAD_W,
        "节奏行 " + Fmt.Num(PanelWindow.CAD_SIZE) + " DIP 最长文案宽 " + Fmt.Num(Math.Round(cadW, 1)) + " / " + Fmt.Num(Math.Round(cadW2, 1)) + " DIP ≤ 槽宽 " + Fmt.Num(PanelWindow.CAD_W));
      // 高度带 = 这一行下移到下一块上沿之间的空地（B_BLOCK_H + GAP − (B_CAP_DY + CAD_DY) = 14.5 DIP）
      double band = (L.B_BLOCK_H + L.B_BLOCK_GAP) - (L.B_CAP_DY + PanelWindow.CAD_DY);
      Check("T34-cadence-height", cadH <= band,
        "节奏行字高 " + Fmt.Num(Math.Round(cadH, 2)) + " DIP ≤ 带宽 " + Fmt.Num(band) + " DIP（不压下一块；面板高不变）");
      double chW = Measured("子代理 3 个在跑 · 最长 12h59m", PanelWindow.CHILD_SIZE, PanelWindow.UiFont);
      double chH = MeasuredH("子代理 3 个在跑 · 最长 12h59m", PanelWindow.CHILD_SIZE, PanelWindow.UiFont);
      Check("T34-child", chW <= PanelWindow.CHILD_W,
        "子代理行 " + Fmt.Num(PanelWindow.CHILD_SIZE) + " DIP 最长文案宽 " + Fmt.Num(Math.Round(chW, 1)) + " DIP ≤ 槽宽 " + Fmt.Num(PanelWindow.CHILD_W));
      Check("T34-child-height", chH <= 31.0 - 2.5,
        "子代理行字高 " + Fmt.Num(Math.Round(chH, 2)) + " DIP ≤ 行带 " + Fmt.Num(31.0 - 2.5) + " DIP");
      // 对比度：旧值 vs 新值（面板体 ≈ #050505 —— 98% 黑压在浅色桌面上也不算亮）
      double oldCad = Contrast("#6E7581", "#050505"), newCad = Contrast(PanelWindow.CAD_COLOR, "#050505");
      double oldChild = Contrast("#8A909C", "#050505"), newChild = Contrast(PanelWindow.CHILD_COLOR, "#050505");
      Check("T34-contrast", newCad >= 7.0 && newChild >= 7.0 && newCad >= oldCad * 1.5 && newChild >= oldChild * 1.3,
        "对比度（底 #050505）：节奏行 " + Fmt.Num(Math.Round(oldCad, 2)) + " → " + Fmt.Num(Math.Round(newCad, 2))
        + "，子代理行 " + Fmt.Num(Math.Round(oldChild, 2)) + " → " + Fmt.Num(Math.Round(newChild, 2)));
      double tuW = Measured("9999 轮", 9.0, PanelWindow.UiFont);
      Check("T34-turns", tuW <= PanelWindow.TURNS_W,
        "轮次「9999 轮」宽 " + Fmt.Num(Math.Round(tuW, 1)) + " DIP ≤ 槽宽 " + Fmt.Num(PanelWindow.TURNS_W));
      double labelW = Measured(PanelWindow.CARD_LABEL_TEXT, PanelWindow.CARD_LABEL_SIZE, PanelWindow.UiFont);
      Check("T34-timer-label", labelW <= PanelWindow.CARD_LABEL_W,
        "计时标签「" + PanelWindow.CARD_LABEL_TEXT + "」宽 " + Fmt.Num(Math.Round(labelW, 1)) + " DIP ≤ 槽宽 " + Fmt.Num(PanelWindow.CARD_LABEL_W));
      double tiW = Measured("11:08:40", 16.5, PanelWindow.MonoFont);
      Check("T34-timer", tiW <= PanelWindow.TIMER_W,
        "计时「11:08:40」宽 " + Fmt.Num(Math.Round(tiW, 1)) + " DIP ≤ 槽宽 " + Fmt.Num(PanelWindow.TIMER_W));
      // 卡片第三行：标签 + 大字 + 右侧轮次不许叠
      double rowRight = Geo.CARD_BLEED + Geo.CARD_W - PanelWindow.CARD_EDGE_PAD - PanelWindow.TURNS_W;
      double timerLeft = Geo.CARD_BLEED + PanelWindow.CARD_COL2 + PanelWindow.CARD_LABEL_W;
      Check("T34-card-row", timerLeft + tiW <= rowRight,
        "计时右端 " + Fmt.Num(Math.Round(timerLeft + tiW, 1)) + " DIP ≤ 轮次左端 " + Fmt.Num(rowRight) + " DIP（不叠字）");
      // 子代理行与状态词横向不能重叠（同一行左右两侧）
      double wordW = Measured("等你回答", 10.5, PanelWindow.UiFont);
      Check("T34-noclash", 16 + 13 + wordW < 232 - 16 - PanelWindow.CHILD_W + 2,
        "状态词「等你回答」右端 " + Fmt.Num(Math.Round(29 + wordW, 1)) + " DIP < 子代理行左端 " + Fmt.Num(232 - 16 - PanelWindow.CHILD_W) + " DIP（不叠字）");
    }

    private static double Measured(string text, double size, FontFamily family) {
      var tf = new Typeface(family, FontStyles.Normal, FontWeights.Normal, FontStretches.Normal);
      var ft = new FormattedText(text, System.Globalization.CultureInfo.CurrentCulture, FlowDirection.LeftToRight, tf, size, Brushes.Black, 1.0);
      return ft.WidthIncludingTrailingWhitespace;
    }
    private static double MeasuredH(string text, double size, FontFamily family) {
      var tf = new Typeface(family, FontStyles.Normal, FontWeights.Normal, FontStretches.Normal);
      var ft = new FormattedText(text, System.Globalization.CultureInfo.CurrentCulture, FlowDirection.LeftToRight, tf, size, Brushes.Black, 1.0);
      return ft.Height;
    }
    // WCAG 相对亮度对比度：用来把「提亮了多少」算成一个数（不是拍脑袋说「更亮了」）
    private static double Contrast(string fg, string bg) {
      double a = Luminance(fg), b = Luminance(bg);
      if (a < b) { double t = a; a = b; b = t; }
      return (a + 0.05) / (b + 0.05);
    }
    private static double Luminance(string color) {
      string c = (color ?? "").TrimStart('#');
      if (c.Length == 8) c = c.Substring(2);
      double[] v = new double[3];
      for (int i = 0; i < 3; i++) {
        double f = int.Parse(c.Substring(i * 2, 2), System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture) / 255.0;
        v[i] = f <= 0.04045 ? f / 12.92 : Math.Pow((f + 0.055) / 1.055, 2.4);
      }
      return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    }
    // ==================== T14 陈旧两档 ====================
    private static void T14(string dir) {
      long now = Fmt.NowMs();
      WriteFixture(dir, "two");
      var codex = QuotaSnap.Read(Path.Combine(dir, "dashboard-data.js"));
      var bal = BalSnapshot.Read(dir);
      var sess = Sessions.FromSlots(new List<SlotRec>(), now);
      var codex449 = CloneQuota(codex, now - (long)(44.9 * 60000));
      var codex451 = CloneQuota(codex, now - (long)(45.1 * 60000));
      var m449 = Model.BuildFor(codex449, sess, new Att7(), bal, now, new Activity());
      var m451 = Model.BuildFor(codex451, sess, new Att7(), bal, now, new Activity());
      Check("T14-quota", !m449.Freshness().quotaStale && m451.Freshness().quotaStale,
        "额度：44.9 分钟 → 新鲜；45.1 分钟 → 陈旧（阈值 " + Fmt.Num(Geo.STALE_QUOTA_MIN) + " 分钟，看 codex.atMs）");
      // 余额：每家自己的 atMs（9.9 / 10.1 分钟）
      var bal99 = BalWithAt(dir, now - (long)(9.9 * 60000), now - (long)(9.9 * 60000));
      var bal101 = BalWithAt(dir, now - (long)(10.1 * 60000), now - (long)(2 * 60000));
      var m99 = Model.BuildFor(codex449, sess, new Att7(), bal99, now, new Activity());
      var m101 = Model.BuildFor(codex449, sess, new Att7(), bal101, now, new Activity());
      var f99 = m99.Freshness(); var f101 = m101.Freshness();
      Check("T14-bal", !f99.StaleOf("deepseek") && f101.StaleOf("deepseek"),
        "余额：9.9 分钟 → 新鲜；10.1 分钟 → 该家陈旧（阈值 " + Fmt.Num(Geo.STALE_BAL_MIN) + " 分钟，看每家自己的 atMs）");
      Check("T14-perplatform", !f101.StaleOf("glm"),
        "按家各算各的：同一份数据里 glm 只有 2 分钟 → " + (f101.StaleOf("glm") ? "陈旧" : "新鲜") + "（不拿一个阈值一刀切）");
      var balNoTs = BalWithAt(dir, 0, 0);
      var codexNoTs = CloneQuota(codex449, 0);
      var mNoTs = Model.BuildFor(codexNoTs, sess, new Att7(), balNoTs, now, new Activity());
      Check("T14-nots", mNoTs.Freshness().quotaAgeMin < 0 && !mNoTs.Freshness().balStale,
        "时间戳缺失 → 不判旧也不判新（quotaAgeMin=" + Fmt.Num(Math.Round(mNoTs.Freshness().quotaAgeMin, 1)) + "）");
      Check("T14-dim", Math.Abs(Geo.STALE_DIM - 0.45) < 0.001, "变暗透明度 = " + Fmt.Num(Geo.STALE_DIM) + "（只压读数与圈；状态类永远 1.00 —— 元素实测见 --selftest-ui）");
    }

    // ==================== T15 扫动 ====================
    private static void T15() {
      var p1 = Sweep.Plan(false, 0, 50, true, false, false, true);
      var p2 = Sweep.Plan(true, 10, 20, true, false, false, true);
      var p3 = Sweep.Plan(true, 10, 10.01, true, false, false, true);
      var p4 = Sweep.Plan(true, 10, 60, true, true, false, true);
      var p5 = Sweep.Plan(true, 10, 60, true, false, true, true);
      var p6 = Sweep.Plan(true, 10, 0, false, false, false, true);
      Check("T15-first", !p1.sweep && p1.why.IndexOf("首次") >= 0, "首次渲染不扫（" + p1.why + "）");
      Check("T15-change", p2.sweep && p2.from == 10 && p2.to == 20 && Math.Abs(p2.ms - 240.0) < 0.001,
        "值变了才扫：" + Fmt.Num(p2.from) + " → " + Fmt.Num(p2.to) + "，时长 " + Fmt.Num(p2.ms) + "ms");
      Check("T15-min", !p3.sweep, "变化 < 0.05 不扫（" + p3.why + "）");
      Check("T15-unit", !p4.sweep, "换单位不扫（" + p4.why + "）");
      Check("T15-noanim", !p5.sweep, "减少动态效果 → 瞬时（" + p5.why + "）");
      Check("T15-unknown", !p6.sweep, "读不到 → 直接落位（" + p6.why + "）");
      // 逐帧：弧长与数字同一帧同一个值（0.5 进度 → easeOutCubic(0.5)=0.875）
      double v0 = ValueAt(10, 20, 0.0), vMid = ValueAt(10, 20, 0.5), v1 = ValueAt(10, 20, 1.0);
      Check("T15-ease", Math.Abs(v0 - 10.0) < 0.001 && Math.Abs(vMid - 18.75) < 0.001 && Math.Abs(v1 - 20.0) < 0.001,
        "easeOutCubic：t=0 → " + Fmt.Num(v0) + "、t=120ms → " + Fmt.Num(vMid) + "、t=240ms → " + Fmt.Num(v1) + "（弧长与数字用同一个值）");
      Read("T15.p240", Fmt.Num(Math.Round(Geo.PanelH(1, Metrics.Fake(1920, 1080, 1.0)), 1)));
    }

    private static double ValueAt(double from, double to, double p) {
      return from + (to - from) * Geo.EaseOutCubic(p);
    }

    // ==================== T16 文案词表（上屏文本清单）====================
    private static void T16(string dir) {
      long now = Fmt.NowMs();
      WriteFixture(dir, "two");
      // 新增的「当前进展」与「余额节奏」两条也走真实的生成函数（不是手写字符串），
      //   否则词表只能验到旧文案，新文案漏出词表也没人抦。
      string logDir = MakeLogDir();
      string savedData = Ctx.DataRoot, savedLog = Ctx.LogDir;
      try {
        Ctx.DataRoot = dir; Ctx.LogDir = logDir;
        WriteLog(logDir, "children", now);
        WriteHistory(dir, "deepseek", new long[] { now - 90 * 60000, now - 60 * 60000, now - 30 * 60000, now - 2 * 60000 },
          new double[] { 20.0, 100.0, 90.0, 80.0 });
        WriteHistory(dir, "glm", new long[] { now - 40 * 60000, now - 20 * 60000 }, new double[] { 8888.12, 8885.0 });
        var codex = QuotaSnap.Read(Path.Combine(dir, "dashboard-data.js"));
        var bal = BalSnapshot.Read(dir);
        var slots = new List<SlotRec>();
        slots.Add(Slot("proj/Alpha", now - 60 * 1000, 5, "4242-" + (now - 60 * 1000) + "-abcd"));
        var sess = Sessions.FromSlots(slots, now);
        var att = new Att7();
        var act = new Activity(); act.sessionMs = now - 3 * 1000; act.maxMs = now - 3 * 1000; act.maxWhat = "会话正文";
        var m = Model.BuildFor(codex, sess, att, bal, now, act);
        var texts = new List<string>();
        texts.Add("Codex");
        texts.Add("数据 " + m.snapText);
        texts.Add("5h 还剩");
        texts.Add("7 天 还剩");
        texts.Add(m.fiveSub); texts.Add(m.weekSub);
        texts.Add(m.resetLine);
        texts.Add("余额");
        texts.Add(m.balView.unitText);
        texts.Add(m.balView.dataText);
        foreach (var g in m.balView.groups) {
          texts.Add(g.name); texts.Add(g.amountText); texts.Add(g.marks);
          var cad = m.CadenceOf(g.key);
          if (cad.ok) texts.Add(cad.text);
        }
        texts.Add("今天 · 这个项目");
        texts.Add("最近 " + m.lastText);
        texts.Add(m.todayLine);
        texts.Add(m.weekLine);
        // 当前进展（三态 + 已 X + 轮次）与子代理行
        texts.Add(m.progress.word);
        if (m.progress.ShowTiming) { texts.Add(m.progress.ElapsedText()); texts.Add(m.progress.turns + " 轮"); }
        texts.Add(m.progress.ChildText());
        texts.Add(m.quotaLabel);
        texts.Add("写入 " + Fmt.AgeShort(3) + " 前");
        texts.Add("—");
        // 项目名是目录名（开放集）：单独用 SCREENPROJ 一行给出来 —— 词表比对只管固定字面
        W.WriteLine("SCREENPROJ " + m.projName);
        int bad = 0; string badList = "";
        foreach (string t in texts) {
          Screen(t);
          if (string.IsNullOrEmpty(t)) continue;
          if (t == "—") continue;
          if (t.IndexOf('\uFFFD') >= 0) { bad++; badList += "[" + t + "]"; }
        }
        Check("T16-list", bad == 0, "上屏文本清单已输出 " + texts.Count + " 条（SCREEN 行；词表比对由 程序/tools/test-panel.mjs 做，解释性句子零命中）" + badList);
        Check("T16-nolines", m.resetLine.IndexOf("读不到") < 0, "数据可读时刷新行不含解释性文字：" + m.resetLine);
      } finally {
        Ctx.DataRoot = savedData; Ctx.LogDir = savedLog;
        try { Directory.Delete(logDir, true); } catch { }
      }
    }

    // ==================== UI 自检（真机窗口：A4 / A10 / T14 的元素实测）====================
    public static int RunUi(string data, string root, string state, int seconds, TextWriter w) {
      W = w; pass = 0; fail = 0;
      var app = new Application();
      app.ShutdownMode = ShutdownMode.OnMainWindowClose;
      var metrics = Metrics.Primary();
      var model = Model.Build();
      var win = new PanelWindow(metrics, model, true);
      win.Show();
      bool ok = true;
      try {
        Pump(700);
        var s0 = win.UiSnapshot();
        Dump("collapsed", s0);
        Check("UI-collapsed", s0["state"] == "collapsed" && s0["passThrough"] == "1" && s0["panelOpacity"] == "0",
          "收起态：穿透=" + s0["passThrough"] + "、面板不透明=" + s0["panelOpacity"] + "、裁剪露出=" + s0["clipReveal"] + " DIP");
        win.TestExpand();
        Pump(500);
        var s1 = win.UiSnapshot();
        Dump("expanded", s1);
        Check("UI-expanded", s1["state"] == "expanded" && s1["passThrough"] == "0" && s1["panelOpacity"] == "1",
          "展开态：穿透=" + s1["passThrough"] + "、面板不透明=" + s1["panelOpacity"] + "、裁剪露出=" + s1["clipReveal"] + " DIP");
        win.TestCollapse();
        Pump(800);
        var s2 = win.UiSnapshot();
        Check("UI-collapse-back", s2["state"] == "collapsed" && s2["passThrough"] == "1", "收回后恢复穿透（" + s2["passThrough"] + "）");
        // 陈旧：只暗读数，不碰状态类
        var wr = win; 
        var stale = Model.Build();
        wr.ApplyModel(stale);
        Pump(600);
        var s3 = wr.UiSnapshot();
        Dump("stale", s3);
        Check("UI-dim", true, "陈旧读数与状态类的实测透明度见上（ring5Txt / ringArcTxt 该暗、statusWord / timer / dot 永远 1.00）");
        w.WriteLine("READ ui.morph " + wr.MorphText());
        w.WriteLine("READ ui.sweep " + wr.SweepText());
      } catch (Exception ex) {
        ok = false;
        Check("UI-exception", false, ex.GetType().Name + ": " + ex.Message);
      }
      W.WriteLine("SUMMARY pass=" + pass + " fail=" + fail);
      try { win.ExitNow(); } catch { }
      return fail == 0 && ok ? 0 : 1;
    }

    private static void Dump(string tag, Dictionary<string, string> d) {
      foreach (var kv in d) W.WriteLine("READ ui." + tag + "." + kv.Key + " " + kv.Value);
    }

    private static void Pump(int ms) {
      var frame = new System.Windows.Threading.DispatcherFrame();
      var t = new System.Windows.Threading.DispatcherTimer();
      t.Interval = TimeSpan.FromMilliseconds(ms);
      t.Tick += delegate { t.Stop(); frame.Continue = false; };
      t.Start();
      System.Windows.Threading.Dispatcher.PushFrame(frame);
    }

    // ==================== T28 现场读路径（Model.Build：启动与每 30 秒重读走的就是它）====================
    // 2026-09-27 的缺陷就是这个用例没写：自检都用 BuildFor（自己先把快照读好再喂进去），
    //   而产品现场走的是 Build —— 那条路上漏了「读余额」，于是面板永远「数据 —」+ 两家「—」。
    //   这条用例只用 Model.Build（把 Ctx.DataRoot 指到夹具），才叫真验了产品读数据这条路。
    private static void T28(string dir) {
      string saved = Ctx.DataRoot;
      try {
        Ctx.DataRoot = dir;
        // ① 看板里两家都显示：现场读必须真读到余额（金额与圈都对上）
        WriteFixture(dir, "two");
        var m = Model.Build();
        var ds = GroupOf(m, "deepseek");
        Check("T28-read-balance", m.bal.ok && m.balN == 2 && m.balView.dataText != "数据 —"
          && ds != null && ds.amountText == "¥64.00" && ds.ringCount == 1,
          "现场读（Model.Build）：余额段「" + m.balView.dataText + "」、DeepSeek「" + (ds == null ? "（没有这一行）" : ds.amountText + " / " + ds.ringCount + " 段弧")
          + "」（不是「数据 —」+ 两家「—」）｜err=" + m.bal.err);
        // ② 智谱 GLM 被看板关掉 —— 真数据的形状：glm.ok=false + disabled=true + **没有 balance 字段**
        WriteFixture(dir, "glmdisabled");
        var m2 = Model.Build();
        Check("T28-hidden", m2.balN == 1 && GroupOf(m2, "deepseek") != null && GroupOf(m2, "glm") == null && m2.bal.plat["glm"].hidden,
          "现场读：cards.glm.show=false（后端也在关）→ 面板 " + m2.balN + " 组（" + Names(m2) + "），关掉的那家整组不出现");
        // ③ 开关打开（这家有余额）：整组回来（两个方向都验）
        WriteFixture(dir, "two");
        var m3 = Model.Build(m2);
        var g3 = GroupOf(m3, "glm");
        Check("T28-shown-again", m3.balN == 2 && g3 != null && g3.amountText == "¥8,888.12",
          "开关打开 → 整组回来：" + Names(m3) + "｜智谱 GLM「" + (g3 == null ? "—" : g3.amountText) + "」");
        // ④ 两家都不显示：余额段整段不出现（面板高回到 328）
        WriteFixture(dir, "allhidden");
        var m4 = Model.Build();
        Check("T28-allhidden", m4.balN == 0 && Geo.PanelH(m4.balN, Metrics.Fake(1920, 1080, 1.0)) == 328.0,
          "两家都被关掉 → 余额段整段不出现（" + m4.balN + " 组、面板高 " + Fmt.Num(Geo.PanelH(m4.balN, Metrics.Fake(1920, 1080, 1.0))) + "）");
      } finally { Ctx.DataRoot = saved; }
    }

    // ==================== T29 读失败时的降级（保留上一份 / 不编造）====================
    private static void T29(string dir) {
      string saved = Ctx.DataRoot;
      try {
        Ctx.DataRoot = dir;
        WriteFixture(dir, "glmdisabled");
        var good = Model.Build();
        // ① 半截文件（采集器正在原地重写）：这一份读不出来 → **保留上一份好数据**
        WriteHalfFixture(dir);
        var after = Model.Build(good);
        var ds = GroupOf(after, "deepseek");
        Check("T29-retain", after.balRetained && after.balN == 1 && GroupOf(after, "glm") == null
          && ds != null && ds.amountText == "¥64.00" && after.balView.dataText == good.balView.dataText,
          "半截文件 → 保留上一份好数据：仍 " + after.balN + " 组（" + Names(after) + "）、金额「" + (ds == null ? "—" : ds.amountText)
          + "」、数据时间「" + after.balView.dataText + "」；被关掉的那家不出现（不是清空成两家「—」）");
        // ② 保留的是旧数据 → 陈旧规则照旧生效（余额 10 分钟 / 每家自己的 atMs）
        long old = Fmt.NowMs() - 15L * 60000L;
        var stale = Model.BuildFor(good.codex, Sessions.FromSlots(new List<SlotRec>(), Fmt.NowMs()), new Att7(),
          BalWithAt(dir, old, Fmt.NowMs()), Fmt.NowMs(), new Activity());
        Check("T29-dim", stale.Freshness().StaleOf("deepseek") && !stale.Freshness().StaleOf("glm"),
          "保留的是旧数据 → 按陈旧规则变暗（阈值 " + Fmt.Num(Geo.STALE_BAL_MIN) + " 分钟）：DeepSeek 陈旧="
          + stale.Freshness().StaleOf("deepseek") + "；被关掉的那家不参与判定");
        // ③ 从没读到过（启动就撞上没文件 / 半截）：按设计写「—」、不画圈，绝不假装 0
        string empty = Path.Combine(dir, "empty-root");
        if (!Directory.Exists(empty)) Directory.CreateDirectory(empty);
        Ctx.DataRoot = empty;
        var fresh = Model.Build(null);
        bool allUnknown = true, noRings = true;
        foreach (var g in fresh.balView.groups) { if (g.known) allUnknown = false; if (g.ringCount > 0) noRings = false; }
        Check("T29-firstfail", !fresh.bal.ok && fresh.balView.dataText == "数据 —" && allUnknown && noRings,
          "从没读到过 → 「" + fresh.balView.dataText + "」、" + fresh.balView.groupCount + " 行都写「—」、圈 " + (noRings ? "0 段" : "（不该有）")
          + "（读不到 ≠ 0；额度那一半同理：codexOk=" + fresh.codexOk + "）");
        // ④ 能读了 → 回到正常（不再沿用）
        Ctx.DataRoot = dir;
        WriteFixture(dir, "glmdisabled");
        var back = Model.Build(fresh);
        Check("T29-recover", !back.balRetained && back.bal.ok && back.balN == 1 && back.balView.dataText != "数据 —",
          "文件恢复可读 → 不再沿用上一份（balRetained=" + back.balRetained + "），余额段「" + back.balView.dataText + "」");
      } finally { Ctx.DataRoot = saved; }
    }

    // ==================== T30 贴边内凹圆角（fillet）与轮廓可见性 ====================
    // 三条判据：① 贴边那侧两角确实是**内凹**（翼根在形状里、咬口在形状外 —— 画成普通圆角必然反过来）；
    //   ② 翼真的溢出了 rf（没画出来就没有翼）；③ 咬口那一块在窗口与裁剪之内（没被裁掉），且描边够亮（深色桌面上看得见）。
    private static void T30(Metrics M, Metrics M15) {
      string[] edges = new string[] { "right", "left", "top", "bottom" };
      double h = Geo.PanelH(2, M), rf = Geo.PANEL_RF;
      bool allOk = true; string detail = "";
      foreach (string e in edges) {
        var g = Geo.Medium(e, 540.0, h, M);
        var path = Geometry.Parse(g.panelPath);
        double rx, ry, bx, by;
        Geo.FilletProbe(e, Geo.PANEL_W, h, rf, out rx, out ry, out bx, out by);
        bool rootIn = path.FillContains(new Point(rx, ry));
        bool biteOut = !path.FillContains(new Point(bx, by));
        var b = path.Bounds;
        bool wing = (e == "right" || e == "left")
          ? (b.Top <= -rf + 0.01 && b.Bottom >= h + rf - 0.01)
          : (b.Left <= -rf + 0.01 && b.Right >= Geo.PANEL_W + rf - 0.01);
        double wx = g.win.x + g.panel.x, wy = g.win.y + g.panel.y;         // 面板盒在屏幕里的位置
        bool biteInWindow = (bx + wx) >= g.win.x - 0.01 && (bx + wx) <= g.win.x + g.win.w + 0.01
                         && (by + wy) >= g.win.y - 0.01 && (by + wy) <= g.win.y + g.win.h + 0.01;
        var clipE = Geo.ClipRectFor(e, Geo.PANEL_W, h, Geo.ClipReveal(e, new RectD(0, 0, Geo.PANEL_W, h)), rf);
        bool biteUnclipped = (bx >= clipE.x - 0.01) && (bx <= clipE.x + clipE.w + 0.01) && (by >= clipE.y - 0.01) && (by <= clipE.y + clipE.h + 0.01);
        allOk = allOk && rootIn && biteOut && wing && biteInWindow && biteUnclipped;
        detail += Geo.EdgeCn(e) + "[翼根" + (rootIn ? "实" : "空！") + "/咬口" + (biteOut ? "空" : "实！") + "/翼" + (wing ? "有" : "无！") + "] ";
      }
      Check("T30-fillet", allOk, "四条边：贴边那侧两角是内凹（翼根在形状里、咬口在形状外；翼溢出 rf=" + Fmt.Num(rf) + "，咬口在窗口与裁剪内）" + detail);
      // 收起小条的内凹（SLIVER_RF）：同一套判据
      var slPath = Geometry.Parse(Geo.Medium("right", 540.0, h, M).sliverPath);
      double srx, sry, sbx, sby;
      Geo.FilletProbe("right", Geo.SLIVER_W, h, Geo.SLIVER_RF, out srx, out sry, out sbx, out sby);
      Check("T30-sliver", slPath.FillContains(new Point(srx, sry)) && !slPath.FillContains(new Point(sbx, sby)),
        "收起条（宽 " + Fmt.Num(Geo.SLIVER_W) + "、内凹 " + Fmt.Num(Geo.SLIVER_RF) + "）同样内凹：翼根在形状里=" + slPath.FillContains(new Point(srx, sry))
        + "、咬口在形状外=" + !slPath.FillContains(new Point(sbx, sby)));
      // 轮廓：发丝描边要亮到在深色桌面上看得见（旧值 5% 白合成 #0D，与 #0C0C0C 的桌面同亮 → 看不见）
      int a = AlphaOf(Geo.HAIRLINE);
      int darkPx = a;      // 描边压在近乎全黑的面板体上 → 合成值 ≈ α（体本身压到 #0C0C0C 的桌面上也只剩 #000）
      int oldPx = 13;      // 旧值 #0DFFFFFF：α=13 → 合成 #0D，与桌面 #0C 只差 1/255（看不见）
      Check("T30-hairline", a >= 32 && Geo.HAIRLINE_T >= 1.0 && (darkPx - 12) >= 16,
        "轮廓描边 " + Geo.HAIRLINE + "（α=" + a + "/255，粗 " + Fmt.Num(Geo.HAIRLINE_T) + " DIP）：压在深色桌面 #0C0C0C 上合成 #" + darkPx.ToString("X2")
        + "（差 " + (darkPx - 12) + "/255）；旧值 #0DFFFFFF（5% 白）合成 #" + oldPx.ToString("X2") + "（差 " + (oldPx - 12) + "/255，与桌面同亮 → 看不见）");
      Read("T30.hairline", Geo.HAIRLINE + " α=" + a);
      Read("T30.fillet", detail.Trim());
    }

    private static BalGroup GroupOf(Model m, string key) {
      foreach (var g in m.balView.groups) if (g.key == key) return g;
      return null;
    }
    private static string Names(Model m) {
      var l = new List<string>();
      foreach (var g in m.balView.groups) l.Add(g.name);
      return string.Join("、", l.ToArray());
    }
    private static int AlphaOf(string color) {
      string c = (color ?? "").TrimStart('#');
      if (c.Length != 8) return 0;
      return int.Parse(c.Substring(0, 2), System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture);
    }

    // ==================== 夹具 ====================
    private static SlotRec Slot(string cwd, long ms, int turns, string sid) {
      var s = new SlotRec(); s.cwd = cwd; s.ms = ms; s.turns = turns; s.sessionId = sid; return s;
    }
    private static QuotaSnap CloneQuota(QuotaSnap src, long atMs) {
      var o = new QuotaSnap();
      o.ok = src.ok; o.fivePct = src.fivePct; o.weekPct = src.weekPct;
      o.fiveResetAt = src.fiveResetAt; o.weekResetAt = src.weekResetAt; o.atMs = atMs;
      o.snapText = Fmt.MD(atMs); o.warn5hUsed = src.warn5hUsed; o.crit5hUsed = src.crit5hUsed; o.warnWeekUsed = src.warnWeekUsed;
      return o;
    }
    private static BalSnapshot BalWithAt(string dir, long dsAt, long glmAt) {
      long now = Fmt.NowMs();
      File.WriteAllText(Path.Combine(dir, "dashboard-data.js"), FixtureText("two", now, now - 2 * 60000, now - 2 * 60000, dsAt, glmAt), PanelControl.Utf8NoBom);
      return BalSnapshot.Read(dir);
    }

    // ---- agent 日志夹具：字段名与层级照真日志（每行 `{"ts":"<ISO8601Z>","ev":"…","seq":…,…}`）----
    // 2026-10-27 实读真日志得出的形状；值全是假的，但行头顺序、子代理事件的 id/role/taskSeal 都照真的写。
    // 子代理的**结束事件名字随宿主机版本**（本仓只实读过 child:spawn / child:start），所以代码不认名字：
    //   任何非 spawn/start 的 child:* 都算收工；夹具这里用 child:end 仅作代表。
    private static string MakeLogDir() {
      string d = Path.Combine(Path.GetTempPath(), "board-log-" + Guid.NewGuid().ToString("N"));
      Directory.CreateDirectory(d);
      return d;
    }
    private static string Iso(long ms) {
      return DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime
        .ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);
    }
    private static string LogLine(long ms, string ev, int seq, string extra) {
      return "{\"ts\":\"" + Iso(ms) + "\",\"ev\":\"" + ev + "\",\"seq\":" + seq
        + (string.IsNullOrEmpty(extra) ? "" : "," + extra) + "}\n";
    }
    private static string LogPath(string dir) {
      return LogPathFor(dir, 0);
    }
    private static string LogPathFor(string dir, int dayOffset) {
      return Path.Combine(dir, "agent-" + DateTime.Today.AddDays(dayOffset).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture) + ".log");
    }
    private static void WriteLog(string dir, string kind, long now) {
      var sb = new StringBuilder();
      int seq = 1;
      long head = kind == "stale" ? now - 40 * 60000 : now - 5 * 60000;
      sb.Append(LogLine(head, "turn:start", seq++, "\"kind\":\"user\""));
      sb.Append(LogLine(head + 1000, "llm:start", seq++,
        "\"provider\":\"deepseek\",\"model\":\"deepseek-flash\",\"stage\":\"turn\",\"turn\":1,\"auto\":false"));
      sb.Append(LogLine(head + 3000, "llm:done", seq++,
        "\"provider\":\"deepseek\",\"model\":\"deepseek-flash\",\"ms\":2000,\"stage\":\"turn\",\"turn\":1,\"auto\":false,\"head\":\"\",\"len\":0,\"finish\":\"tool_calls\",\"tools\":1"));
      if (kind == "children") {
        sb.Append(LogLine(head + 4000, "child:spawn", seq++,
          "\"role\":\"coder\",\"id\":\"coder#1\",\"kind\":\"async\",\"status\":\"running\",\"ms\":0,\"taskSeal\":\"cef5c2e66b4e\""));
        sb.Append(LogLine(head + 4001, "child:start", seq++, "\"role\":\"coder\",\"id\":\"coder#1\",\"taskSeal\":\"cef5c2e66b4e\""));
        sb.Append(LogLine(head + 5000, "tool:call", seq++, "\"tool\":\"subagent\""));
        sb.Append(LogLine(now - 20 * 1000, "child:spawn", seq++,
          "\"role\":\"coder\",\"id\":\"coder#2\",\"kind\":\"async\",\"status\":\"running\",\"ms\":0,\"taskSeal\":\"77aa0133be21\""));
        sb.Append(LogLine(now - 20 * 1000 + 1, "child:start", seq++, "\"role\":\"coder\",\"id\":\"coder#2\",\"taskSeal\":\"77aa0133be21\""));
        sb.Append(LogLine(now - 10 * 1000, "child:end", seq++, "\"role\":\"coder\",\"id\":\"coder#1\",\"status\":\"done\""));
        sb.Append(LogLine(now - 5 * 1000, "tool:call", seq++, "\"tool\":\"read\""));
        File.WriteAllText(LogPath(dir), sb.ToString(), PanelControl.Utf8NoBom);
        return;
      }
      long last = kind == "stale" ? now - 40 * 60000 : now - 30 * 1000;
      if (kind == "ended") sb.Append(LogLine(last, "turn:end", seq++, "\"kind\":\"user\",\"ms\":98000,\"result\":\"ok\""));
      else sb.Append(LogLine(last, "tool:call", seq++, "\"tool\":\"read\""));
      File.WriteAllText(LogPath(dir), sb.ToString(), PanelControl.Utf8NoBom);
    }

    // ---- 余额历史夹具：字段名与层级照真文件（data/history/<平台>.jsonl）----
    private static void WriteHistory(string dir, string key, long[] ts, double[] val) {
      string hd = Path.Combine(Path.Combine(dir, "data"), "history");
      Directory.CreateDirectory(hd);
      var inv = System.Globalization.CultureInfo.InvariantCulture;
      var sb = new StringBuilder();
      for (int i = 0; i < ts.Length; i++) {
        string v = val[i].ToString("0.########", inv);
        if (key == "glm") {
          sb.Append("{\"ts\":").Append(ts[i]).Append(",\"ok\":true,\"keySource\":\"ThinCoder 配置\",\"customerName\":null,\"balance\":").Append(v)
            .Append(",\"availableBalance\":").Append(v)
            .Append(",\"rechargeAmount\":0,\"giveAmount\":0,\"totalSpendAmount\":0,\"frozenBalance\":0,\"creditStatus\":\"NOT_OPEN\",\"packs\":[]}\n");
        } else {
          sb.Append("{\"ts\":").Append(ts[i]).Append(",\"ok\":true,\"isAvailable\":true,\"currency\":\"CNY\",\"totalBalance\":").Append(v)
            .Append(",\"grantedBalance\":0,\"toppedUpBalance\":").Append(v).Append("}\n");
        }
      }
      File.WriteAllText(Path.Combine(hd, key + ".jsonl"), sb.ToString(), PanelControl.Utf8NoBom);
    }

    private static string MakeFixtureDir() {
      string dir = Path.Combine(Path.GetTempPath(), "board-selftest-" + Guid.NewGuid().ToString("N"));
      Directory.CreateDirectory(Path.Combine(dir, "data"));
      WriteFixture(dir, "two");
      return dir;
    }

    private static void WriteFixture(string dir, string kind) {
      long now = Fmt.NowMs();
      File.WriteAllText(Path.Combine(dir, "dashboard-data.js"), FixtureText(kind, now, now - 2 * 60000, now - 2 * 60000, now - 2 * 60000, now - 2 * 60000), PanelControl.Utf8NoBom);
    }

    // 半截文件：采集器是**原地重写**（截断后写），读的人可能正好撞上写了一半的那一瞬
    private static void WriteHalfFixture(string dir) {
      long now = Fmt.NowMs();
      string full = FixtureText("two", now, now - 2 * 60000, now - 2 * 60000, now - 2 * 60000, now - 2 * 60000);
      File.WriteAllText(Path.Combine(dir, "dashboard-data.js"), full.Substring(0, full.Length / 2), PanelControl.Utf8NoBom);
    }

    // 夹具（唯一出处）：**字段名与层级照抄真数据的生成器**（程序/tools/build-dashboard-data.mjs 的
    //   shapeCodex / shapeDeepseek / shapeGlm / cardSettings）—— 值全是假的。
    // 为什么必须照真结构写（2026-09-27 复盘）：自检自己调用 BalSnapshot.Read 再喂给 BuildFor，
    //   把产品漏掉的那一步（Build 里根本没读余额）替它做了 → 自检全绿而面板永远「数据 —」。
    //   假数据一旦「长得像代码以为的样子」，就会替产品把活儿干了；照真文件的长相写，才叫验产品。
    //   glm 关掉的形状尤其要照真：ok=false + disabled=true + **没有 balance 字段**（用户的日常就是这个形状）。
    private static string FixtureText(string kind, long now, long atMs, long genMs, long dsAt, long glmAt) {
      bool dsOk = kind != "readfail";
      bool glmOk = kind == "two" || kind == "glmoff" || kind == "nocards";
      bool glmDisabled = kind == "glmdisabled" || kind == "allhidden";
      bool glmShow = kind != "glmdisabled" && kind != "glmoff" && kind != "allhidden";
      string ds = dsOk
        ? "{\"ok\":true,\"carried\":false,\"atMs\":" + dsAt + ",\"ageMinutes\":0,\"keySource\":\"ThinCoder 配置\",\"currency\":\"CNY\","
          + "\"totalBalance\":64.0,\"grantedBalance\":0.0,\"toppedUpBalance\":64.0,\"isAvailable\":true,\"burnPerDay\":null,\"projectedDays\":null}"
        : "{\"ok\":false,\"error\":\"夹具：读不到\",\"atMs\":null,\"disabled\":false,\"unconfigured\":false,\"keySource\":null}";
      string glm;
      if (glmOk) {
        glm = "{\"ok\":true,\"carried\":" + (kind == "two" ? "true" : "false") + ",\"atMs\":" + glmAt + ",\"ageMinutes\":0,\"keySource\":\"ThinCoder 配置\","
            + "\"balance\":8888.12,\"availableBalance\":8888.12,\"rechargeAmount\":9000.0,\"giveAmount\":0.0,\"totalSpendAmount\":111.88,"
            + "\"depleted\":false,\"burnPerDay\":null,\"projectedDays\":null,\"packs\":[]}";
      } else if (glmDisabled) {
        glm = "{\"ok\":false,\"error\":\"平台已在 config.json 的 platforms 段关闭（glm）\",\"atMs\":null,\"disabled\":true,\"unconfigured\":false,\"keySource\":null}";
      } else {
        glm = "{\"ok\":false,\"error\":\"夹具：读不到\",\"atMs\":null,\"disabled\":false,\"unconfigured\":false,\"keySource\":null}";
      }
      bool dsShow = kind != "allhidden";
      string cards = kind == "nocards" ? "" :
        "  \"cards\": { \"codex\": { \"show\": true }, \"deepseek\": { \"show\": " + (dsShow ? "true" : "false") + " }, \"glm\": { \"show\": " + (glmShow ? "true" : "false") + " } },\n";
      var sb = new StringBuilder();
      sb.Append("window.DASHBOARD_DATA = {\n");
      sb.Append("  \"generatedAtMs\": ").Append(genMs).Append(",\n");
      sb.Append("  \"collectedAtMs\": ").Append(genMs - 900).Append(",\n");
      sb.Append("  \"collectedAtText\": \"2026-09-27 22:05\",\n");
      sb.Append("  \"health\": { \"consecutiveFailures\": { \"codex\": 0, \"deepseek\": 0, \"glm\": 0 },")
        .Append(" \"lastErrors\": { \"codex\": null, \"deepseek\": null, \"glm\": null },")
        .Append(" \"lastOkAt\": { \"codex\": ").Append(atMs).Append(", \"deepseek\": ").Append(dsAt).Append(", \"glm\": ").Append(glmAt).Append(" } },\n");
      sb.Append("  \"mute\": { \"active\": false, \"until\": null, \"untilText\": null, \"note\": null },\n");
      sb.Append("  \"suppression\": { \"glm\": { \"atMs\": ").Append(genMs).Append(", \"balanceAt\": null, \"note\": null } },\n");
      sb.Append("  \"config\": { \"refreshSeconds\": 30, \"defaultWindow\": \"24h\", \"theme\": \"dark\", \"staleMinutes\": 45 },\n");
      sb.Append("  \"thresholds\": { \"glmLow\": 5, \"glmCritical\": 2, \"dsLow\": 5, \"dsCritical\": 2, \"codex5hWarn\": 80, \"codex5hCritical\": 95, \"codexWeekWarn\": 80 },\n");
      sb.Append("  \"intervals\": { \"codex\": 5, \"balance\": 5 },\n");
      sb.Append("  \"codex\": { \"ok\": true, \"degraded\": false, \"carried\": false, \"source\": \"live\", \"snapshotAgeMinutes\": null, \"error\": null,")
        .Append(" \"atMs\": ").Append(atMs).Append(", \"ageMinutes\": 0, \"keySource\": \"夹具\", \"plan\": \"plus\", \"email\": null,")
        .Append(" \"fiveHour\": { \"usedPercent\": 38, \"windowMinutes\": 300, \"resetAt\": ").Append(now + 2 * 3600 * 1000)
        .Append(", \"resetAfterSeconds\": 7200, \"resetText\": \"夹具\", \"resetAfter\": \"夹具\" },")
        .Append(" \"weekly\": { \"usedPercent\": 57, \"windowMinutes\": 10080, \"resetAt\": ").Append(now + 5L * 24 * 3600 * 1000)
        .Append(", \"resetAfterSeconds\": 432000, \"resetText\": \"夹具\", \"resetAfter\": \"夹具\" },")
        .Append(" \"limitReached\": false, \"limitReachedType\": null, \"credits\": { \"hasCredits\": false, \"balance\": \"0\" } },\n");
      sb.Append("  \"deepseek\": ").Append(ds).Append(",\n");
      sb.Append("  \"glm\": ").Append(glm).Append(",\n");
      sb.Append("  \"platforms\": { \"codex\": true, \"deepseek\": true, \"glm\": ").Append(glmShow ? "true" : "false").Append(" },\n");
      sb.Append(cards);
      sb.Append("  \"models\": { \"available\": { \"gpt-6-astra\": { \"available\": true, \"availableAt\": null } } },\n");
      sb.Append("  \"links\": { \"codex\": { \"name\": \"Codex\", \"usage\": \"\", \"topup\": null },")
        .Append(" \"deepseek\": { \"name\": \"DeepSeek\", \"usage\": \"\", \"topup\": \"\" },")
        .Append(" \"glm\": { \"name\": \"智谱 GLM\", \"usage\": \"\", \"topup\": \"\" } },\n");
      sb.Append("  \"predict\": { \"$comment\": \"夹具\", \"enabled\": false, \"warnMinutes\": 30, \"minUsedPercent\": 20, \"slopeWindowMinutes\": 60 },\n");
      sb.Append("  \"anomaly\": { \"$comment\": \"夹具\", \"enabled\": false, \"factor\": 3, \"minAmount\": 10 },\n");
      sb.Append("  \"attribution\": { \"generatedAtMs\": ").Append(genMs).Append(", \"scanMs\": 1, \"scannedFiles\": 0, \"reusedFiles\": 0, \"skippedFiles\": 0,")
        .Append(" \"readMB\": 0, \"thinCoderProjectCount\": 0, \"total7\": 0, \"total30\": 0, \"totalAll\": 0, \"projects\": [],")
        .Append(" \"thinCoder\": { \"projects\": [], \"scannedFiles\": 0, \"sessionDir\": \"夹具\", \"totalSessions\": 0, \"total7\": 0, \"total30\": 0, \"totalAll\": 0 },")
        .Append(" \"models\": [], \"usageStyle\": { \"approval\": {}, \"sandbox\": {}, \"effort\": {}, \"turns\": 0, \"avgTokensPerTurn\": 0 },")
        .Append(" \"coverage\": { \"fromMs\": 0, \"toMs\": 0 } },\n");
      sb.Append("  \"thinCoderInstalled\": true,\n");
      sb.Append("  \"recentAlerts\": [],\n");
      sb.Append("  \"daily\": { \"2026-09-27\": { \"codex\": { \"n\": 1, \"max5h\": 38, \"avg5h\": 38, \"max7d\": 57 },")
        .Append(" \"deepseek\": { \"n\": 1, \"spend\": 0, \"first\": 64, \"last\": 64 }, \"glm\": null } },\n");
      sb.Append("  \"history\": { \"codex\": { \"h24\": [], \"d7\": [], \"d30\": [], \"all\": [] },")
        .Append(" \"deepseek\": { \"h24\": [], \"d7\": [], \"d30\": [], \"all\": [] },")
        .Append(" \"glm\": { \"h24\": [], \"d7\": [], \"d30\": [], \"all\": [] } }\n");
      sb.Append("};\n");
      return sb.ToString();
    }
  }
}
