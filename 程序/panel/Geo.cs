// 常驻悬浮看板 —— 几何与排版（唯一出处；数值全部照抄原型实测值，见设计档 2.2.3 / 2.2.12）
// 坐标：本节一律 DIP。与物理像素只在轮询 / 窗口 API 边界上换算（Metrics.scale）。
using System;

namespace Board {
  internal sealed class RectD {
    public double x, y, w, h;
    public RectD(double x, double y, double w, double h) { this.x = x; this.y = y; this.w = w; this.h = h; }
    public double Right { get { return x + w; } }
    public double Bottom { get { return y + h; } }
  }

  // 面板内容排版：每一段的 y 都从这里出来；面板高 = 最后一段 + 下留白
  internal sealed class PanelLayout {
    public double PAD = 16.0;
    public double Y_A_TITLE = 18.0;
    public double A_RING_CY = 74.0, A_RING_R = 21.0, A_RING_T = 4.5;
    public double A_COL1, A_COL2;
    public double A_TXT_DY = -8.0, A_LAB_DY = 29.0, A_SUB_DY = 44.0;
    public double Y_A_RESET = 142.0;
    public double Y_A_DIV = 168.0;
    public double B_RING_R = 8.5, B_RING_T = 3.5, B_RING_PITCH = 22.0, B_RING_H;
    public double Y_B_HEAD, Y_B_RINGS0;
    public double B_CAP_DY = 27.5;
    public double B_BLOCK_H = 44.0, B_BLOCK_GAP = 12.0;
    public double Y_B_END;
    public double Y_C_DIV, Y_C_HEAD, Y_C_PROJ, Y_C_TODAY, Y_C_WEEK;
    public double Y_D_DIV, Y_D_TEXT, H;

    public static PanelLayout ForCount(int balN) { return new PanelLayout(balN); }

    private PanelLayout(int balN) {
      A_COL1 = PAD + 50.0; A_COL2 = PAD + 150.0;
      B_RING_H = 2.0 * B_RING_R + B_RING_T;
      Y_B_HEAD = Y_A_DIV + 14.0;
      Y_B_RINGS0 = Y_B_HEAD + 24.0;
      if (balN > 0) Y_B_END = Y_B_RINGS0 + balN * B_BLOCK_H + (balN - 1) * B_BLOCK_GAP;
      else Y_B_END = Y_A_DIV;
      Y_C_DIV = Y_B_END + 16.0;
      Y_C_HEAD = Y_C_DIV + 14.0;
      Y_C_PROJ = Y_C_HEAD + 21.0;
      Y_C_TODAY = Y_C_PROJ + 22.0;
      Y_C_WEEK = Y_C_TODAY + 20.0;
      Y_D_DIV = Y_C_WEEK + 20.0;
      Y_D_TEXT = Y_D_DIV + 16.0;
      H = Y_D_TEXT + 31.0;
    }
  }

  internal sealed class MediumGeo {
    public string form = "medium", edge, state;
    public double anchor, panelH, scale;
    public RectD win, panel, sliver;
    public string panelPath, sliverPath;
    public string edgeCn, tieOrder;
  }

  internal sealed class MicroGeo {
    public string form = "micro";
    public double cardX, cardY, scale;
    public RectD card, win;
  }

  internal static class Geo {
    // 2026-11-03 方案 ①：卡片加高 90 → 100 DIP，换「Codex 5h」下面那行「下次重置 HH:MM」；宽度 228 不变。
    //   窗口矩形 = 卡片 + 出血 22×2（下面 Micro() 直接由这两个常量算出来，所以它跟着变成 272 × 144）。
    public const double CARD_W = 228.0, CARD_H = 100.0, CARD_R = 14.0, CARD_BLEED = 22.0;
    public const double CARD_RING_CX = 34.0, CARD_RING_CY = 27.0, CARD_RING_R = 19.0;
    public const double SLIVER_W = 8.0, SLIVER_R = 4.0, SLIVER_RF = 6.0;
    public const double PANEL_W = 232.0, PANEL_R = 16.0, PANEL_RF = 14.0;
    public const double PANEL_BLEED = 40.0;
    public const double FORM_DETACH_DIP = 36.0;   // 中型被拉离贴边超过它 → 拖动中当场变微型
    public const double FORM_DOCK_DIP = 64.0;     // 微型离最近那条边 ≤ 它 → 松手变成中型
    public const double FORM_HINT_DIP = 150.0;    // 反馈从这么远开始
    public const double FORM_HOT_W = 34.0;        // 收起态热区深度（比看得见的宽 4 倍）
    public const double FORM_HOT_PAD = 20.0, FORM_HOT_PAD_EXP = 10.0;
    public const double FORM_EXPAND_MS = 240.0, FORM_COLLAPSE_MS = 480.0;
    public const double FORM_FOLLOW_TAU = 8.0, FORM_FOLLOW_SNAP = 0.4;
    public const double FORM_MORPH_MS = 190.0, FORM_MORPH_SRC = 0.94, FORM_MORPH_DST = 0.96;
    public const double FORM_SNAP_MS = 150.0, FORM_RELAX_MS = 130.0;
    public const double FORM_FEED_SCALE = 0.05, FORM_FEED_FADE = 0.14, FORM_FEED_RF = 2.0;
    public const double RING_SWEEP_MS = 240.0, RING_SWEEP_MIN = 0.05;
    public const double STALE_QUOTA_MIN = 45.0, STALE_BAL_MIN = 10.0, STALE_DIM = 0.45;
    // 发丝描边（形状轮廓的唯一出处）：1 DIP、15% 白。
    // 2026-09-27 实测：面板体是 #FA000000（98% 黑），压到深色桌面上与桌面只差 5%（桌面 #0C0C0C vs 体 #000），
    //   而 5% 白的描边合成出来恰好也是 #0D —— 与桌面同亮 → 贴边之后轮廓（连同两角的内凹圆角）完全看不见。
    //   抬到 15%：深色桌面上描边 #262626 与桌面 #0C0C0C 差 26/255（看得见），浅色桌面上靠黑色体本身对比（描边不抢眼）。
    public const string HAIRLINE = "#26FFFFFF";
    public const double HAIRLINE_T = 1.0;
    public const int RUNNING_FRESH_SEC = 20;
    public static readonly string[] TIE_ORDER = new string[] { "right", "left", "top", "bottom" };
    public static string EdgeCn(string edge) {
      if (edge == "right") return "右缘";
      if (edge == "left") return "左缘";
      if (edge == "top") return "上缘";
      return "下缘";
    }

    // 面板高（唯一出处）：内容算出来后再取整到**物理像素**（边缘落在像素边界上 → 不糊）
    public static double PanelH(int balN, Metrics m) {
      double h = PanelLayout.ForCount(balN).H;
      if (m != null && m.scale > 0.0) h = Math.Round(h * m.scale) / m.scale;
      return h;
    }

    // 贴边胶囊轮廓：贴边那侧两角内凹（fillet，向屏幕外溢出 RF），对面两角凸圆角
    private static string N(double v) { return Fmt.Num(v); }

    public static string CapsulePath(double w, double h, string edge, double r, double rf) {
      if (edge == "right") {
        return "M " + N(r) + ",0 L " + N(w - rf) + ",0 A " + N(rf) + "," + N(rf) + " 0 0 0 " + N(w) + "," + N(-rf)
          + " L " + N(w) + "," + N(h + rf) + " A " + N(rf) + "," + N(rf) + " 0 0 0 " + N(w - rf) + "," + N(h)
          + " L " + N(r) + "," + N(h) + " A " + N(r) + "," + N(r) + " 0 0 1 0," + N(h - r)
          + " L 0," + N(r) + " A " + N(r) + "," + N(r) + " 0 0 1 " + N(r) + ",0 Z";
      }
      if (edge == "left") {
        return "M " + N(w - r) + ",0 L " + N(rf) + ",0 A " + N(rf) + "," + N(rf) + " 0 0 1 0," + N(-rf)
          + " L 0," + N(h + rf) + " A " + N(rf) + "," + N(rf) + " 0 0 1 " + N(rf) + "," + N(h)
          + " L " + N(w - r) + "," + N(h) + " A " + N(r) + "," + N(r) + " 0 0 0 " + N(w) + "," + N(h - r)
          + " L " + N(w) + "," + N(r) + " A " + N(r) + "," + N(r) + " 0 0 0 " + N(w - r) + ",0 Z";
      }
      if (edge == "top") {
        return "M " + N(-rf) + ",0 L " + N(w + rf) + ",0 A " + N(rf) + "," + N(rf) + " 0 0 0 " + N(w) + "," + N(rf)
          + " L " + N(w) + "," + N(h - r) + " A " + N(r) + "," + N(r) + " 0 0 1 " + N(w - r) + "," + N(h)
          + " L " + N(r) + "," + N(h) + " A " + N(r) + "," + N(r) + " 0 0 1 0," + N(h - r)
          + " L 0," + N(rf) + " A " + N(rf) + "," + N(rf) + " 0 0 0 " + N(-rf) + ",0 Z";
      }
      if (edge == "bottom") {
        return "M " + N(-rf) + "," + N(h) + " L " + N(w + rf) + "," + N(h) + " A " + N(rf) + "," + N(rf) + " 0 0 1 " + N(w) + "," + N(h - rf)
          + " L " + N(w) + "," + N(r) + " A " + N(r) + "," + N(r) + " 0 0 0 " + N(w - r) + ",0"
          + " L " + N(r) + ",0 A " + N(r) + "," + N(r) + " 0 0 0 0," + N(r)
          + " L 0," + N(h - rf) + " A " + N(rf) + "," + N(rf) + " 0 0 1 " + N(-rf) + "," + N(h) + " Z";
      }
      return "M " + N(r) + ",0 L " + N(w - r) + ",0 A " + N(r) + "," + N(r) + " 0 0 1 " + N(w) + "," + N(r)
        + " L " + N(w) + "," + N(h - r) + " A " + N(r) + "," + N(r) + " 0 0 1 " + N(w - r) + "," + N(h)
        + " L " + N(r) + "," + N(h) + " A " + N(r) + "," + N(r) + " 0 0 1 0," + N(h - r)
        + " L 0," + N(r) + " A " + N(r) + "," + N(r) + " 0 0 1 " + N(r) + ",0 Z";
    }

    // 中型（贴边胶囊）：窗口矩形 + 面板盒 / 小条盒在窗口内的位置 + 两态的贴边路径
    // 两态同高：小条的长边 = 面板沿边那一维（同一个数，代码里没有第二个高度常量）
    public static MediumGeo Medium(string edge, double anchor, double panelH, Metrics m) {
      double pb = PANEL_BLEED;
      var g = new MediumGeo();
      g.edge = edge; g.anchor = anchor; g.panelH = panelH; g.scale = m.scale;
      g.edgeCn = EdgeCn(edge);
      double along = panelH + 2.0 * pb;
      double w, h, left, top, panelX, panelY, slW, slH, slX, slY;
      if (edge == "right" || edge == "left") {
        w = PANEL_W + pb; h = along;
        top = anchor - h / 2.0;
        if (h <= m.dipH) { if (top < 0) top = 0.0; if (top + h > m.dipH) top = m.dipH - h; } else top = 0.0;
        left = 0.0;
        if (edge == "right") left = m.dipW - w;
        panelX = (edge == "right") ? pb : 0.0;
        panelY = pb;
        slW = SLIVER_W; slH = panelH;
        slX = (edge == "right") ? (w - SLIVER_W) : 0.0;
        slY = panelY + (panelH - slH) / 2.0;
      } else {
        w = PANEL_W + 2.0 * pb; h = panelH + pb;
        left = anchor - w / 2.0;
        if (w <= m.dipW) { if (left < 0) left = 0.0; if (left + w > m.dipW) left = m.dipW - w; } else left = 0.0;
        top = (edge == "bottom") ? (m.dipH - h) : 0.0;
        panelX = pb;
        panelY = (edge == "bottom") ? pb : 0.0;
        slW = PANEL_W; slH = SLIVER_W;
        slX = panelX;
        slY = (edge == "bottom") ? (h - SLIVER_W) : 0.0;
      }
      g.win = new RectD(Math.Round(left, 1), Math.Round(top, 1), w, h);
      g.panel = new RectD(panelX, panelY, PANEL_W, panelH);
      g.sliver = new RectD(slX, slY, slW, slH);
      g.panelPath = CapsulePath(PANEL_W, panelH, edge, PANEL_R, PANEL_RF);
      g.sliverPath = CapsulePath(slW, slH, edge, SLIVER_R, SLIVER_RF);
      return g;
    }

    // 微型（浮在桌面的卡片）：窗口矩形 + 卡片盒（卡片在窗口里居中，四周留出血）
    public static MicroGeo Micro(double cardX, double cardY, Metrics m) {
      double cx = cardX, cy = cardY;
      if (cx + CARD_W > m.dipW) cx = m.dipW - CARD_W;
      if (cy + CARD_H > m.dipH) cy = m.dipH - CARD_H;
      if (cx < 0) cx = 0.0;
      if (cy < 0) cy = 0.0;
      var g = new MicroGeo();
      g.cardX = cx; g.cardY = cy; g.scale = m.scale;
      g.card = new RectD(CARD_BLEED, CARD_BLEED, CARD_W, CARD_H);
      g.win = new RectD(Math.Round(cx - CARD_BLEED, 1), Math.Round(cy - CARD_BLEED, 1), CARD_W + 2.0 * CARD_BLEED, CARD_H + 2.0 * CARD_BLEED);
      return g;
    }

    // 面板的「露出多少」裁剪矩形（面板自身坐标系）：从贴边那一侧露出 Reveal 宽/高
    public static RectD ClipRectFor(string edge, double w, double h, double reveal, double rf) {
      if (edge == "right") return new RectD(w - reveal, -rf, reveal, h + 2.0 * rf);
      if (edge == "left") return new RectD(0.0, -rf, reveal, h + 2.0 * rf);
      if (edge == "top") return new RectD(-rf, 0.0, w + 2.0 * rf, reveal);
      return new RectD(-rf, h - reveal, w + 2.0 * rf, reveal);
    }

    public static double ClipReveal(string edge, RectD r) {
      if (edge == "top" || edge == "bottom") return r.h;
      return r.w;
    }

    // 热区（物理像素）：收起态 = 贴边一条 34 DIP 深的带子；展开态 = 面板框外扩 10 DIP
    public static RectD HotRectPx(MediumGeo g, string state, Metrics m) {
      double s = m.scale, mid, halfAlong;
      string e = g.edge;
      if (state == "collapsed" || state == "collapsing") {
        double deep = FORM_HOT_W;
        halfAlong = (g.sliver.h / 2.0) + FORM_HOT_PAD;
        if (e == "top" || e == "bottom") halfAlong = (g.sliver.w / 2.0) + FORM_HOT_PAD;
        if (e == "right" || e == "left") mid = g.win.y + g.panel.y + g.panel.h / 2.0;
        else mid = g.win.x + g.panel.x + g.panel.w / 2.0;
        if (e == "right") return new RectD((m.dipW - deep) * s, (mid - halfAlong) * s, deep * s, 2.0 * halfAlong * s);
        if (e == "left") return new RectD(0.0, (mid - halfAlong) * s, deep * s, 2.0 * halfAlong * s);
        if (e == "top") return new RectD((mid - halfAlong) * s, 0.0, 2.0 * halfAlong * s, deep * s);
        return new RectD((mid - halfAlong) * s, (m.dipH - deep) * s, 2.0 * halfAlong * s, deep * s);
      }
      double p = FORM_HOT_PAD_EXP;
      double px = g.win.x + g.panel.x, py = g.win.y + g.panel.y;
      double L = (px - p) * s, T = (py - p) * s, R = (px + g.panel.w + p) * s, B = (py + g.panel.h + p) * s;
      if (e == "right") R = m.dipW * s;          // 贴边那一侧不越过屏幕边
      else if (e == "left") L = 0.0;
      else if (e == "top") T = 0.0;
      else B = m.dipH * s;
      return new RectD(L, T, R - L, B - T);
    }

    // 微型卡片离四条边各多远（DIP，负的当 0）：最近的边 + 距离（判定用卡片矩形，不是光标）
    public static string CardEdge(double cardX, double cardY, Metrics m, out double dist) {
      double right = m.dipW - (cardX + CARD_W);
      double left = cardX;
      double top = cardY;
      double bottom = m.dipH - (cardY + CARD_H);
      string best = ""; double bestD = double.MaxValue;
      for (int i = 0; i < TIE_ORDER.Length; i++) {
        string e = TIE_ORDER[i];
        double v = e == "right" ? right : e == "left" ? left : e == "top" ? top : bottom;
        if (v < 0.0) v = 0.0;
        if (v < bestD) { bestD = v; best = e; }
      }
      dist = bestD;
      return best;
    }

    // 中型被拖离贴边的距离（DIP）
    public static double PullOf(string edge, double panelX, double panelY, Metrics m, double panelH) {
      if (edge == "right") return m.dipW - (panelX + PANEL_W);
      if (edge == "left") return panelX;
      if (edge == "top") return panelY;
      return m.dipH - (panelY + panelH);
    }

    // 拖动跟手：一维指数平滑（临界阻尼、不过冲）+ 与帧率无关；距目标 < 0.4 DIP 直接落位
    public static double Follow(double cur, double target, double dt, bool noAnim) {
      if (noAnim) return target;
      double d = target - cur;
      if (Math.Abs(d) < FORM_FOLLOW_SNAP) return target;
      return cur + d * (1.0 - Math.Exp(-dt / FORM_FOLLOW_TAU));
    }

    // 贴边内凹圆角的取样点（唯一出处）：翼根 = 角点往屏幕内 0.29·rf（该是**实的**）、
    //   咬口 = 沿对角线 0.71·rf（该是**空的**）。
    // 内凹画对了，这两点必然「翼根实 / 咬口空」；画成普通圆角（外凸）时必然反过来 —— 自检 T30 就拿它判。
    public static void FilletProbe(string edge, double w, double h, double rf, out double rootX, out double rootY, out double biteX, out double biteY) {
      double k1 = 0.29, k2 = 0.71;
      if (edge == "right") { rootX = w - rf * k1; rootY = -rf * k1; biteX = w - rf * k2; biteY = -rf * k2; }
      else if (edge == "left") { rootX = rf * k1; rootY = -rf * k1; biteX = rf * k2; biteY = -rf * k2; }
      else if (edge == "top") { rootX = -rf * k1; rootY = rf * k1; biteX = -rf * k2; biteY = rf * k2; }
      else { rootX = -rf * k1; rootY = h - rf * k1; biteX = -rf * k2; biteY = h - rf * k2; }
    }

    public static double EaseOutCubic(double p) {
      if (p < 0.0) p = 0.0;
      if (p > 1.0) p = 1.0;
      return 1.0 - Math.Pow(1.0 - p, 3.0);
    }

    // 沿边锚点 → 夹到「整条窗口都在可见区内」（屏幕变小 / 换屏之后存下的位置可能跑到屏外）
    public static double LimitMediumAnchor(string edge, double anchor, double panelH, Metrics m, out bool clamped) {
      double ext = panelH + 2.0 * PANEL_BLEED;
      double along = m.dipH;
      if (edge == "top" || edge == "bottom") along = m.dipW;
      double a = anchor;
      if (ext >= along) a = along / 2.0;
      else {
        if (a < ext / 2.0) a = ext / 2.0;
        if (a > along - ext / 2.0) a = along - ext / 2.0;
      }
      clamped = Math.Abs(a - anchor) > 0.01;
      return a;
    }

    public static void LimitMicroPos(double inX, double inY, Metrics m, out double x, out double y, out bool clamped) {
      x = Math.Max(0.0, Math.Min(inX, Math.Max(0.0, m.dipW - CARD_W)));
      y = Math.Max(0.0, Math.Min(inY, Math.Max(0.0, m.dipH - CARD_H)));
      clamped = Math.Abs(x - inX) > 0.01 || Math.Abs(y - inY) > 0.01;
    }
  }
}
