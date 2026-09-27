// 常驻悬浮看板 —— 位置记忆（状态文件在用户数据目录，不写仓库、不写安装目录）
// 读的纪律：文件缺失 / 坏 JSON / 字段不合法 → 一律「没有记录」（回默认位置）：不抛异常、不弹窗、不写回、不假装读到了。
// 写的纪律：值没变不写（sig 去重）、临时文件 + 替换、**永不出错**（写不进去 = 位置记忆失效，不影响上屏）。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace Board {
  internal sealed class StateRec {
    public bool ok; public string why = "", path = "";
    public string form = ""; public string edge = ""; public double anchor = -1.0;
    public double microX = -1.0, microY = -1.0;
  }

  internal static class PanelState {
    private const int Schema = 1;
    private static string savedSig = "";
    private static Dictionary<string, string> slots = new Dictionary<string, string>();   // edge/anchor 与 x/y 两个槽（读改写）

    public static string Path_ {
      get { return string.IsNullOrEmpty(Ctx.StatePath) ? Ctx.DefaultStatePath() : Ctx.StatePath; }
    }

    private static bool Num(object v) {
      if (v == null || v is bool) return false;
      return v is int || v is long || v is double || v is decimal;
    }
    private static double? Dbl(object v) {
      if (!Num(v)) return null;
      return Convert.ToDouble(v, CultureInfo.InvariantCulture);
    }

    public static StateRec Load(string path) {
      var o = new StateRec();
      o.path = string.IsNullOrEmpty(path) ? Path_ : path;
      if (!File.Exists(o.path)) { o.why = "没有状态文件（头一回跑 / 已被删）"; return o; }
      string raw;
      try { raw = File.ReadAllText(o.path, Encoding.UTF8); } catch { o.why = "状态文件读不出来"; return o; }
      if (string.IsNullOrWhiteSpace(raw)) { o.why = "状态文件是空的（坏了）"; return o; }
      var d = Json.Obj(Json.Parse(raw));
      if (d == null) { o.why = "状态文件不是合法 JSON（坏了）"; return o; }
      string form = Json.Str(Json.Get(d, "form"));
      if (form != "medium" && form != "micro") { o.why = "状态文件里没有可用的形态（坏了）"; return o; }
      var md = Json.Obj(Json.Get(d, "medium"));
      var mc = Json.Obj(Json.Get(d, "micro"));
      if (md != null) {
        string e = Json.Str(Json.Get(md, "edge"));
        double? a = Dbl(Json.Get(md, "anchor"));
        if (e != null && (e == "right" || e == "left" || e == "top" || e == "bottom") && a.HasValue && a.Value >= 0.0) {
          o.edge = e; o.anchor = a.Value;
        }
      }
      if (mc != null) {
        double? x = Dbl(Json.Get(mc, "x")), y = Dbl(Json.Get(mc, "y"));
        if (x.HasValue && y.HasValue && x.Value >= 0.0 && y.Value >= 0.0) { o.microX = x.Value; o.microY = y.Value; }
      }
      if (string.IsNullOrEmpty(o.edge) && o.microX < 0.0) { o.why = "状态文件里两个形态的落点都不合法（坏了）"; return o; }
      o.form = form; o.ok = true; o.why = "读到状态文件";
      return o;
    }

    private static string Sig(PanelWindow w) {
      string med = w.Form == "medium" ? (w.Edge + "|" + Fmt.Num(Math.Round(w.Anchor, 1))) : "";
      string mic = w.Form == "micro" ? (Fmt.Num(Math.Round(w.CardX, 1)) + "|" + Fmt.Num(Math.Round(w.CardY, 1))) : "";
      return w.Form + "|" + med + "|" + mic;
    }

    public static bool Save(PanelWindow w, bool force) {
      if (w == null || string.IsNullOrEmpty(w.Form)) return false;
      if (w.Form == "medium" && !string.IsNullOrEmpty(w.Edge) && w.Anchor >= 0.0)
        slots["medium"] = w.Edge + "|" + Fmt.Num(Math.Round(w.Anchor, 1));
      else if (w.Form == "micro" && w.CardX >= 0.0)
        slots["micro"] = Fmt.Num(Math.Round(w.CardX, 1)) + "|" + Fmt.Num(Math.Round(w.CardY, 1));
      string sig = Sig(w);
      if (!force && savedSig == sig) return false;
      string edge = ""; double anchor = -1.0, mx = -1.0, my = -1.0;
      string med;
      if (slots.TryGetValue("medium", out med)) {
        string[] parts = med.Split('|');
        if (parts.Length == 2) {
          edge = parts[0];
          double a;
          if (double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out a)) anchor = a;
        }
      }
      string mic;
      if (slots.TryGetValue("micro", out mic)) {
        string[] parts = mic.Split('|');
        if (parts.Length == 2) {
          double a, b;
          if (double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out a)) mx = a;
          if (double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out b)) my = b;
        }
      }
      var sb = new StringBuilder();
      sb.Append("{\n");
      sb.Append("  \"schema\": ").Append(Schema).Append(",\n");
      sb.Append("  \"note\": \"这个文件记的是悬浮看板上次的形态与落点（删掉它 = 回到默认位置）；它在用户数据目录里，不在仓库也不在安装目录。\",\n");
      sb.Append("  \"updatedAtMs\": ").Append(Fmt.NowMs()).Append(",\n");
      sb.Append("  \"form\": \"").Append(w.Form).Append("\",\n");
      sb.Append("  \"medium\": { \"edge\": \"").Append(edge).Append("\", \"anchor\": ").Append(anchor.ToString("0.###", CultureInfo.InvariantCulture)).Append(" },\n");
      sb.Append("  \"micro\": { \"x\": ").Append(mx.ToString("0.###", CultureInfo.InvariantCulture)).Append(", \"y\": ").Append(my.ToString("0.###", CultureInfo.InvariantCulture)).Append(" },\n");
      sb.Append("  \"screen\": { \"pxW\": ").Append(w.M.pxW.ToString("0.#", CultureInfo.InvariantCulture))
        .Append(", \"pxH\": ").Append(w.M.pxH.ToString("0.#", CultureInfo.InvariantCulture))
        .Append(", \"dpi\": ").Append(w.M.dpi.ToString("0.#", CultureInfo.InvariantCulture))
        .Append(", \"dipW\": ").Append(Math.Round(w.M.dipW, 1).ToString("0.#", CultureInfo.InvariantCulture))
        .Append(", \"dipH\": ").Append(Math.Round(w.M.dipH, 1).ToString("0.#", CultureInfo.InvariantCulture))
        .Append(", \"scope\": \"primary\" }\n}\n");
      string path = Path_;
      try {
        string dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
        string tmp = path + ".tmp";
        File.WriteAllText(tmp, sb.ToString(), new UTF8Encoding(false));
        if (File.Exists(path)) {
          try { File.Replace(tmp, path, null); }
          catch { File.Copy(tmp, path, true); File.Delete(tmp); }
        } else File.Move(tmp, path);
        savedSig = sig;
        return true;
      } catch { return false; }   // 写不进去：不抛、不弹窗 —— 位置记忆失效但不影响上屏
    }
  }
}
