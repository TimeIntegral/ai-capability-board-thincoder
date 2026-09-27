// 常驻悬浮看板 —— 开关与升级事务（用户能关掉、也能再打开；升级时面板让路）
// 开关的真相源是安装目录的 config.json 的 panel.enabled（与 tray.enabled 同一套先例）：
//   缺该字段 = 开（默认开）；关掉 = 面板退出（三处入口都写这个字段，见 程序/tools/panel.mjs）。
// 三处关闭入口（用户已拍板）全部走同一条路：运行协议 → 程序/tools/panel.mjs —— 面板只负责「触发」，不自己改配置。
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace Board {
  internal static class PanelControl {
    public static string ConfigPath() { return Path.Combine(Ctx.RootDir, "config.json"); }

    public static bool PanelEnabled() {
      try {
        string p = ConfigPath();
        if (!File.Exists(p)) return true;         // 读不到配置 = 默认开（不假装用户关过）
        var d = Json.Obj(Json.Parse(Io.ReadAllTextShared(p)));
        if (d == null) return true;
        var panel = Json.Obj(Json.Get(d, "panel"));
        if (panel == null) return true;
        bool? en = Json.Bool(Json.Get(panel, "enabled"));
        return !(en.HasValue && !en.Value);
      } catch { return true; }
    }

    public static bool PanelDisabled() { return !PanelEnabled(); }

    // 第二道保险（照托盘 tray.ps1 的做法）：升级事务文件在 = 马上退出，别占着要换的文件
    public static bool Upgrading() {
      try {
        if (string.IsNullOrEmpty(Ctx.DataRoot)) return false;
        return File.Exists(Path.Combine(Ctx.DataRoot, "data", "upgrade-transaction.json"));
      } catch { return false; }
    }

    // 用户在三处入口里关面板：面板自己不改配置，只把这件事交给唯一的那个工具（程序/tools/panel.mjs）
    public static void RequestDisable() { InvokeProtocol("aiquotaboard://panel?set=off"); }
    public static void RequestEnable() { InvokeProtocol("aiquotaboard://panel?set=on"); }

    public static void InvokeProtocol(string url) {
      try {
        if (string.IsNullOrEmpty(Ctx.RootDir)) return;
        string vbs = Path.Combine(Ctx.RootDir, "程序", "运行协议.vbs");
        if (!File.Exists(vbs)) return;
        var psi = new ProcessStartInfo();
        psi.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "wscript.exe");
        psi.Arguments = "\"" + vbs + "\" \"" + url + "\"";
        psi.WorkingDirectory = Ctx.RootDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        Process.Start(psi);
      } catch { }
    }

    public static string ReadText(string path) {
      try { return File.Exists(path) ? Io.ReadAllTextShared(path) : null; } catch { return null; }
    }

    public static Encoding Utf8NoBom { get { return new UTF8Encoding(false); } }
  }
}
