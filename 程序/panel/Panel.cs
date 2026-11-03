// 常驻悬浮看板 —— 窗口、画法与交互引擎（两个形态同一个窗口；拖到一半换形态不换进程）
// 画法照原型（设计档 2.2.3–2.2.7）；所有数值来自 Geo（几何唯一出处），此处不另写一份。
// 第一刀（已拍板）：**不做呼吸动画** —— 那条发丝描边保持常亮（原型每帧重绘 = 15~18%/核）。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace Board {
  // 一个「读数」的写入规格（初画 / 刷新 / 扫动都走同一条路）
  internal sealed class Readout {
    public string key = "", txtKind = "pct", sym = "¥", unknownText = "—";
    public Path el; public TextBlock txt, amtEl;
    public double cx, cy, r, to;
    public bool known = true, stale, noSweep;
    public string color, txtColor;
  }

  internal sealed class SweepPlan {
    public bool sweep; public double from, to, ms; public string why = "";
    public static SweepPlan Instant(string why) { var p = new SweepPlan(); p.sweep = false; p.why = why; return p; }
    public static SweepPlan Start(double from, double to, double ms) {
      var p = new SweepPlan(); p.sweep = true; p.from = from; p.to = to; p.ms = ms;
      p.why = "扫动"; return p;
    }
  }

  internal sealed class SweepItem {
    public string key = "", txtKind = "pct", sym = "¥";
    public Path el; public TextBlock txt, amtEl;
    public double cx, cy, r, from, to, cur, ms;
    public long t0; public int frames; public string mid = "";
  }

  internal sealed class PanelWindow : Window {
    // ── 引擎状态 ──
    public Metrics M;
    public string form = "medium", state = "collapsed", edge = "right";
    public double anchor = -1, panelH = 0, cardX = -1, cardY = -1;
    public Model model;
    public bool noAnim;
    public bool closing;
    public bool passOn;
    public double collapseDelayMs = 150.0;
    public long peekUntilMs = 0;

    private bool showCollapsed;   // 起手形态（自检/入口可指定）

    // ── 场景元素 ──
    private Canvas root, panelBranch, cardBranch, panelBox, sliverBox;
    private Path panelShape, sliverFill, sliverEdge, ring5Arc, ring7Arc, ringArc;
    private RectangleGeometry clip;
    private ScaleTransform panelScale, cardScale;
    private TextBlock ring5Txt, ring7Txt, ringArcTxt, ringLabel, resetText, snapText, balUnit, balData, balCap, balName, balAmt,
                      cardTodayCap, cardTodayAmt, statusWord, ageText, projName, timer, lastText, todayText, weekText, titleCodex, titleBal, titleProj;
    private Ellipse dot;
    private Border cardBorder;
    private Rectangle cardHint;
    private readonly Dictionary<string, Canvas> balBox = new Dictionary<string, Canvas>();
    private readonly Dictionary<string, TextBlock> balAmtTxt = new Dictionary<string, TextBlock>();
    private readonly Dictionary<string, TextBlock> balNameTxt = new Dictionary<string, TextBlock>();
    private readonly Dictionary<string, TextBlock> balMarkTxt = new Dictionary<string, TextBlock>();
    private readonly Dictionary<string, TextBlock> balCadTxt = new Dictionary<string, TextBlock>();
    private readonly Dictionary<string, TextBlock> balDashTxt = new Dictionary<string, TextBlock>();
    private int builtBalN = -1;

    // ── 读数记忆与扫动 ──
    private readonly Dictionary<string, double> ringShown = new Dictionary<string, double>();
    private readonly List<SweepItem> sweepItems = new List<SweepItem>();
    private bool sweepOn;
    public int sweepRuns, sweepDone;
    public readonly List<string> sweepTraces = new List<string>();
    private readonly Dictionary<string, double[]> balShown = new Dictionary<string, double[]>();
    private readonly Dictionary<string, List<Path>> balArcs = new Dictionary<string, List<Path>>();

    // ── 动画状态 ──
    private string animMode = "none";               // none / drag / morph / snap / relax
    private bool dragOn;
    private bool dragMoved;
    private int dragC0x, dragC0y;
    private double dragGrabDX, dragGrabDY, dragFx, dragFy;
    private double dragLastPathK = -1.0;
    private bool pendingReleaseSet; private bool pendingMoved; private double pendingCx, pendingCy;
    private long transT0; private string transTo = ""; private string transSrc = ""; private bool transOn;
    private RectD transSrcRect, transDstRect; private double transSrcSc0, transHint0, transCardX, transCardY;
    private string transEdge; private double transAnchor;
    private int transFrames; private readonly List<string> transTrace = new List<string>();
    public readonly List<string> morphTraces = new List<string>();
    private bool snapOn; private long snapT0; private double snapMs, snapX0, snapY0, snapX1, snapY1, snapK0; private double snapAnchor;
    public readonly List<string> snapTraces = new List<string>();
    private bool relaxOn; private long relaxT0; private double relaxMs, relaxSc0, relaxHint0;
    private bool framesOn; private long lastFrameMs;
    public int frames; public readonly List<string> stepErrors = new List<string>();
    private long lastInside;
    private bool inside;

    // ── 计时器 ──
    private DispatcherTimer pollTimer, secTimer, statusTimer, dataTimer, cfgTimer, animTimer, stateTimer;
    private string cfgErr = "";

    public event EventHandler RequestExit;

    public PanelWindow(Metrics metrics, Model m, bool startCollapsed) {
      M = metrics; model = m; showCollapsed = startCollapsed;
      WindowStyle = WindowStyle.None;
      AllowsTransparency = true;
      Background = null;                 // 窗口根一个字都不画底 → 形状外面就是桌面
      Topmost = true;
      ShowInTaskbar = false;
      ResizeMode = ResizeMode.NoResize;
      SizeToContent = SizeToContent.Manual;
      ShowActivated = false;             // 不抢焦点
      Title = "AI 能力看板 · 悬浮看板";
      SnapsToDevicePixels = true;
      UseLayoutRounding = true;
      BuildScene();
      SourceInitialized += delegate { ApplyWindowStyles(); };
      Loaded += delegate { InitEngine(); };
    }

    // ==================== 窗口样式（透明 / 穿透 / 置顶 / 不抢焦点 / 不占任务栏）====================
    private void ApplyWindowStyles() {
      var h = new System.Windows.Interop.WindowInteropHelper(this).Handle;
      if (h == IntPtr.Zero) return;
      int ex = Native.GetWindowLong(h, Native.GWL_EXSTYLE);
      ex |= Native.WS_EX_LAYERED | Native.WS_EX_NOACTIVATE | Native.WS_EX_TOOLWINDOW;
      Native.SetWindowLong(h, Native.GWL_EXSTYLE, ex);
      Native.SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0,
        Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOZORDER | Native.SWP_NOACTIVATE | Native.SWP_FRAMECHANGED);
    }

    private void SetPassThrough(bool on) {
      passOn = on;
      var h = new System.Windows.Interop.WindowInteropHelper(this).Handle;
      if (h == IntPtr.Zero) return;
      int ex = Native.GetWindowLong(h, Native.GWL_EXSTYLE);
      int next = on ? (ex | Native.WS_EX_TRANSPARENT | Native.WS_EX_LAYERED) : (ex & ~Native.WS_EX_TRANSPARENT);
      if (next != ex) {
        Native.SetWindowLong(h, Native.GWL_EXSTYLE, next);
        Native.SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0,
          Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOZORDER | Native.SWP_NOACTIVATE | Native.SWP_FRAMECHANGED);
      }
    }

    // ==================== 画法小工具 ====================
    private static readonly BrushConverter Brushes = new BrushConverter();
    private static readonly Dictionary<string, Brush> BrushCache = new Dictionary<string, Brush>();
    public static Brush Brush(string color) {
      if (string.IsNullOrEmpty(color)) return System.Windows.Media.Brushes.Transparent;
      Brush b;
      if (BrushCache.TryGetValue(color, out b)) return b;
      b = (Brush)Brushes.ConvertFromString(color);
      BrushCache[color] = b;
      return b;
    }
    internal static readonly FontFamily UiFont = new FontFamily("Segoe UI, Microsoft YaHei UI");
    internal static readonly FontFamily MonoFont = new FontFamily("Consolas, Microsoft YaHei UI");
    internal static readonly FontFamily MonoUiFont = new FontFamily("Consolas, Microsoft YaHei UI");
    // 新增两行的槽宽与字号（唯一出处：排版用它，自检 T34 用同一组数测「最长的文案装不装得下」）
    // 2026-10-27 用户反馈「看不清」：字号 8→10.5 / 7.5→9，颜色从 #6E7581 / #8A909C 提到 #A8AFBA
    //   （黑底上的对比度 4.4:1 → 9.2:1）；高度与宽度都在 T34 里用真字体度量钉住（面板高不变）。
    internal const double CAD_W = 200.0;    // 余额节奏行（中型面板每家一行）
    internal const double CHILD_W = 126.0;  // 子代理行（中型面板 D 段右侧；9 DIP 时最长文案 123.4）
    internal const double TURNS_W = 50.0;   // 卡片第三行右侧的「N 轮」
    internal const double TIMER_W = 82.0;   // 卡片第三行的计时
    internal const double CAD_DY = 14.0;    // 节奏行相对名称行的下移
    internal const double CAD_SIZE = 10.5, CHILD_SIZE = 9.0;
    internal const string CAD_COLOR = "#A8AFBA", CHILD_COLOR = "#A8AFBA";
    // 卡片第三行：小字标签「模型」+ 大字时长 + 右侧轮次
    internal const double CARD_COL2 = 62.0, CARD_EDGE_PAD = 14.0;
    internal const double CARD_LABEL_W = 18.0, CARD_LABEL_SIZE = 8.5;
    internal const string CARD_LABEL_TEXT = "模型";
    // 微型卡片各行顶（DIP，相对卡片左上角；唯一出处：排版与自检 T37 共用）
    // 2026-11-03：项目名行（12.5 DIP，真字体字高 16.6）与「模型」行原来只隔 0.37 DIP —— 真机上就是字压字；
    //   第三行 38.5 → 43.0（余额圈已从卡片撤掉，下面空出来了），行间 4.9 DIP。
    internal const double CARD_STATUS_Y = 6.5, CARD_PROJ_Y = 21.5;
    internal const double CARD_PROJ_SIZE = 12.5, CARD_TIMER_SIZE = 16.5;
    internal const double CARD_ROW3_Y = 43.0, CARD_LABEL_Y = 49.0, CARD_TURNS_Y = 50.5;
    // 卡片底部：两组「标签 + 数字」（2026-11-03 用户口径 —— 余额与今日已消耗是两件事，拆成各自独立的一组，不混排）：
    //   上排两个小灰标签（余额 / 今日已消耗，8.5 DIP）、下排两个数字（家名 + 金额 / 今日金额，10 DIP，数字同号字）。
    //   高度来源：第三行（模型 16:02，16.5 DIP 真字体字高 19.32 → 底 62.32）与卡片下沿之间原有 14.68 DIP 空地，
    //   两行合计 11.31 + 13.30 = 24.61（含行间 1.09）= 用这块空地，**状态行 / 项目名行 / 第三行一个都不动**
    //   （状态行与项目名行之间只有 0.3 DIP，动不得）。真字体度量与四道间距在自检 T38。
    internal const double CARD_BAL_CAP_Y = 63.6;    // 标签行顶（卡内 y）
    internal const double CARD_BAL_AMT_Y = 76.0;    // 数字行顶（卡内 y）
    internal const double CARD_BAL_CAP_X = 12.0;    // 左组起点（卡内 x）
    internal const double CARD_BAL_RIGHT = 216.0;   // 右组右端（卡宽 228 − 12）
    internal const double CARD_TODAY_CAP_W = 100.0; // 「今日已消耗」右对齐槽宽（真字体宽 42.5）
    internal const double CARD_TODAY_AMT_W = 90.0;  // 「¥12.34」右对齐槽宽（真字体宽 33.0）
    internal const double CARD_BAL_NAME_GAP = 4.0;  // 家名 → 金额
    internal const double CARD_BAL_MIN_GAP = 12.0;  // 左组右端 → 右组左端（不叠字的最小留白）
    internal const double CARD_BAL_SIZE = 10.0, CARD_BAL_CAP_SIZE = 8.5;
    internal const string CARD_BAL_LABEL = "余额", CARD_TODAY_LABEL = "今日已消耗";

    private static TextBlock Txt(double x, double y, double w, string text, double size, string color) {
      return Txt(x, y, w, text, size, color, "Left", "Normal", UiFont, null);
    }
    private static TextBlock Txt(double x, double y, double w, string text, double size, string color,
                                 string align, string weight, FontFamily font, string trim) {
      var t = new TextBlock();
      Canvas.SetLeft(t, x); Canvas.SetTop(t, y);
      if (w > 0) t.Width = w;
      t.Text = text; t.FontSize = size; t.FontFamily = font;
      t.Foreground = Brush(color);
      t.TextAlignment = align == "Right" ? TextAlignment.Right : align == "Center" ? TextAlignment.Center : TextAlignment.Left;
      if (weight == "SemiBold" || weight == "Bold") t.FontWeight = FontWeights.SemiBold;
      if (trim == "ellipsis") t.TextTrimming = TextTrimming.CharacterEllipsis;
      return t;
    }

    private static Ellipse Track(double cx, double cy, double r, double t, string color) {
      var e = new Ellipse();
      e.Width = 2 * r; e.Height = 2 * r;
      Canvas.SetLeft(e, cx - r); Canvas.SetTop(e, cy - r);
      e.Stroke = Brush(color); e.StrokeThickness = t;
      return e;
    }

    // 弧的规格（唯一出处）：≥99.5% 画「两段 180° 弧拼的整圆」（首末点重合的 360° 弧 WPF 不画）
    public static PathGeometry ArcGeometry(double cx, double cy, double r, double remainPct) {
      bool two = remainPct >= 99.5;
      double deg = two ? 360.0 : 360.0 * (remainPct / 100.0);
      bool large = !two && deg > 180.0;
      var fig = new PathFigure();
      fig.IsClosed = false; fig.IsFilled = false;
      var p0 = PtOnCircle(cx, cy, r, -90.0);
      fig.StartPoint = p0;
      if (two) {
        var p1 = PtOnCircle(cx, cy, r, 90.0);
        fig.Segments.Add(new ArcSegment(p1, new Size(r, r), 0.0, true, SweepDirection.Clockwise, true));
        fig.Segments.Add(new ArcSegment(p0, new Size(r, r), 0.0, true, SweepDirection.Clockwise, true));
      } else {
        var p1 = PtOnCircle(cx, cy, r, -90.0 + deg);
        fig.Segments.Add(new ArcSegment(p1, new Size(r, r), 0.0, large, SweepDirection.Clockwise, true));
      }
      var pg = new PathGeometry();
      pg.Figures.Add(fig);
      return pg;
    }

    private static Point PtOnCircle(double cx, double cy, double r, double deg) {
      double a = deg * Math.PI / 180.0;
      return new Point(cx + r * Math.Cos(a), cy + r * Math.Sin(a));
    }

    // ==================== 场景（骨架一次搭好；余额段家数变了才重建）====================
    private void BuildScene() {
      root = new Canvas();
      root.Width = 100; root.Height = 100;
      root.Background = null;                       // 透明：留白区里看到的就是桌面
      root.MouseLeftButtonDown += delegate { StartDrag(); };
      root.MouseRightButtonUp += delegate { OpenMenu(); };
      Content = root;

      panelBranch = new Canvas();
      cardBranch = new Canvas() { Visibility = Visibility.Collapsed };
      root.Children.Add(panelBranch);
      root.Children.Add(cardBranch);

      // 收起条（贴边那一条）
      sliverBox = new Canvas();
      sliverFill = new Path(); sliverFill.Fill = Brush("#FA000000");
      sliverEdge = new Path(); sliverEdge.Stroke = Brush(Geo.HAIRLINE); sliverEdge.StrokeThickness = Geo.HAIRLINE_T;
      // 第一刀：不做呼吸动画 —— 发丝描边常亮（原来那条动画每帧整窗重绘 = 15~18%/核）
      sliverBox.Children.Add(sliverFill);
      sliverBox.Children.Add(sliverEdge);
      panelBranch.Children.Add(sliverBox);

      // 面板
      panelBox = new Canvas();
      panelShape = new Path();
      panelShape.Fill = Brush("#FA000000"); panelShape.Stroke = Brush(Geo.HAIRLINE); panelShape.StrokeThickness = Geo.HAIRLINE_T;
      panelBox.Children.Add(panelShape);
      panelScale = new ScaleTransform(1, 1);
      panelBox.RenderTransform = panelScale;
      panelBox.RenderTransformOrigin = new Point(0.5, 0.5);
      clip = new RectangleGeometry(new Rect(0, 0, 10, 10));
      panelBox.Clip = clip;
      panelBranch.Children.Add(panelBox);
      BuildPanelContent();

      // 卡片
      cardBranch.RenderTransform = cardScale = new ScaleTransform(1, 1);
      cardBranch.RenderTransformOrigin = new Point(0.5, 0.5);
      cardHint = new Rectangle();
      cardHint.RadiusX = Geo.CARD_R; cardHint.RadiusY = Geo.CARD_R;
      cardHint.Stroke = Brush("#8C12151A"); cardHint.StrokeThickness = 0;
      Canvas.SetLeft(cardHint, Geo.CARD_BLEED - 1.2); Canvas.SetTop(cardHint, Geo.CARD_BLEED - 1.2);
      cardHint.Width = Geo.CARD_W + 2.4; cardHint.Height = Geo.CARD_H + 2.4;
      cardBranch.Children.Add(cardHint);
      cardBorder = new Border();
      cardBorder.Width = Geo.CARD_W; cardBorder.Height = Geo.CARD_H;
      cardBorder.CornerRadius = new CornerRadius(Geo.CARD_R);
      cardBorder.Background = Brush("#FFFFFFFF");
      var eff = new DropShadowEffect();
      eff.BlurRadius = 18; eff.ShadowDepth = 3; eff.Direction = 270; eff.Color = Colors.Black; eff.Opacity = 0.20;
      eff.RenderingBias = RenderingBias.Quality;
      cardBorder.Effect = eff;
      Canvas.SetLeft(cardBorder, Geo.CARD_BLEED); Canvas.SetTop(cardBorder, Geo.CARD_BLEED);
      cardBranch.Children.Add(cardBorder);
      BuildCardContent();

      builtBalN = model != null ? model.balN : 0;
      LayoutScene(true);
      UpdateAll(true);
    }

    private void BuildPanelContent() {
      var L = PanelLayout.ForCount(model != null ? model.balN : 0);
      double W = Geo.PANEL_W, PAD = L.PAD;
      titleCodex = Txt(PAD, L.Y_A_TITLE, 0, "Codex", 12.5, "#F2F4F8", "Left", "SemiBold", UiFont, null);
      snapText = Txt(PAD + 90, L.Y_A_TITLE + 4, W - PAD * 2 - 90, "数据 —", 8.5, "#6E7581", "Right", "Normal", UiFont, null);
      panelBox.Children.Add(titleCodex);
      panelBox.Children.Add(snapText);

      // 两个额度环：轨道 + 剩余弧 + 环内剩余% + 环下标签 + 环下刷新时刻
      var l5 = BuildRing(L.A_COL1, L.A_RING_CY, L.A_RING_R, L.A_RING_T, "5h 还剩", out ring5Arc, out ring5Txt);
      var l7 = BuildRing(L.A_COL2, L.A_RING_CY, L.A_RING_R, L.A_RING_T, "7 天 还剩", out ring7Arc, out ring7Txt);
      panelBox.Children.Add(l5);
      panelBox.Children.Add(l7);

      resetText = Txt(PAD, L.Y_A_RESET, W - PAD * 2, "—", 9.5, "#D9A05B");
      panelBox.Children.Add(resetText);
      panelBox.Children.Add(Divider(PAD, L.Y_A_DIV, W - PAD * 2));

      // 余额段（家数为 0 时整段不出现）
      if (model != null && model.balN > 0) {
        titleBal = Txt(PAD, L.Y_B_HEAD, 0, "余额", 12.5, "#F2F4F8", "Left", "SemiBold", UiFont, null);
        balUnit = Txt(PAD + 36, L.Y_B_HEAD + 4, 0, "", 9, "#6E7581");
        balData = Txt(PAD + 130, L.Y_B_HEAD + 4, W - PAD * 2 - 130, "数据 —", 8.5, "#6E7581", "Right", "Normal", UiFont, null);
        panelBox.Children.Add(titleBal);
        panelBox.Children.Add(balUnit);
        panelBox.Children.Add(balData);
        int bi = 0;
        foreach (var g in model.balView.groups) {
          double yR = L.Y_B_RINGS0 + bi * (L.B_BLOCK_H + L.B_BLOCK_GAP);
          double yC = yR + L.B_CAP_DY;
          var box = new Canvas();
          Canvas.SetLeft(box, PAD); Canvas.SetTop(box, yR);
          box.Width = W - PAD * 2; box.Height = L.B_RING_H;
          panelBox.Children.Add(box);
          balBox[g.key] = box;
          var dash = Txt(PAD, yR + 4, 0, "—", 15, "#6E7581");
          dash.Visibility = g.drawable ? Visibility.Collapsed : Visibility.Visible;
          panelBox.Children.Add(dash); balDashTxt[g.key] = dash;
          var nm = Txt(PAD, yC, 0, g.name, 11, "#F2F4F8", "Left", "SemiBold", UiFont, null);
          var mk = Txt(PAD + 74, yC + 2.5, 0, g.marks, 8.5, "#6E7581");
          var am = Txt(PAD, yC - 1, W - PAD * 2, g.amountText, 12, g.amountColor, "Right", "SemiBold", MonoUiFont, null);
          panelBox.Children.Add(nm); panelBox.Children.Add(mk); panelBox.Children.Add(am);
          balNameTxt[g.key] = nm; balMarkTxt[g.key] = mk; balAmtTxt[g.key] = am;
          // 余额节奏（只放中型面板、mini 不放）：「最近 ¥10 用了多久」。
          // 位置在名称行下面、右对齐（向右不长，长文本往左的空地耗，压不到上面那行金额）
          var cd = Txt(PAD, yC + CAD_DY, CAD_W, "", CAD_SIZE, CAD_COLOR, "Right", "Normal", UiFont, null);
          panelBox.Children.Add(cd); balCadTxt[g.key] = cd;
          bi++;
        }
      }

      // 今天 · 这个项目
      titleProj = Txt(PAD, L.Y_C_HEAD, 120, "今天 · 这个项目", 9, "#6E7581");
      lastText = Txt(PAD + 120, L.Y_C_HEAD, W - PAD * 2 - 120, "最近 —", 9, "#565C66", "Right", "Normal", UiFont, null);
      projName = Txt(PAD, L.Y_C_PROJ, W - PAD * 2, model != null ? model.projName : "—", 12, "#F2F4F8", "Left", "Normal", UiFont, "ellipsis");
      todayText = Txt(PAD, L.Y_C_TODAY, W - PAD * 2, "—", 10.5, "#A8AFBA");
      weekText = Txt(PAD, L.Y_C_WEEK, W - PAD * 2, "—", 9.5, "#6E7581");
      panelBox.Children.Add(titleProj); panelBox.Children.Add(lastText);
      panelBox.Children.Add(projName); panelBox.Children.Add(todayText); panelBox.Children.Add(weekText);

      // 状态（永远实时：不被陈旧变暗）
      panelBox.Children.Add(Divider(PAD, L.Y_D_DIV, W - PAD * 2));
      dot = new Ellipse();
      dot.Width = 7; dot.Height = 7;
      Canvas.SetLeft(dot, PAD); Canvas.SetTop(dot, L.Y_D_TEXT + 4.5);
      panelBox.Children.Add(dot);
      statusWord = Txt(PAD + 13, L.Y_D_TEXT, 140, "—", 10.5, "#6E7581");
      panelBox.Children.Add(statusWord);
      // 子代理：只在「确实有在跑的」时候占位（0 个 / 推不出来 → 空串，不上屏）
      childLine = Txt(W - PAD - CHILD_W, L.Y_D_TEXT + 2.5, CHILD_W, "", CHILD_SIZE, CHILD_COLOR, "Right", "Normal", UiFont, null);
      panelBox.Children.Add(childLine);
    }
    private TextBlock childLine;   // 中型面板：子代理 N 个在跑 · 最长 X

    private UIElement BuildRing(double cx, double cy, double r, double t, string label, out Path arc, out TextBlock txt) {
      var box = new Canvas();
      box.Children.Add(Track(cx, cy, r, t, "#272C37"));
      arc = new Path();
      arc.StrokeThickness = t;
      arc.StrokeStartLineCap = PenLineCap.Round; arc.StrokeEndLineCap = PenLineCap.Round;
      box.Children.Add(arc);
      txt = Txt(cx - r, cy - 8, 2 * r, "—", 11, "#EEF2F7", "Center", "Normal", MonoFont, null);
      box.Children.Add(txt);
      box.Children.Add(Txt(cx - r - 6, cy + 29, 2 * r + 12, label, 10, "#9AA1AC", "Center", "Normal", UiFont, null));
      // 环下刷新时刻：由 UpdateAll 写入（元素先建好，刷新与扫动才找得到它）
      var sub = Txt(cx - r - 14, cy + 44, 2 * r + 28, "—", 9, "#8A909C", "Center", "Normal", UiFont, null);
      box.Children.Add(sub);
      if (label == "5h 还剩") sub5 = sub; else sub7 = sub;
      return box;
    }
    private TextBlock sub5, sub7;

    private static Rectangle Divider(double x, double y, double w) {
      var r = new Rectangle();
      r.Width = w; r.Height = 1; r.Fill = Brush("#14FFFFFF");
      Canvas.SetLeft(r, x); Canvas.SetTop(r, y);
      return r;
    }

    private void BuildCardContent() {
      double B = Geo.CARD_BLEED, W = Geo.CARD_W;
      double CX = Geo.CARD_RING_CX, CY = Geo.CARD_RING_CY, R = Geo.CARD_RING_R, T = 4.5;
      var ring = new Canvas();
      ring.Children.Add(Track(B + CX, B + CY, R, T, "#E6E9EE"));
      ringArc = new Path();
      ringArc.StrokeThickness = T;
      ringArc.StrokeStartLineCap = PenLineCap.Round; ringArc.StrokeEndLineCap = PenLineCap.Round;
      ring.Children.Add(ringArc);
      cardBranch.Children.Add(ring);
      ringArcTxt = Txt(B + CX - 19, B + CY - 9, 38, "—", 11.5, "#8A909C", "Center", "SemiBold", MonoFont, null);
      ringLabel = Txt(B + CX - 28, B + 48.5, 56, "Codex", 8, "#8A909C", "Center", "Normal", UiFont, null);
      cardBranch.Children.Add(ringArcTxt);
      cardBranch.Children.Add(ringLabel);

      double COL2 = CARD_COL2, EDGE_PAD = CARD_EDGE_PAD;
      cardDot = new Ellipse(); cardDot.Width = 7; cardDot.Height = 7;
      Canvas.SetLeft(cardDot, B + COL2 + 2); Canvas.SetTop(cardDot, B + 11);
      cardBranch.Children.Add(cardDot);
      cardStatusWord = Txt(B + COL2 + 15, B + CARD_STATUS_Y, 70, "—", 11, "#6E7581", "Left", "SemiBold", UiFont, null);
      cardBranch.Children.Add(cardStatusWord);
      ageText = Txt(B + COL2 + 45, B + 8.5, W - COL2 - EDGE_PAD - 45, "写入 — 前", 8.5, "#9AA0A6", "Right", "Normal", UiFont, null);
      cardBranch.Children.Add(ageText);
      cardProjName = Txt(B + COL2, B + CARD_PROJ_Y, W - COL2 - EDGE_PAD, "—", CARD_PROJ_SIZE, "#12151A", "Left", "SemiBold", UiFont, "ellipsis");
      cardBranch.Children.Add(cardProjName);
      // 第三行大字 = 本会话模型累计运行时长（不是「上一个事件到现在」，也不是进程年龄）
      cardLabel = Txt(B + COL2, B + CARD_LABEL_Y, CARD_LABEL_W, CARD_LABEL_TEXT, CARD_LABEL_SIZE, "#8A909C");
      cardBranch.Children.Add(cardLabel);
      timer = Txt(B + COL2 + CARD_LABEL_W, B + CARD_ROW3_Y, TIMER_W, "", CARD_TIMER_SIZE, "#12151A", "Left", "SemiBold", MonoFont, null);
      cardBranch.Children.Add(timer);
      // 本会话轮次（新一轮：从会话 manifest 的 turnCount 来；读不到就不显示）
      cardTurns = Txt(B + W - EDGE_PAD - TURNS_W, B + CARD_TURNS_Y, TURNS_W, "", 9, "#8A909C", "Right", "Normal", UiFont, null);
      cardBranch.Children.Add(cardTurns);
      // 卡片底部：两组「标签 + 数字」——上排两个小灰标签（左：余额；右：今日已消耗）、下排两个数字（左：家名 + 金额；右：今日金额）
      balCap = Txt(B + CARD_BAL_CAP_X, B + CARD_BAL_CAP_Y, 0, CARD_BAL_LABEL, CARD_BAL_CAP_SIZE, "#8A909C");
      balName = Txt(B + CARD_BAL_CAP_X, B + CARD_BAL_AMT_Y, 0, "", CARD_BAL_SIZE, "#6E7581");
      balAmt = Txt(B + CARD_BAL_CAP_X, B + CARD_BAL_AMT_Y, 0, "", CARD_BAL_SIZE, "#12151A", "Left", "SemiBold", MonoUiFont, null);
      cardTodayCap = Txt(B + CARD_BAL_RIGHT - CARD_TODAY_CAP_W, B + CARD_BAL_CAP_Y, CARD_TODAY_CAP_W, CARD_TODAY_LABEL, CARD_BAL_CAP_SIZE, "#8A909C", "Right", "Normal", UiFont, null);
      cardTodayAmt = Txt(B + CARD_BAL_RIGHT - CARD_TODAY_AMT_W, B + CARD_BAL_AMT_Y, CARD_TODAY_AMT_W, "", CARD_BAL_SIZE, "#12151A", "Right", "SemiBold", MonoUiFont, null);
      cardBranch.Children.Add(balCap);
      cardBranch.Children.Add(balName);
      cardBranch.Children.Add(balAmt);
      cardBranch.Children.Add(cardTodayCap);
      cardBranch.Children.Add(cardTodayAmt);
    }
    private Ellipse cardDot;
    private TextBlock cardStatusWord, cardProjName, cardTurns, cardLabel;
    private string cardTodayWhy = "";   // 「今日已消耗」那一组为什么显示 / 不显示（布局树读数用，不上屏）

    // ==================== 排版 / 形态 ====================
    private void LayoutScene(bool force) {
      if (model == null) return;
      panelH = Geo.PanelH(model.balN, M);
      var g = Geo.Medium(edge, anchor, panelH, M);
      panelBox.Width = Geo.PANEL_W; panelBox.Height = panelH;
      Canvas.SetLeft(panelBox, g.panel.x); Canvas.SetTop(panelBox, g.panel.y);
      panelShape.Data = Geometry.Parse(g.panelPath);
      sliverBox.Width = g.sliver.w; sliverBox.Height = g.sliver.h;
      Canvas.SetLeft(sliverBox, g.sliver.x); Canvas.SetTop(sliverBox, g.sliver.y);
      var sg = Geometry.Parse(g.sliverPath);
      sliverFill.Data = sg; sliverEdge.Data = sg;
      panelBranch.Width = g.win.w; panelBranch.Height = g.win.h;
    }

    // 家数变了 → 面板高的档位变了：整段重建（口径：关掉的平台整组不出现，面板高度跟着走）
    private bool EnsureSceneShape() {
      if (model == null) return false;
      if (model.balN == builtBalN) return false;
      panelBox.Children.Clear();
      balBox.Clear(); balAmtTxt.Clear(); balNameTxt.Clear(); balMarkTxt.Clear(); balDashTxt.Clear(); balCadTxt.Clear();
      BuildPanelContent();
      builtBalN = model.balN;
      return true;
    }

    public void SetForm(string newForm, string newEdge, double newAnchor, double newCardX, double newCardY, string newState) {
      panelBranch.Opacity = 1.0; cardBranch.Opacity = 1.0;
      Canvas.SetLeft(panelBranch, 0.0); Canvas.SetTop(panelBranch, 0.0);
      Canvas.SetLeft(cardBranch, 0.0); Canvas.SetTop(cardBranch, 0.0);
      if (newForm == "medium") {
        if (!string.IsNullOrEmpty(newEdge)) edge = newEdge;
        if (newAnchor >= 0) anchor = newAnchor;
        panelH = Geo.PanelH(model.balN, M);
        var g = Geo.Medium(edge, anchor, panelH, M);
        form = "medium"; state = string.IsNullOrEmpty(newState) ? "collapsed" : newState;
        panelBranch.Visibility = Visibility.Visible;
        cardBranch.Visibility = Visibility.Collapsed;
        LayoutScene(true);
        cardBranch.Width = g.win.w; cardBranch.Height = g.win.h;
        root.Width = g.win.w; root.Height = g.win.h;
        panelScale.ScaleX = 1.0; panelScale.ScaleY = 1.0;
        dragLastPathK = -1.0;
        SetWindowRect(g.win.x, g.win.y, g.win.w, g.win.h);
        ResetClip(state);
        SetPassThrough(state == "collapsed");
      } else {
        if (newCardX < 0) newCardX = cardX;
        if (newCardY < 0) newCardY = cardY;
        if (newCardX < 0) newCardX = M.dipW - Geo.CARD_W - 26;
        if (newCardY < 0) newCardY = M.dipH - Geo.CARD_H - 96;
        var mg = Geo.Micro(newCardX, newCardY, M);
        form = "micro"; state = "micro"; cardX = mg.cardX; cardY = mg.cardY;
        double cw = Geo.CARD_W + 2 * Geo.CARD_BLEED, ch = Geo.CARD_H + 2 * Geo.CARD_BLEED;
        cardBranch.Visibility = Visibility.Visible;
        panelBranch.Visibility = Visibility.Collapsed;
        panelBranch.Width = cw; panelBranch.Height = ch;
        cardBranch.Width = cw; cardBranch.Height = ch;
        root.Width = cw; root.Height = ch;
        SetWindowRect(cardX - Geo.CARD_BLEED, cardY - Geo.CARD_BLEED, cw, ch);
        SetPassThrough(false);
      }
      PanelState.Save(this, false);
    }

    // 面板高 / 形状 / 窗口 / 裁剪一起重算（家数变了之后；微型形态不动 —— 卡片自己一套几何）
    private void ApplyMediumGeometry() {
      if (form != "medium") return;
      panelH = Geo.PanelH(model.balN, M);
      var g = Geo.Medium(edge, anchor, panelH, M);
      LayoutScene(true);
      dragLastPathK = -1.0;
      cardBranch.Width = g.win.w; cardBranch.Height = g.win.h;
      root.Width = g.win.w; root.Height = g.win.h;
      SetWindowRect(g.win.x, g.win.y, g.win.w, g.win.h);
      ResetClip(state);
    }

    public void SetWindowRect(double x, double y, double w, double h) {
      if (w > 0 && Math.Abs(Width - w) > 0.01) Width = w;
      if (h > 0 && Math.Abs(Height - h) > 0.01) Height = h;
      Left = Math.Round(x, 1); Top = Math.Round(y, 1);
    }

    private void ResetClip(string forState) {
      double full = Geo.ClipReveal(edge, new RectD(0, 0, Geo.PANEL_W, panelH));
      double reveal = forState == "expanded" || forState == "expanding" ? full : Geo.SLIVER_W;
      clip.BeginAnimation(RectangleGeometry.RectProperty, null);
      panelBox.BeginAnimation(UIElement.OpacityProperty, null);
      var r = Geo.ClipRectFor(edge, Geo.PANEL_W, panelH, reveal, Geo.PANEL_RF);
      clip.Rect = new Rect(r.x, r.y, r.w, r.h);
      panelBox.Opacity = forState == "collapsed" ? 0.0 : 1.0;
    }

    private void SetPullFeedback(double k) {
      panelScale.ScaleX = 1.0 - Geo.FORM_FEED_SCALE * k;
      panelScale.ScaleY = 1.0 - Geo.FORM_FEED_SCALE * k;
      panelBox.BeginAnimation(UIElement.OpacityProperty, null);
      panelBox.Opacity = 1.0 - Geo.FORM_FEED_FADE * k;
      double rf = Geo.PANEL_RF + (Geo.FORM_FEED_RF - Geo.PANEL_RF) * k;
      if (dragLastPathK < 0.0 || Math.Abs(k - dragLastPathK) > 0.02) {
        panelShape.Data = Geometry.Parse(Geo.CapsulePath(Geo.PANEL_W, panelH, edge, Geo.PANEL_R, rf));
        dragLastPathK = k;
      }
    }

    // ==================== 读数（初画 / 刷新 / 扫动唯一出口）====================
    public void SetReadout(Readout d) {
      double to = d.known ? d.to : 0.0;
      if (d.el != null && !string.IsNullOrEmpty(d.color)) d.el.Stroke = Brush(d.color);
      if (d.txt != null && !string.IsNullOrEmpty(d.txtColor)) d.txt.Foreground = Brush(d.txtColor);
      SetDim(d.el, d.stale); SetDim(d.txt, d.stale); SetDim(d.amtEl, d.stale);
      // 同一元素上还在跑的旧扫动撤掉：新目标以「此刻显示的值」为起点重新起扫，不许跳
      if (sweepOn) {
        for (int i = sweepItems.Count - 1; i >= 0; i--) {
          if (sweepItems[i].key == d.key) { ringShown[d.key] = sweepItems[i].cur; sweepItems.RemoveAt(i); }
        }
        if (sweepItems.Count == 0) sweepOn = false;
      }
      bool hasPrev = ringShown.ContainsKey(d.key);
      double prev = hasPrev ? ringShown[d.key] : 0.0;
      var plan = Sweep.Plan(hasPrev, prev, to, d.known, d.noSweep, noAnim, d.el != null || d.txt != null);
      if (!plan.sweep) {
        SetArc(d.el, d.cx, d.cy, d.r, to, d.known);
        if (d.txt != null) {
          if (!d.known) d.txt.Text = d.unknownText;
          else if (d.txtKind == "amount") d.txt.Text = Fmt.Money(d.sym, to);
          else d.txt.Text = Fmt.Pct(to);
        }
        if (d.amtEl != null) d.amtEl.Text = d.known ? Fmt.Money(d.sym, to) : d.unknownText;
        ringShown[d.key] = to;
        return;
      }
      var it = new SweepItem();
      it.key = d.key; it.el = d.el; it.txt = d.txt; it.amtEl = d.amtEl;
      it.cx = d.cx; it.cy = d.cy; it.r = d.r;
      it.from = plan.from; it.to = plan.to; it.cur = plan.from;
      it.txtKind = d.txtKind; it.sym = d.sym;
      it.t0 = Now(); it.ms = plan.ms;
      sweepItems.Add(it);
      sweepOn = true; sweepRuns++;
      StartFrames();
    }

    private static void SetDim(UIElement el, bool stale) {
      if (el == null) return;
      double v = stale ? Geo.STALE_DIM : 1.0;
      if (Math.Abs(el.Opacity - v) > 0.001) el.Opacity = v;
    }

    public static void SetArc(Path el, double cx, double cy, double r, double pct, bool known) {
      if (el == null) return;
      if (!known || pct <= 0.0) { el.Data = null; return; }
      el.Data = ArcGeometry(cx, cy, r, pct);
    }

    private void StepSweep(long now) {
      if (!sweepOn) return;
      for (int i = sweepItems.Count - 1; i >= 0; i--) {
        var it = sweepItems[i];
        double p = it.ms > 0.0 ? (now - it.t0) / it.ms : 1.0;
        if (p < 0.0) p = 0.0;
        if (p > 1.0) p = 1.0;
        double e = Geo.EaseOutCubic(p);
        if (noAnim) { e = 1.0; p = 1.0; }
        double v = it.from + (it.to - it.from) * e;
        it.cur = v;
        SetArc(it.el, it.cx, it.cy, it.r, v, true);
        if (it.txt != null) it.txt.Text = it.txtKind == "amount" ? Fmt.Money(it.sym, v) : Fmt.Pct(v);
        if (it.amtEl != null) it.amtEl.Text = Fmt.Money(it.sym, v);
        it.frames++;
        if (string.IsNullOrEmpty(it.mid) && p >= 0.4 && p < 1.0)
          it.mid = "中间帧 t=" + ((now - it.t0)).ToString(CultureInfo.InvariantCulture) + "ms p=" + Fmt.Num(Math.Round(p, 2)) + " 值=" + Fmt.Num(Math.Round(v, 2));
        if (p >= 1.0) {
          ringShown[it.key] = it.to;
          sweepTraces.Add(it.key + "：" + Fmt.Num(Math.Round(it.from, 2)) + " → " + Fmt.Num(Math.Round(it.to, 2))
            + "｜" + it.frames + " 帧 / " + ((now - it.t0)).ToString(CultureInfo.InvariantCulture) + " ms｜" + (string.IsNullOrEmpty(it.mid) ? "（没采到中间帧）" : it.mid));
          sweepDone++;
          sweepItems.RemoveAt(i);
        } else ringShown[it.key] = v;
      }
      if (sweepItems.Count == 0) sweepOn = false;
    }

    public bool Sweeping { get { return sweepOn || sweepItems.Count > 0; } }

    // ==================== 刷新 ====================
    public void UpdateAll(bool first) {
      if (model == null) return;
      // 家数变了 → 整段重建，并且把面板高 / 形状 / 窗口 / 裁剪一起拉齐
      //   （只重建内容不动窗口 → 窗口还留在上一档的高度，不穿透的矩形也跟着不对）
      if (EnsureSceneShape()) ApplyMediumGeometry();
      var fr = model.Freshness();
      var L = PanelLayout.ForCount(model.balN);
      string c5 = model.codexOk ? Ctx.ColorOfRemain(model.fiveRemain, model.codex.warn5hUsed, model.codex.crit5hUsed) : "#8A909C";
      string c7 = model.codexOk ? Ctx.ColorOfRemain(model.weekRemain, model.codex.warnWeekUsed, 95.0) : "#8A909C";

      var d5 = new Readout(); d5.key = "p5"; d5.el = ring5Arc; d5.txt = ring5Txt; d5.cx = L.A_COL1; d5.cy = L.A_RING_CY; d5.r = L.A_RING_R;
      d5.to = model.fiveRemain; d5.known = model.codexOk; d5.color = c5; d5.txtKind = "pct"; d5.stale = fr.quotaStale;
      SetReadout(d5);
      var d7 = new Readout(); d7.key = "p7"; d7.el = ring7Arc; d7.txt = ring7Txt; d7.cx = L.A_COL2; d7.cy = L.A_RING_CY; d7.r = L.A_RING_R;
      d7.to = model.weekRemain; d7.known = model.codexOk; d7.color = c7; d7.txtKind = "pct"; d7.stale = fr.quotaStale;
      SetReadout(d7);
      string qc = model.ok ? Ctx.ColorOfRemain(model.quotaRemain, model.qWarnUsed, model.qCritUsed) : "#8A909C";
      var dc = new Readout(); dc.key = "card"; dc.el = ringArc; dc.txt = ringArcTxt;
      dc.cx = Geo.CARD_BLEED + Geo.CARD_RING_CX; dc.cy = Geo.CARD_BLEED + Geo.CARD_RING_CY; dc.r = Geo.CARD_RING_R;
      dc.to = model.quotaRemain; dc.known = model.ok; dc.color = qc; dc.txtColor = qc; dc.txtKind = "pct"; dc.stale = fr.quotaStale;
      SetReadout(dc);
      if (ringLabel != null) ringLabel.Text = model.quotaLabel;

      // 状态类：永远实时（显式归 1：陈旧只允许压读数，不许压状态）
      StyleStatus(fr, first);
      if (sub5 != null) { sub5.Text = model.fiveSub; sub5.Foreground = Brush(model.fiveSubColor); }
      if (sub7 != null) { sub7.Text = model.weekSub; sub7.Foreground = Brush(model.weekSubColor); }
      if (resetText != null) { resetText.Text = model.resetLine; resetText.Foreground = Brush(model.resetColor); }
      if (snapText != null) snapText.Text = "数据 " + (string.IsNullOrEmpty(model.snapText) ? "—" : model.snapText);
      if (projName != null) projName.Text = model.projName;
      if (lastText != null) lastText.Text = "最近 " + model.lastText;
      if (todayText != null) todayText.Text = model.todayLine;
      if (weekText != null) weekText.Text = model.weekLine;

      // 余额段
      if (balData != null) balData.Text = model.balView.dataText;
      if (balUnit != null) {
        balUnit.Text = model.balView.unitText;
        balUnit.Foreground = Brush(model.balView.unitHi ? "#D9A05B" : "#6E7581");
        balUnit.FontWeight = model.balView.unitHi ? FontWeights.SemiBold : FontWeights.Normal;
      }
      var bc = MicroBalText(model);
      if (balCap != null) { balCap.Text = bc.cap; balCap.Foreground = Brush(bc.capColor); }
      if (balName != null) balName.Text = bc.name;
      if (balAmt != null) { balAmt.Text = bc.amt; balAmt.Foreground = Brush(bc.amtColor); }
      // 家名之后的位置按真字体度量摆（家名就两种长短：DeepSeek / 智谱 GLM，不写死偏移）
      if (balAmt != null) {
        double nx = CARD_BAL_CAP_X + (balName != null && !string.IsNullOrEmpty(bc.name) ? TextWidth(balName) + CARD_BAL_NAME_GAP : 0.0);
        Canvas.SetLeft(balAmt, Geo.CARD_BLEED + nx);
      }
      // 右下那组「今日已消耗 + 数字」：与余额同一家、同一个「净消耗」口径；
      //   今天没有采样点 / 历史读不到 → 整组（标签 + 数字）不显示 —— 不显示 0、也不显示「—」
      var tc = TodayCellOf(model, fr);
      if (cardTodayCap != null) cardTodayCap.Text = tc.show ? CARD_TODAY_LABEL : "";
      if (cardTodayAmt != null) { cardTodayAmt.Text = tc.show ? tc.money : ""; cardTodayAmt.Foreground = Brush(tc.moneyColor); }
      cardTodayWhy = tc.why;
      if (tc.show && balAmt != null && cardTodayAmt != null) {
        // 不叠字：左组（家名 + 金额）右端 → 右组数字左端至少留 CARD_BAL_MIN_GAP；真的装不下就整组不显示（不截断）
        double leftEnd = Canvas.GetLeft(balAmt) - Geo.CARD_BLEED + TextWidth(balAmt) + CARD_BAL_MIN_GAP;
        double rightStart = CARD_BAL_RIGHT - TextWidth(cardTodayAmt);
        if (leftEnd > rightStart) {
          cardTodayWhy = "装不下：左组右端 " + Fmt.Num(Math.Round(leftEnd, 1)) + " > 右组左端 " + Fmt.Num(Math.Round(rightStart, 1)) + " DIP";
          if (cardTodayCap != null) cardTodayCap.Text = "";
          cardTodayAmt.Text = "";
          tc.show = false;
        }
      }
      SetDim(cardTodayCap, tc.dim); SetDim(cardTodayAmt, tc.show && tc.dim);
      // 余额节奏：每家一行「最近 ¥10 用了多久」（只在能算出来时有字；算不出 = 空串，不上屏）
      foreach (var g in model.balView.groups) {
        TextBlock t;
        if (!balCadTxt.TryGetValue(g.key, out t) || t == null) continue;
        var cad = model.CadenceOf(g.key);
        t.Text = cad.ok ? cad.text : "";
        SetDim(t, fr.StaleOf(g.key));
      }

      var sigParts = new List<string>();
      foreach (var g in model.balView.groups) sigParts.Add(g.key + "|" + g.sig);
      sigParts.Add("card|" + bc.sig);
      string sigAll = string.Join(";", sigParts.ToArray());
      if (sigAll != balSigAll || first) { UpdateBalanceRings(fr); balSigAll = sigAll; }
      UpdateClock();
    }
    private string balSigAll = "";

    private void StyleStatus(Fresh fr, bool first) {
      string word = model.progress.word, color = model.progress.color;
      if (statusWord != null) { statusWord.Text = word; statusWord.Foreground = Brush(color); statusWord.Opacity = 1.0; }
      if (childLine != null) childLine.Text = model.progress.ChildText();
      if (cardStatusWord != null) { cardStatusWord.Text = word; cardStatusWord.Foreground = Brush(color); cardStatusWord.Opacity = 1.0; }
      if (cardDot != null) { cardDot.Fill = Brush(color); cardDot.Opacity = 1.0; }
      if (dot != null) {
        dot.Opacity = 1.0;
        if (model.progress.state == "idle") { dot.Stroke = Brush(color); dot.Fill = null; dot.StrokeThickness = 1.4; }
        else { dot.Fill = Brush(color); dot.Stroke = null; }
      }
      if (projName != null) projName.Opacity = 1.0;
      if (ageText != null) { ageText.Text = "写入 " + MicroAge() + " 前"; ageText.Opacity = 1.0; }
      if (timer != null) timer.Opacity = 1.0;
      if (cardTurns != null) cardTurns.Opacity = 1.0;
      if (cardProjName != null) cardProjName.Text = model.projName;
    }

    private string MicroAge() {
      double sec = -1;
      long max = 0;
      var act = lastActivityMax;
      if (act > 0) { max = act; sec = (Fmt.NowMs() - max) / 1000.0; }
      if (sec < 0) return "—";
      return Fmt.AgeShort(sec);
    }
    public long lastActivityMax;

    // 余额那一组的唯一出处（卡片与刷新都走它）
    // 2026-11-03：卡片不再画余额圈 —— 与圈有关的字（「1 圈 = ¥X」「<0.01 圈」「不画圈…」）不再上卡片。
    // 2026-11-03 用户口径（两组拆开）：上排标签固定写「余额」（数据状态如「· 沿用」跟标签走），下排「家名 + 金额」；
    //   右边的「今日已消耗」是另一组（见 TodayCellOf），两组各写各的，不混在一行里。
    private sealed class MicroBal { public string cap = "", capColor = "#8A909C", name = "", amt = "", amtColor = "#12151A", sig = "none"; }
    private MicroBal MicroBalText(Model m) {
      var o = new MicroBal();
      var bk = m.balPick;
      if (bk == null) return o;
      o.cap = CARD_BAL_LABEL;
      o.name = bk.name;
      o.sig = bk.key + "|" + bk.sig + "|" + bk.ringCount;
      if (!bk.known) { o.amt = "—"; o.amtColor = "#8A909C"; return o; }   // 读不到：金额写「—」，绝不假装 0
      o.amt = bk.amountText;
      if (bk.amountColor == "#FF6B5A") o.amtColor = "#FF6B5A";
      else if (bk.amountColor == "#F2C94C") o.amtColor = "#D89A00";
      if (!string.IsNullOrEmpty(bk.cardMarks)) o.cap += " · " + bk.cardMarks;
      return o;
    }

    // 卡片右下那组「今日已消耗 + 数字」的唯一出处：与余额同一家；数字来自余额历史的「今日下降段合计」
    private sealed class TodayCell { public bool show, dim; public string money = "", moneyColor = "#12151A", why = ""; }
    private TodayCell TodayCellOf(Model m, Fresh fr) {
      var o = new TodayCell();
      var bk = m.balPick;
      if (bk == null) { o.why = "不显示：没有余额行"; return o; }
      var cad = m.CadenceOf(bk.key);
      if (!cad.todayOk || string.IsNullOrEmpty(cad.todayMoney)) {
        o.why = "不显示：" + (string.IsNullOrEmpty(cad.todayWhy) ? (string.IsNullOrEmpty(cad.why) ? "算不出来" : cad.why) : cad.todayWhy);
        return o;
      }
      o.show = true; o.money = cad.todayMoney; o.why = "显示";
      o.dim = fr != null && fr.StaleOf(bk.key);   // 沿用余额那条 10 分钟陈旧规则：只暗读数
      return o;
    }

    // 余额圈行：结构变了（换尺子 / 圈数变了）重建，读数变了扫动
    private void UpdateBalanceRings(Fresh fr) {
      var M2 = model;
      var L = PanelLayout.ForCount(M2.balN);
      foreach (var g in M2.balView.groups) {
        Canvas c;
        if (!balBox.TryGetValue(g.key, out c) || c == null) continue;
        var pcts = g.rings;
        double[] prev = balShown.ContainsKey(g.key) ? balShown[g.key] : null;
        List<Path> arcs;
        balArcs.TryGetValue(g.key, out arcs);
        bool sameShape = prev != null && prev.Length == pcts.Length && arcs != null && arcs.Count == pcts.Length;
        bool stale = fr.StaleOf(g.key);
        if (!sameShape) {
          c.Children.Clear();
          arcs = new List<Path>();
          if (g.drawable && g.ringCount > 0) {
            for (int i = 0; i < pcts.Length; i++) {
              double cx = L.B_RING_R + L.B_RING_T / 2.0 + i * L.B_RING_PITCH;
              double cy = L.B_RING_R + L.B_RING_T / 2.0;
              c.Children.Add(Track(cx, cy, L.B_RING_R, L.B_RING_T, "#272C37"));
              if (pcts[i] > 0.0) {
                var p = new Path();
                p.Stroke = Brush(g.color); p.StrokeThickness = L.B_RING_T;
                p.StrokeStartLineCap = PenLineCap.Round; p.StrokeEndLineCap = PenLineCap.Round;
                p.Data = ArcGeometry(cx, cy, L.B_RING_R, pcts[i]);
                c.Children.Add(p);
                arcs.Add(p);
              } else arcs.Add(null);
            }
          }
          balArcs[g.key] = arcs;
          balShown[g.key] = pcts;
        } else {
          for (int i = 0; i < pcts.Length && i < arcs.Count; i++) {
            if (arcs[i] == null) continue;
            double cx = L.B_RING_R + L.B_RING_T / 2.0 + i * L.B_RING_PITCH;
            double cy = L.B_RING_R + L.B_RING_T / 2.0;
            SetArc(arcs[i], cx, cy, L.B_RING_R, pcts[i], true);
          }
          balShown[g.key] = pcts;
        }
        foreach (var p in arcs) SetDim(p, stale);
        TextBlock t;
        if (balAmtTxt.TryGetValue(g.key, out t) && t != null) {
          t.Text = g.amountText; t.Foreground = Brush(g.amountColor); SetDim(t, stale);
        }
        if (balNameTxt.TryGetValue(g.key, out t) && t != null) t.Text = g.name;
        if (balMarkTxt.TryGetValue(g.key, out t) && t != null) t.Text = g.marks;
        if (balDashTxt.TryGetValue(g.key, out t) && t != null) t.Visibility = g.drawable ? Visibility.Collapsed : Visibility.Visible;
      }
    }

    // 当前进展（每秒走；状态永远实时——陈旧只压读数，不压这里）
    // 日志读不到时：计时与轮次**整行不显示**（不是 0、也不是「—」）；日志可读但没有模型时间 → 只隐藏计时，轮次保留
    public void UpdateClock() {
      if (model == null) return;
      var pg = model.progress;
      string el = pg.ElapsedClockText();
      bool show = pg.ShowTiming;
      if (timer != null) { timer.Text = el; timer.Visibility = show ? Visibility.Visible : Visibility.Collapsed; }
      if (cardLabel != null) cardLabel.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
      if (cardTurns != null) {
        bool showTurns = pg.haveTurns && (pg.logOk || pg.haveModel);
        cardTurns.Text = pg.haveTurns ? pg.turns + " 轮" : "";
        cardTurns.Visibility = showTurns ? Visibility.Visible : Visibility.Collapsed;
      }
      if (ageText != null) ageText.Text = "写入 " + MicroAge() + " 前";
    }

    // ==================== 交互 ====================
    private long Now() { return Environment.TickCount; }

    private void InitEngine() {
      M = Metrics.Primary();
      noAnim = Native.ReduceMotion(Program.ForceNoAnim);
      anchor = -1.0;
      state = "collapsed";
      if (showCollapsed) SetForm("medium", Program.StartEdge, Program.StartAnchor, -1, -1, "collapsed");
      else SetForm("micro", null, -1, Program.StartCardX, Program.StartCardY, null);
      PanelState.Save(this, true);
      LayoutScene(true);

      animTimer = new DispatcherTimer(DispatcherPriority.Render);
      animTimer.Interval = TimeSpan.FromMilliseconds(8);
      animTimer.Tick += delegate { FrameStep(); };
      stateTimer = new DispatcherTimer();
      stateTimer.Interval = TimeSpan.FromMilliseconds(300);
      stateTimer.Tick += delegate {
        stateTimer.Stop();
        if (form != "medium") return;
        if (state == "expanding") state = "expanded";
        else if (state == "collapsing") { state = "collapsed"; SetPassThrough(true); }
      };
      pollTimer = new DispatcherTimer();
      pollTimer.Interval = TimeSpan.FromMilliseconds(100);
      pollTimer.Tick += delegate { Poll(); };
      pollTimer.Start();
      secTimer = new DispatcherTimer();
      secTimer.Interval = TimeSpan.FromSeconds(1);
      secTimer.Tick += delegate { UpdateClock(); };
      secTimer.Start();
      statusTimer = new DispatcherTimer();
      statusTimer.Interval = TimeSpan.FromSeconds(5);
      statusTimer.Tick += delegate { ReloadStatus(); };
      statusTimer.Start();
      dataTimer = new DispatcherTimer();
      dataTimer.Interval = TimeSpan.FromSeconds(30);
      dataTimer.Tick += delegate { ReloadData(); };
      dataTimer.Start();
      cfgTimer = new DispatcherTimer();
      cfgTimer.Interval = TimeSpan.FromSeconds(5);
      cfgTimer.Tick += delegate { WatchControl(); };
      cfgTimer.Start();
    }

    // 自检用：起手形态由参数定，起手即可见
    public void ShowNow() { Show(); }

    public void ReloadData() {
      try {
        // 把上一份交给 Build：这一次读失败时保留上一份好数据（读不到 ≠ 清空；旧数据按陈旧规则变暗）
        model = Model.Build(model);
        lastActivityMax = ReadActivityMax();
        UpdateAll(false);
      } catch (Exception ex) { stepErrors.Add("ReloadData: " + ex.Message); }
    }

    public void ReloadStatus() {
      try {
        var act = Activity.Read();
        lastActivityMax = act.maxMs;
        model.RefreshLive(act.livePeers > 0);
        StyleStatus(model.Freshness(), false);
        UpdateClock();
      } catch (Exception ex) { stepErrors.Add("ReloadStatus: " + ex.Message); }
    }

    private long ReadActivityMax() {
      try {
        var act = Activity.Read();
        return act.maxMs;
      } catch { return 0; }
    }

    // 开关与升级事务（照托盘第二道保险）：用户关掉 → 面板退出；升级中 → 面板退出让路
    private void WatchControl() {
      try {
        if (PanelControl.PanelDisabled()) { ExitNow(); return; }
        if (PanelControl.Upgrading()) { ExitNow(); return; }
      } catch (Exception ex) { cfgErr = ex.Message; }
    }
    public string CfgErr { get { return cfgErr; } }

    public void ExitNow() {
      if (closing) return;
      closing = true;
      try { PanelState.Save(this, true); } catch { }
      if (RequestExit != null) RequestExit(this, EventArgs.Empty);
      try { Close(); } catch { }
      Application.Current.Shutdown();
    }

    private void OpenMenu() {
      var menu = new ContextMenu();
      var item = new MenuItem();
      item.Header = "关闭悬浮看板";
      item.Click += delegate { CloseByUser(); };
      menu.Items.Add(item);
      menu.PlacementTarget = root;
      menu.IsOpen = true;
    }

    private void CloseByUser() {
      PanelControl.RequestDisable();
      ExitNow();
    }

    private void Poll() {
      if (closing || model == null) return;
      if (dragOn || animMode != "none") return;
      if (form != "medium") return;
      var c = CursorDip();
      long now = Now();
      var g = Geo.Medium(edge, anchor, panelH, M);
      var hot = Geo.HotRectPx(g, state, M);
      inside = c.px >= hot.x && c.px <= hot.x + hot.w && c.py >= hot.y && c.py <= hot.y + hot.h;
      if (inside || now < peekUntilMs) {
        lastInside = now;
        if (state == "collapsed" || state == "collapsing") StartExpand();
      } else {
        if (state == "expanded" && (now - lastInside) >= collapseDelayMs) StartCollapse();
      }
    }

    public void Peek() {
      peekUntilMs = Now() + 2000;
      var h = new System.Windows.Interop.WindowInteropHelper(this).Handle;
      if (h != IntPtr.Zero) Native.SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
      if (form == "medium") StartExpand();
    }

    private void StartExpand() {
      if (form != "medium") return;
      if (state == "expanded" || state == "expanding") return;
      noAnim = Native.ReduceMotion(Program.ForceNoAnim);
      if (noAnim) { state = "expanded"; SetPassThrough(false); ResetClip("expanded"); return; }
      state = "expanding";
      SetPassThrough(false);
      double from = Geo.ClipReveal(edge, RectOf(clip.Rect));
      if (from < Geo.SLIVER_W) from = Geo.SLIVER_W;
      double full = Geo.ClipReveal(edge, new RectD(0, 0, Geo.PANEL_W, panelH));
      var r0 = Geo.ClipRectFor(edge, Geo.PANEL_W, panelH, from, Geo.PANEL_RF);
      var r1 = Geo.ClipRectFor(edge, Geo.PANEL_W, panelH, full, Geo.PANEL_RF);
      var a = new RectAnimation(new Rect(r0.x, r0.y, r0.w, r0.h), new Rect(r1.x, r1.y, r1.w, r1.h), TimeSpan.FromMilliseconds(Geo.FORM_EXPAND_MS));
      var ease = new CubicEase(); ease.EasingMode = EasingMode.EaseOut; a.EasingFunction = ease;
      clip.BeginAnimation(RectangleGeometry.RectProperty, a);
      var o = new DoubleAnimation(panelBox.Opacity, 1.0, TimeSpan.FromMilliseconds(Geo.FORM_EXPAND_MS));
      panelBox.BeginAnimation(UIElement.OpacityProperty, o);
      stateTimer.Stop(); stateTimer.Interval = TimeSpan.FromMilliseconds(Geo.FORM_EXPAND_MS + 40); stateTimer.Start();
    }

    private void StartCollapse() {
      if (form != "medium") return;
      if (state == "collapsed" || state == "collapsing") return;
      noAnim = Native.ReduceMotion(Program.ForceNoAnim);
      if (noAnim) { state = "collapsed"; ResetClip("collapsed"); SetPassThrough(true); return; }
      state = "collapsing";
      double from = Geo.ClipReveal(edge, RectOf(clip.Rect));
      double full = Geo.ClipReveal(edge, new RectD(0, 0, Geo.PANEL_W, panelH));
      if (from > full) from = full;
      var r0 = Geo.ClipRectFor(edge, Geo.PANEL_W, panelH, from, Geo.PANEL_RF);
      var r1 = Geo.ClipRectFor(edge, Geo.PANEL_W, panelH, Geo.SLIVER_W, Geo.PANEL_RF);
      var a = new RectAnimation(new Rect(r0.x, r0.y, r0.w, r0.h), new Rect(r1.x, r1.y, r1.w, r1.h), TimeSpan.FromMilliseconds(Geo.FORM_COLLAPSE_MS));
      var ease = new CubicEase(); ease.EasingMode = EasingMode.EaseInOut; a.EasingFunction = ease;
      clip.BeginAnimation(RectangleGeometry.RectProperty, a);
      var o = new DoubleAnimation(panelBox.Opacity, 0.0, TimeSpan.FromMilliseconds((int)(Geo.FORM_COLLAPSE_MS * 0.85)));
      o.BeginTime = TimeSpan.FromMilliseconds((int)(Geo.FORM_COLLAPSE_MS * 0.15));
      panelBox.BeginAnimation(UIElement.OpacityProperty, o);
      stateTimer.Stop(); stateTimer.Interval = TimeSpan.FromMilliseconds(Geo.FORM_COLLAPSE_MS + 40); stateTimer.Start();
    }

    private static RectD RectOf(Rect r) { return new RectD(r.X, r.Y, r.Width, r.Height); }

    private sealed class CursorPos { public int px, py; public double x, y; }
    private CursorPos CursorDip() {
      var p = new POINT();
      Native.GetCursorPos(out p);
      var c = new CursorPos();
      c.px = p.X; c.py = p.Y; c.x = p.X / M.scale; c.y = p.Y / M.scale;
      return c;
    }

    // ── 拖动 ──
    private void StartDrag() {
      if (closing || dragOn) return;
      if (animMode == "morph") return;
      if (animMode == "snap") FinishSnap();
      if (animMode == "relax") { ClearCardFeedback(); animMode = "none"; }
      if (form == "medium" && state != "expanded") return;    // 收起条是穿透热区，拖动起点只在展开态
      noAnim = Native.ReduceMotion(Program.ForceNoAnim);
      var c = CursorDip();
      dragOn = true; dragMoved = false;
      dragC0x = c.px; dragC0y = c.py;
      pendingReleaseSet = false;
      dragLastPathK = -1.0;
      var g = Geo.Medium(edge, anchor, panelH, M);
      if (form == "medium") {
        dragGrabDX = c.x - (g.win.x + g.panel.x);
        dragGrabDY = c.y - (g.win.y + g.panel.y);
        dragFx = g.win.x + g.panel.x; dragFy = g.win.y + g.panel.y;
      } else {
        dragGrabDX = c.x - cardX; dragGrabDY = c.y - cardY;
        dragFx = cardX; dragFy = cardY;
      }
      animMode = "drag";
      StartFrames();
    }

    private void FrameStep() {
      if (closing) { StopFrames(); return; }
      long now = Now();
      double dt = now - lastFrameMs;
      if (dt < 1.0) dt = 1.0;
      if (dt > 100.0) dt = 100.0;
      lastFrameMs = now;
      frames++;
      try {
        if (sweepOn) StepSweep(now);
        if (animMode == "drag") StepDrag(now, dt);
        else if (animMode == "morph") StepMorph(now, dt);
        else if (animMode == "snap") StepSnap(now, dt);
        else if (animMode == "relax") StepRelax(now, dt);
      } catch (Exception ex) { stepErrors.Add("帧: " + ex.Message); }
      if (animMode == "none" && !dragOn && !sweepOn) StopFrames();
    }

    private void StartFrames() {
      if (framesOn) return;
      framesOn = true; lastFrameMs = Now();
      animTimer.Start();
    }
    private void StopFrames() {
      if (!framesOn) return;
      framesOn = false; animTimer.Stop();
    }

    private void StepDrag(long now, double dt) {
      if (!dragOn) { animMode = "none"; return; }
      if (!Native.LeftDown()) { EndDrag(); return; }
      var c = CursorDip();
      if (!dragMoved) {
        if (Math.Abs(c.px - dragC0x) < 3 && Math.Abs(c.py - dragC0y) < 3) return;
        dragMoved = true;
      }
      if (form == "medium") {
        double tx = c.x - dragGrabDX, ty = c.y - dragGrabDY;
        double px = Geo.Follow(dragFx, tx, dt, noAnim);
        double py = Geo.Follow(dragFy, ty, dt, noAnim);
        dragFx = px; dragFy = py;
        double pull = Geo.PullOf(edge, px, py, M, panelH);
        if (pull >= Geo.FORM_DETACH_DIP) {
          dragGrabDX = Geo.CARD_W / 2.0; dragGrabDY = Geo.CARD_H / 2.0;
          dragFx = c.x - Geo.CARD_W / 2.0; dragFy = c.y - Geo.CARD_H / 2.0;
          StartMorph("micro", null, -1, dragFx, dragFy);
          return;
        }
        double k = pull / Geo.FORM_DETACH_DIP;
        if (k < 0.0) k = 0.0; if (k > 1.0) k = 1.0;
        sliverBox.Visibility = Visibility.Collapsed;
        SetPullFeedback(k);
        var g = Geo.Medium(edge, anchor, panelH, M);
        double wl = px - g.panel.x, wt = py - g.panel.y;
        wl = Math.Max(0.0, Math.Min(wl, M.dipW - g.win.w));
        wt = Math.Max(0.0, Math.Min(wt, M.dipH - g.win.h));
        SetWindowRect(wl, wt, -1, -1);
      } else {
        double tx = c.x - dragGrabDX, ty = c.y - dragGrabDY;
        tx = Math.Max(0.0, Math.Min(tx, M.dipW - Geo.CARD_W));
        ty = Math.Max(0.0, Math.Min(ty, M.dipH - Geo.CARD_H));
        double x = Geo.Follow(dragFx, tx, dt, noAnim);
        double y = Geo.Follow(dragFy, ty, dt, noAnim);
        dragFx = x; dragFy = y;
        cardX = x; cardY = y;
        SetWindowRect(x - Geo.CARD_BLEED, y - Geo.CARD_BLEED, -1, -1);
        double d;
        Geo.CardEdge(x, y, M, out d);
        double u = 0.0;
        if (d <= Geo.FORM_HINT_DIP) {
          u = 1.0 - (d - Geo.FORM_DOCK_DIP) / (Geo.FORM_HINT_DIP - Geo.FORM_DOCK_DIP);
          if (u < 0.0) u = 0.0; if (u > 1.0) u = 1.0;
        }
        cardScale.ScaleX = 1.0 + 0.05 * u; cardScale.ScaleY = 1.0 + 0.05 * u;
        cardHint.StrokeThickness = 2.4 * u;
      }
    }

    private void EndDrag() {
      if (!dragOn) return;
      dragOn = false;
      var c = CursorDip();
      if (animMode == "morph") {
        pendingReleaseSet = true; pendingMoved = dragMoved; pendingCx = c.x; pendingCy = c.y;
        dragMoved = false;
        return;
      }
      if (form == "micro") {
        double d;
        Geo.CardEdge(cardX, cardY, M, out d);
        if (dragMoved && d <= Geo.FORM_DOCK_DIP) {
          var info = Geo.CardEdge(cardX, cardY, M, out d);
          double a = (info == "top" || info == "bottom") ? c.x : c.y;
          StartMorph("medium", info, a, -1, -1);
        } else {
          StartRelax();
        }
      } else {
        if (dragMoved) {
          double a = (edge == "top" || edge == "bottom") ? c.x : c.y;
          StartSnapBack(a);
        } else {
          panelScale.ScaleX = 1.0; panelScale.ScaleY = 1.0;
          panelBox.BeginAnimation(UIElement.OpacityProperty, null);
          panelBox.Opacity = 1.0;
          var g = Geo.Medium(edge, anchor, panelH, M);
          panelShape.Data = Geometry.Parse(g.panelPath);
          dragLastPathK = -1.0;
          sliverBox.Visibility = Visibility.Visible;
        }
      }
      dragMoved = false;
    }

    private void FinishSnap() {
      if (animMode != "snap") return;
      SetForm("medium", edge, snapAnchor, -1, -1, "expanded");
      animMode = "none";
    }

    private void StartSnapBack(double a) {
      noAnim = Native.ReduceMotion(Program.ForceNoAnim);
      var g = Geo.Medium(edge, a, panelH, M);
      double k0 = dragLastPathK;
      if (k0 < 0.0 || k0 > 1.0) k0 = 0.0;
      if (noAnim) { SetForm("medium", edge, a, -1, -1, "expanded"); return; }
      snapOn = true; snapAnchor = a; snapT0 = Now(); snapMs = Geo.FORM_SNAP_MS;
      snapX0 = Left; snapY0 = Top; snapX1 = g.win.x; snapY1 = g.win.y; snapK0 = k0;
      snapTraces.Clear();
      sliverBox.Visibility = Visibility.Collapsed;
      animMode = "snap";
      StartFrames();
      StepSnap(Now(), 16.0);
    }

    private void StepSnap(long now, double dt) {
      double p = snapMs > 0 ? (now - snapT0) / snapMs : 1.0;
      if (p > 1.0) p = 1.0; if (p < 0.0) p = 0.0;
      double e = Geo.EaseOutCubic(p);
      double x = snapX0 + (snapX1 - snapX0) * e;
      double y = snapY0 + (snapY1 - snapY0) * e;
      SetWindowRect(x, y, -1, -1);
      SetPullFeedback(snapK0 * (1.0 - e));
      if (p >= 1.0) {
        snapTraces.Add("t=" + ((now - snapT0)).ToString(CultureInfo.InvariantCulture) + "ms 从 ("
          + Fmt.Num(snapX0) + "," + Fmt.Num(snapY0) + ") 到 (" + Fmt.Num(snapX1) + "," + Fmt.Num(snapY1) + ")");
        SetForm("medium", edge, snapAnchor, -1, -1, "expanded");
        animMode = "none";
      }
    }

    private void ClearCardFeedback() {
      cardScale.ScaleX = 1.0; cardScale.ScaleY = 1.0;
      if (cardHint != null) cardHint.StrokeThickness = 0.0;
    }

    private void StartRelax() {
      if (animMode == "morph") return;
      double sc = cardScale.ScaleX;
      double hint = cardHint != null ? cardHint.StrokeThickness : 0.0;
      if (noAnim || (Math.Abs(sc - 1.0) < 0.001 && hint < 0.01)) { ClearCardFeedback(); return; }
      relaxOn = true; relaxT0 = Now(); relaxMs = Geo.FORM_RELAX_MS; relaxSc0 = sc; relaxHint0 = hint;
      animMode = "relax";
      StartFrames();
    }

    private void StepRelax(long now, double dt) {
      double p = relaxMs > 0 ? (now - relaxT0) / relaxMs : 1.0;
      if (p > 1.0) p = 1.0; if (p < 0.0) p = 0.0;
      double e = Geo.EaseOutCubic(p);
      double sc = relaxSc0 + (1.0 - relaxSc0) * e;
      cardScale.ScaleX = sc; cardScale.ScaleY = sc;
      if (cardHint != null) cardHint.StrokeThickness = relaxHint0 * (1.0 - e);
      if (p >= 1.0) { ClearCardFeedback(); animMode = "none"; relaxOn = false; }
    }

    // ── 变形过渡（唯一带过渡的换形态入口）──
    private void StartMorph(string to, string newEdge, double newAnchor, double newCardX, double newCardY) {
      noAnim = Native.ReduceMotion(Program.ForceNoAnim);
      if (animMode == "morph") return;
      string srcForm = form;
      transSrcRect = new RectD(Left, Top, Width, Height);
      RectD dstWin; MediumGeo mg = null; MicroGeo xg = null;
      if (to == "medium") {
        panelH = Geo.PanelH(model.balN, M);
        mg = Geo.Medium(newEdge, newAnchor, panelH, M);
        dstWin = mg.win;
      } else {
        xg = Geo.Micro(newCardX, newCardY, M);
        dstWin = xg.win;
      }
      if (noAnim) {
        if (to == "medium") SetForm("medium", newEdge, newAnchor, -1, -1, "expanded");
        else SetForm("micro", null, -1, newCardX, newCardY, null);
        morphTraces.Add((to == "medium" ? "micro→medium" : "medium→micro") + "：0ms / 0 帧（减少动态效果开着 → 瞬时落定）");
        return;
      }
      if (to == "medium") {
        panelBox.Width = Geo.PANEL_W; panelBox.Height = panelH;
        Canvas.SetLeft(panelBox, mg.panel.x); Canvas.SetTop(panelBox, mg.panel.y);
        panelShape.Data = Geometry.Parse(mg.panelPath);
        ResetClip("expanded");
      } else {
        ClearCardFeedback();
      }
      panelBranch.Visibility = Visibility.Visible;
      cardBranch.Visibility = Visibility.Visible;
      panelBranch.Opacity = 1.0; cardBranch.Opacity = 1.0;
      transSrcSc0 = srcForm == "micro" ? cardScale.ScaleX : panelScale.ScaleX;
      transHint0 = cardHint != null ? cardHint.StrokeThickness : 0.0;
      transOn = true; transTo = to; transSrc = srcForm; transT0 = Now();
      transSrcRect = new RectD(Left, Top, Width, Height);
      transDstRect = dstWin;
      transEdge = newEdge; transAnchor = newAnchor; transCardX = newCardX; transCardY = newCardY;
      transFrames = 0; transTrace.Clear();
      form = to;
      if (to == "medium") { edge = newEdge; anchor = newAnchor; state = "expanded"; }
      else { state = "micro"; cardX = newCardX; cardY = newCardY; }
      SetPassThrough(false);
      animMode = "morph";
      StartFrames();
      StepMorph(Now(), 16.0);
    }

    private void StepMorph(long now, double dt) {
      if (!transOn) return;
      if (dragOn && !Native.LeftDown()) EndDrag();
      transFrames++;
      double p = (now - transT0) / Geo.FORM_MORPH_MS;
      if (p > 1.0) p = 1.0; if (p < 0.0) p = 0.0;
      double e = Geo.EaseOutCubic(p);
      if (transTo == "micro" && dragOn) {
        var c = CursorDip();
        double tx = c.x - dragGrabDX, ty = c.y - dragGrabDY;
        tx = Math.Max(0.0, Math.Min(tx, M.dipW - Geo.CARD_W));
        ty = Math.Max(0.0, Math.Min(ty, M.dipH - Geo.CARD_H));
        double nx = Geo.Follow(dragFx, tx, dt, noAnim);
        double ny = Geo.Follow(dragFy, ty, dt, noAnim);
        dragFx = nx; dragFy = ny;
        transCardX = nx; transCardY = ny;
        var g = Geo.Micro(nx, ny, M);
        transDstRect = g.win;
      }
      double srcOp = 1.0 - e, dstOp = e;
      double srcSc = transSrcSc0 + (Geo.FORM_MORPH_SRC - transSrcSc0) * e;
      double dstSc = Geo.FORM_MORPH_DST + (1.0 - Geo.FORM_MORPH_DST) * e;
      if (transSrc == "medium") { panelBranch.Opacity = srcOp; panelScale.ScaleX = srcSc; panelScale.ScaleY = srcSc; }
      else { cardBranch.Opacity = srcOp; cardScale.ScaleX = srcSc; cardScale.ScaleY = srcSc; }
      if (transTo == "medium") { panelBranch.Opacity = dstOp; panelScale.ScaleX = dstSc; panelScale.ScaleY = dstSc; }
      else { cardBranch.Opacity = dstOp; cardScale.ScaleX = dstSc; cardScale.ScaleY = dstSc; }
      if (cardHint != null) cardHint.StrokeThickness = transHint0 * srcOp;
      // 窗口 = 两矩形并集（按物理像素对齐）：两边都不被裁
      double s = M.scale;
      double ux = Math.Min(transSrcRect.x, transDstRect.x), uy = Math.Min(transSrcRect.y, transDstRect.y);
      double ur = Math.Max(transSrcRect.Right, transDstRect.Right), ub = Math.Max(transSrcRect.Bottom, transDstRect.Bottom);
      ux = Math.Round(ux * s) / s; uy = Math.Round(uy * s) / s;
      ur = Math.Round(ur * s) / s; ub = Math.Round(ub * s) / s;
      Canvas.SetLeft(panelBranch, transSrcRect.x - ux); Canvas.SetTop(panelBranch, transSrcRect.y - uy);
      Canvas.SetLeft(cardBranch, transDstRect.x - ux); Canvas.SetTop(cardBranch, transDstRect.y - uy);
      root.Width = ur - ux; root.Height = ub - uy;
      SetWindowRect(ux, uy, ur - ux, ub - uy);
      if (p >= 1.0) CompleteMorph(now);
    }

    private void CompleteMorph(long now) {
      animMode = "none";
      string dir = transTo == "medium" ? "micro→medium" : "medium→micro";
      morphTraces.Add(dir + "：" + ((now - transT0)).ToString(CultureInfo.InvariantCulture) + "ms / " + transFrames + " 帧");
      transOn = false;
      if (transTo == "medium") SetForm("medium", transEdge, transAnchor, -1, -1, "expanded");
      else { ClearCardFeedback(); SetForm("micro", null, -1, transCardX, transCardY, null); }
      if (pendingReleaseSet && transTo == "micro") {
        pendingReleaseSet = false;
        double d;
        var info = Geo.CardEdge(cardX, cardY, M, out d);
        if (pendingMoved && d <= Geo.FORM_DOCK_DIP) {
          double a = (info == "top" || info == "bottom") ? pendingCx : pendingCy;
          StartMorph("medium", info, a, -1, -1);
        } else StartRelax();
      }
      if (animMode == "none" && dragOn) animMode = "drag";
    }

    // 自检与报告用的读数
    public string Summary() {
      if (form == "micro") {
        double d;
        var e = Geo.CardEdge(cardX, cardY, M, out d);
        return "微型 卡片左上角 (" + Fmt.Num(Math.Round(cardX, 1)) + ", " + Fmt.Num(Math.Round(cardY, 1)) + ") DIP，离最近边「" + Geo.EdgeCn(e) + "」" + Fmt.Num(Math.Round(d, 1))
          + " DIP；窗口 " + Fmt.Num(Width) + " x " + Fmt.Num(Height) + " DIP @ (" + Fmt.Num(Math.Round(Left, 1)) + "," + Fmt.Num(Math.Round(Top, 1)) + ")";
      }
      return "中型 贴" + Geo.EdgeCn(edge) + " 状态=" + state + " 沿边锚点=" + Fmt.Num(Math.Round(anchor, 1)) + " DIP；窗口 "
        + Fmt.Num(Width) + " x " + Fmt.Num(Height) + " DIP @ (" + Fmt.Num(Math.Round(Left, 1)) + "," + Fmt.Num(Math.Round(Top, 1)) + ")";
    }

    public string Form { get { return form; } }
    public string State { get { return state; } }
    public string Edge { get { return edge; } }
    public double Anchor { get { return anchor; } }
    public double CardX { get { return cardX; } }
    public double CardY { get { return cardY; } }
    public double PanelH { get { return panelH; } }
    public bool NoAnim { get { return noAnim; } set { noAnim = value; } }
    public bool FramesRunning { get { return framesOn; } }
    public bool PassOn { get { return passOn; } }
    // 自检探针：直接驱动一次拖动/悬停（不动真鼠标）
    public void TestStartDrag(int px, int py) {
      dragOn = true; dragMoved = false; dragC0x = px; dragC0y = py;
      var g = Geo.Medium(edge, anchor, panelH, M);
      dragGrabDX = px / M.scale - (g.win.x + g.panel.x);
      dragGrabDY = py / M.scale - (g.win.y + g.panel.y);
      dragFx = g.win.x + g.panel.x; dragFy = g.win.y + g.panel.y;
      animMode = "drag"; StartFrames();
    }
    public void TestEndDrag() { EndDrag(); }
    public void TestForceDragMoved() { dragMoved = true; }
    public void TestStepDrag(double dipX, double dipY, double dt) {
      dragMoved = true;
      if (form == "medium") {
        double px = Geo.Follow(dragFx, dipX - dragGrabDX, dt, noAnim);
        double py = Geo.Follow(dragFy, dipY - dragGrabDY, dt, noAnim);
        dragFx = px; dragFy = py;
        double pull = Geo.PullOf(edge, px, py, M, panelH);
        if (pull >= Geo.FORM_DETACH_DIP) {
          dragGrabDX = Geo.CARD_W / 2.0; dragGrabDY = Geo.CARD_H / 2.0;
          dragFx = dipX - Geo.CARD_W / 2.0; dragFy = dipY - Geo.CARD_H / 2.0;
          StartMorph("micro", null, -1, dragFx, dragFy);
          return;
        }
        double k = pull / Geo.FORM_DETACH_DIP;
        if (k < 0.0) k = 0.0; if (k > 1.0) k = 1.0;
        SetPullFeedback(k);
      }
    }
    public void TestSetMicro(double x, double y) { SetForm("micro", null, -1, x, y, null); }

    // ── UI 自检出口（T14 的「只暗读数」、T15 的扫动、A4 的样式读回都从这里取）──
    public void TestExpand() { StartExpand(); }
    public void TestCollapse() { StartCollapse(); }
    public void ApplyModel(Model m) { model = m; UpdateAll(true); }

    public Dictionary<string, string> UiSnapshot() {
      var d = new Dictionary<string, string>();
      d["form"] = form; d["state"] = state; d["edge"] = edge;
      d["passThrough"] = passOn ? "1" : "0";
      d["noAnim"] = noAnim ? "1" : "0";
      d["window"] = Fmt.Num(Left) + "," + Fmt.Num(Top) + " " + Fmt.Num(Width) + "x" + Fmt.Num(Height);
      d["panelOpacity"] = Fmt.Num(Math.Round(panelBox.Opacity, 2));
      d["clipReveal"] = Fmt.Num(Math.Round(Geo.ClipReveal(edge, RectOf(clip.Rect)), 1));
      d["ring5Arc"] = ring5Arc.Data == null ? "—" : "有弧";
      d["ring5Txt"] = ring5Txt.Text + "@" + Fmt.Num(Math.Round(ring5Txt.Opacity, 2));
      d["ring7Txt"] = ring7Txt.Text + "@" + Fmt.Num(Math.Round(ring7Txt.Opacity, 2));
      d["ringArc"] = ringArc.Data == null ? "—" : "有弧";
      d["ringArcTxt"] = ringArcTxt.Text + "@" + Fmt.Num(Math.Round(ringArcTxt.Opacity, 2));
      d["statusWord"] = cardStatusWord.Text + "@" + Fmt.Num(Math.Round(cardStatusWord.Opacity, 2));
      d["panelStatusWord"] = statusWord.Text + "@" + Fmt.Num(Math.Round(statusWord.Opacity, 2));
      d["timer"] = timer.Text + "@" + Fmt.Num(Math.Round(timer.Opacity, 2));
      d["timerVisible"] = timer.Visibility == Visibility.Visible ? "1" : "0";
      d["cardTurns"] = cardTurns == null ? "—" : (cardTurns.Text + (cardTurns.Visibility == Visibility.Visible ? "" : "(隐藏)"));
      d["childLine"] = childLine == null ? "—" : childLine.Text;
      var cads = new List<string>();
      foreach (var kv in balCadTxt) cads.Add(kv.Key + "=" + (kv.Value == null ? "" : kv.Value.Text));
      d["cadence"] = cads.Count == 0 ? "—" : string.Join(" / ", cads.ToArray());
      d["ageText"] = ageText.Text + "@" + Fmt.Num(Math.Round(ageText.Opacity, 2));
      d["dot"] = Fmt.Num(Math.Round(cardDot.Opacity, 2));
      int arcs = 0, dim = 0;
      foreach (var kv in balArcs) foreach (var p in kv.Value) { if (p != null) { arcs++; if (p.Opacity < 0.99) dim++; } }
      d["balArcs"] = dim + "/" + arcs;
      // 微型卡片布局树读数（2026-11-03 验收）：环下文字 / 余额圈元素数 / 两行字的真实位置
      d["cardRingLabel"] = ringLabel == null ? "—" : ringLabel.Text;
      d["cardRingValue"] = ringArcTxt == null ? "—" : (ringArcTxt.Text + "@" + Fmt.Num(Math.Round(ringArcTxt.Opacity, 2)));
      // 卡上「余额圈那一带」（卡片 y ≥ 60）还剩几个圆/弧：用户口径要求 0
      d["cardBalShapes"] = CardShapes(Geo.CARD_BLEED + 60.0).ToString();
      // 2026-11-03 两组「标签 + 数字」（余额 / 今日已消耗）：文字 + 真正占的盒子（右对齐槽按槽右端算）
      d["cardBalCap"] = balCap == null ? "—" : balCap.Text;
      d["cardBalName"] = balName == null ? "—" : balName.Text;
      d["cardBalAmt"] = balAmt == null ? "—" : balAmt.Text;
      d["cardTodayCap"] = cardTodayCap == null ? "—" : cardTodayCap.Text;
      d["cardTodayAmt"] = cardTodayAmt == null ? "—" : cardTodayAmt.Text;
      d["cardTodayDim"] = cardTodayAmt == null ? "—" : "@" + Fmt.Num(Math.Round(cardTodayAmt.Opacity, 2));
      d["cardTodayWhy"] = cardTodayWhy;
      d["cardBalCapRow"] = RowRect(balCap);
      d["cardBalNameRow"] = RowRect(balName);
      d["cardBalAmtRow"] = RowRect(balAmt);
      d["cardTodayCapRow"] = RowRect(cardTodayCap);
      d["cardTodayAmtRow"] = RowRect(cardTodayAmt);
      d["cardProjRow"] = RowRect(cardProjName);
      d["cardModelRow"] = RowRect(timer);
      d["cardTree"] = CardLayoutText();
      d["sweep"] = SweepText();
      return d;
    }

    // ---- 布局树读数（只读；--selftest-ui 用）----
    // 数一数卡片上 y ≥ minY 的圆/弧元素（余额圈撤没撤，用元素数说话，不看代码）
    private int CardShapes(double minY) { return CountShapes(cardBranch, 0.0, minY); }
    private static int CountShapes(Canvas c, double baseY, double minY) {
      if (c == null) return 0;
      int n = 0;
      foreach (UIElement e in c.Children) {
        double top = Canvas.GetTop(e);
        double y = baseY + (double.IsNaN(top) ? 0.0 : top);
        if ((e is Path || e is Ellipse) && y >= minY) n++;
        Canvas cc = e as Canvas;
        if (cc != null) n += CountShapes(cc, y, minY);
      }
      return n;
    }
    // 一行字的盒子：坐标改用**卡片内部坐标系**（卡片左上角 = 0,0，228×90），宽高用真字体度量
    // 2026-11-03：右对齐 / 居中的槽要按「字真正画在哪」算 —— 字画在槽的右端，不是槽的左上角（否则量出来的左端是假的）
    private static string RowRect(TextBlock t) {
      if (t == null) return "—";
      double left = Canvas.GetLeft(t), top = Canvas.GetTop(t);
      if (double.IsNaN(left)) left = 0;
      if (double.IsNaN(top)) top = 0;
      left -= Geo.CARD_BLEED; top -= Geo.CARD_BLEED;
      double w = TextWidth(t);
      if (!double.IsNaN(t.Width) && t.Width > 0) {
        if (w > t.Width) w = t.Width;
        if (t.TextAlignment == TextAlignment.Right) left += t.Width - w;
        else if (t.TextAlignment == TextAlignment.Center) left += (t.Width - w) / 2.0;
      }
      double h = TextHeight(t);
      return "left=" + Fmt.Num(Math.Round(left, 1)) + " right=" + Fmt.Num(Math.Round(left + w, 1))
           + " top=" + Fmt.Num(Math.Round(top, 1)) + " bottom=" + Fmt.Num(Math.Round(top + h, 1));
    }
    private static double TextHeight(TextBlock t) { return FmtOf(t).Height; }
    private static double TextWidth(TextBlock t) { return FmtOf(t).WidthIncludingTrailingWhitespace; }
    private static FormattedText FmtOf(TextBlock t) {
      return new FormattedText(t.Text ?? "", CultureInfo.CurrentCulture, FlowDirection.LeftToRight,
        new Typeface(t.FontFamily, t.FontStyle, t.FontWeight, t.FontStretch), t.FontSize, System.Windows.Media.Brushes.Black, 1.0);
    }
    // 微型卡片的布局树（类型@x,y；Canvas 向内展开一层）—— 验收时直接贴这条读数
    public string CardLayoutText() {
      var sb = new System.Text.StringBuilder();
      WalkCard(cardBranch, sb);
      return sb.ToString();
    }
    private static void WalkCard(Canvas c, System.Text.StringBuilder sb) {
      if (c == null) return;
      foreach (UIElement e in c.Children) {
        if (sb.Length > 0) sb.Append("；");
        TextBlock t = e as TextBlock;
        if (t != null) sb.Append("TextBlock(\"").Append(t.Text).Append("\")");
        else sb.Append(e.GetType().Name);
        double l = Canvas.GetLeft(e), tp = Canvas.GetTop(e);
        sb.Append("@").Append(double.IsNaN(l) ? "—" : Fmt.Num(Math.Round(l, 1)));
        sb.Append(",").Append(double.IsNaN(tp) ? "—" : Fmt.Num(Math.Round(tp, 1)));
        Canvas cc = e as Canvas;
        if (cc != null) { sb.Append("{"); WalkCard(cc, sb); sb.Append("}"); }
      }
    }

    public string SweepText() {
      var par = Fmt.Num(Geo.RING_SWEEP_MS) + " ms / easeOutCubic；首次渲染不扫；换单位不扫；减少动态效果 → 直接落位";
      if (sweepRuns <= 0) return "本次没发生扫动（读数一次都没变）｜参数：" + par;
      string t = "扫动 " + sweepRuns + " 次 / " + sweepDone + " 个读数跑完｜" + par;
      for (int i = 0; i < sweepTraces.Count && i < 5; i++) t += "｜" + sweepTraces[i];
      if (sweepItems.Count > 0) t += "｜此刻还有 " + sweepItems.Count + " 项在扫";
      return t;
    }

    public string MorphText() {
      if (morphTraces.Count == 0) return "本次没发生形态转换";
      return string.Join("；", morphTraces.ToArray());
    }
  }

  internal static class Sweep {
    // 扫动判据（唯一出处）：首次不扫 / 读不到不扫 / 换单位不扫 / 减少动态效果走瞬时 / 变化小于显示分辨率不扫
    public static SweepPlan Plan(bool hasPrev, double prev, double to, bool known, bool noSweep, bool noAnim, bool hasElement) {
      if (hasElement == false) return SweepPlan.Instant("没有元素可画");
      if (!hasPrev) return SweepPlan.Instant("首次渲染不扫");
      if (!known) return SweepPlan.Instant("读不到（写 — 且不画弧）");
      if (noSweep) return SweepPlan.Instant("换单位不扫（换尺子那一刻跳变是对的）");
      if (noAnim) return SweepPlan.Instant("减少动态效果 → 直接落位");
      if (Math.Abs(to - prev) < Geo.RING_SWEEP_MIN) return SweepPlan.Instant("变化小于显示分辨率（< " + Fmt.Num(Geo.RING_SWEEP_MIN) + "）");
      return SweepPlan.Start(prev, to, Geo.RING_SWEEP_MS);
    }
  }
}
