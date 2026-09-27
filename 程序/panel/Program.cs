// 常驻悬浮看板 —— 入口（单实例 / DPI 声明 / 开关校验 / 自检出口）
using System;
using System.IO;
using System.Threading;
using System.Windows;

namespace Board {
  internal static class Program {
    public static bool ForceNoAnim;
    public static string StartEdge = "right";
    public static double StartAnchor = -1;
    public static double StartCardX = -1, StartCardY = -1;
    public static string LogPath = "";
    public static string ArgLine = "";

    public static void Log(string line) {
      if (string.IsNullOrEmpty(LogPath)) return;
      try { File.AppendAllText(LogPath, line + "\r\n", PanelControl.Utf8NoBom); } catch { }
    }

    [STAThread]
    public static int Main(string[] args) {
      ArgLine = string.Join(" ", args);
      bool selftest = false, selftestUi = false;
      string data = "", root = "", state = "", form = "medium";
      int seconds = 0;
      for (int i = 0; i < args.Length; i++) {
        string a = args[i];
        if (a == "--selftest") selftest = true;
        else if (a == "--selftest-ui") selftestUi = true;
        else if (a == "--no-anim") ForceNoAnim = true;
        else if (a == "--data") data = Next(args, ref i);
        else if (a == "--root") root = Next(args, ref i);
        else if (a == "--state") state = Next(args, ref i);
        else if (a == "--form") form = Next(args, ref i);
        else if (a == "--edge") StartEdge = Next(args, ref i);
        else if (a == "--anchor") StartAnchor = ParseD(Next(args, ref i), -1);
        else if (a == "--cardx") StartCardX = ParseD(Next(args, ref i), -1);
        else if (a == "--cardy") StartCardY = ParseD(Next(args, ref i), -1);
        else if (a == "--seconds") seconds = (int)ParseD(Next(args, ref i), 0);
        else if (a == "--log") LogPath = Next(args, ref i);
        else if (a == "--help") { Console.WriteLine(Usage()); return 0; }
        else { Console.Error.WriteLine("不认识的参数：" + a + "\r\n" + Usage()); return 2; }
      }

      Native.SetProcessDPIAware();   // 150% 缩放下不声明 → 取点全错（踩过）
      try { Console.SetError(Utf8Out()); } catch { }
      Ctx.StatePath = string.IsNullOrEmpty(state) ? Ctx.DefaultStatePath() : Path.GetFullPath(state);
      Ctx.RootDir = string.IsNullOrEmpty(root) ? ExeRoot() : Path.GetFullPath(root);
      Ctx.DataRoot = string.IsNullOrEmpty(data) ? Ctx.RootDir : Path.GetFullPath(data);

      try {
        if (selftest) { return SelfTest.Run(Utf8Out(), Ctx.DataRoot); }
        if (selftestUi) return SelfTest.RunUi(data, root, state, seconds > 0 ? seconds : 0, Utf8Out());
        // 开关：用户在页面/托盘/右键里关掉之后，开机自启与快捷入口都不该再把它拉起来
        if (PanelControl.PanelDisabled()) { Console.Error.WriteLine("悬浮看板已在配置里关闭（config.json 的 panel.enabled=false）。"); return 0; }

        bool created;
        using (var mutex = new Mutex(true, @"Local\AICapabilityBoard-Panel", out created)) {
          if (!created) {
            SignalShow();
            Console.Error.WriteLine("悬浮看板已在运行：已唤出已有面板。");
            return 0;
          }
          var app = new Application();
          app.ShutdownMode = ShutdownMode.OnMainWindowClose;
          var metrics = Metrics.Primary();
          var model = Model.Build();
          var win = new PanelWindow(metrics, model, form != "micro");
          win.Loaded += delegate {
            StartShowListener(win);
            if (seconds > 0) {
              var t = new System.Windows.Threading.DispatcherTimer();
              t.Interval = TimeSpan.FromSeconds(seconds);
              t.Tick += delegate { t.Stop(); win.ExitNow(); };
              t.Start();
            }
            if (!string.IsNullOrEmpty(LogPath)) Log("started " + ArgLine);
          };
          app.Run(win);
        }
        return 0;
      } catch (Exception ex) {
        try {
          Console.SetError(Utf8Out());
          if (!string.IsNullOrEmpty(LogPath)) Log("fatal " + ex);
          Console.Error.WriteLine("悬浮看板启动失败：" + ex.Message);
        } catch { }
        return 1;
      }
    }

    // 自检输出一律 UTF-8：控制台代码页（GBK）会把读数行的中文打死，测试脚本按 UTF-8 读
    private static TextWriter Utf8Out() {
      try {
        var sw = new StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false));
        sw.AutoFlush = true;
        return sw;
      } catch { return Console.Out; }
    }

    private static string Usage() {
      return "board.exe [--selftest] [--selftest-ui] [--data <目录>] [--root <目录>] [--state <文件>]\r\n"
           + "          [--form medium|micro] [--edge right|left|top|bottom] [--anchor <DIP>]\r\n"
           + "          [--cardx <DIP>] [--cardy <DIP>] [--seconds <n>] [--no-anim] [--log <文件>]";
    }

    private static string Next(string[] args, ref int i) {
      if (i + 1 >= args.Length) return "";
      i++;
      return args[i];
    }
    private static double ParseD(string s, double fallback) {
      double v;
      return double.TryParse(s, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out v) ? v : fallback;
    }

    private static string ExeRoot() {
      try {
        var d = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);   // …\程序\bin\
        if (d.Parent != null && d.Parent.Parent != null) return d.Parent.Parent.FullName;
        return d.FullName;
      } catch { return ""; }
    }

    private static void SignalShow() {
      try {
        EventWaitHandle ev;
        if (EventWaitHandle.TryOpenExisting(@"Local\AICapabilityBoard-Panel-Show", out ev)) {
          using (ev) ev.Set();
        }
      } catch { }
    }

    private static void StartShowListener(PanelWindow win) {
      var ev = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\AICapabilityBoard-Panel-Show");
      var th = new Thread(delegate () {
        while (true) {
          ev.WaitOne();
          try { win.Dispatcher.Invoke(new Action(delegate { win.Peek(); })); } catch { return; }
        }
      });
      th.IsBackground = true;
      th.Start();
    }
  }
}
