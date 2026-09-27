// 常驻悬浮看板 —— JSON 读取（唯一出口）
// 用 .NET Framework 自带的 System.Web.Extensions（JavaScriptSerializer），零第三方依赖；
// 实测：C# 5 下编译通过、取值形状如预期（object → Dictionary<string,object> / Int32 / Double / Boolean / null）。
// 纪律：字段缺了就是「读不到」——绝不把 null 当 0（口径表：读不到写「—」，不假装 0）。
using System;
using System.Collections.Generic;
using System.Web.Script.Serialization;

namespace Board {
  internal static class Json {
    private static readonly JavaScriptSerializer Ser = new JavaScriptSerializer {
      MaxJsonLength = 128 * 1024 * 1024,
      RecursionLimit = 128,
    };

    public static object Parse(string text) {
      if (string.IsNullOrEmpty(text)) return null;
      try { return Ser.DeserializeObject(text); } catch { return null; }
    }

    // 从「dashboard-data.js」这类「前面是 JS 赋值、后面是分号」的文件里抠出 JSON 主体
    public static object ParseJsWrap(string raw) {
      if (raw == null) return null;
      int i = raw.IndexOf('{');
      int j = raw.LastIndexOf('}');
      if (i < 0 || j <= i) return null;
      return Parse(raw.Substring(i, j - i + 1));
    }

    public static Dictionary<string, object> Obj(object o) { return o as Dictionary<string, object>; }
    // JSON 数组：JavaScriptSerializer 给的是 object[]（不是 List<object>）——两边都认，不然数组会被当「没有」
    public static List<object> Arr(object o) {
      var l = o as List<object>;
      if (l != null) return l;
      var a = o as object[];
      if (a != null) return new List<object>(a);
      return null;
    }

    public static bool Has(Dictionary<string, object> o, string key) { return o != null && o.ContainsKey(key); }

    public static object Get(Dictionary<string, object> o, string key) {
      if (o == null) return null;
      object v;
      return o.TryGetValue(key, out v) ? v : null;
    }

    public static object Path(object root, params string[] keys) {
      object cur = root;
      for (int i = 0; i < keys.Length; i++) {
        cur = Get(Obj(cur), keys[i]);
        if (cur == null) return null;
      }
      return cur;
    }

    // 数字：非数字 / 布尔 / null 一律 null（坏文件里什么都能出现；布尔不能被当成 0/1）
    public static double? Num(object v) {
      if (v == null || v is bool) return null;
      if (v is int) return (double)(int)v;
      if (v is long) return (double)(long)v;
      if (v is double) return (double)v;
      if (v is decimal) return (double)(decimal)v;
      return null;
    }

    public static long? Long(object v) {
      double? d = Num(v);
      if (!d.HasValue) return null;
      return (long)Math.Round(d.Value);
    }

    public static string Str(object v) {
      if (v == null) return null;
      if (v is string) return (string)v;
      return null;
    }

    public static bool? Bool(object v) {
      if (v is bool) return (bool)v;
      return null;
    }
  }
}
