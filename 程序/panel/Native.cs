// 常驻悬浮看板 —— 原生 API 与屏幕度量（唯一出处）
// 为什么必须自己声明 DPI 感知：150% 缩放下不声明的话 GetCursorPos / 窗口矩形拿到的是「虚拟化」坐标，
// 屏幕取点会全部取错地方（原型与栈探针都踩过这条，见设计档 2.2.3 的坐标口径行）。
using System;
using System.Runtime.InteropServices;

namespace Board {
  [StructLayout(LayoutKind.Sequential)]
  internal struct POINT { public int X; public int Y; }

  internal static class Native {
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TRANSPARENT = 0x00000020;
    public const int WS_EX_LAYERED = 0x00080000;
    public const int WS_EX_NOACTIVATE = 0x08000000;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_FRAMECHANGED = 0x0020;
    public const int VK_LBUTTON = 0x01;
    public const uint SPI_GETCLIENTAREAANIMATION = 0x1042;
    public const int LOGPIXELSX = 88;
    public const int SM_CXSCREEN = 0, SM_CYSCREEN = 1;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, ref int pvParam, uint fWinIni);
    [DllImport("user32.dll")]
    public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);
    [DllImport("gdi32.dll")]
    public static extern int GetDeviceCaps(IntPtr hdc, int nIndex);

    public static bool LeftDown() { return (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0; }

    // 「减少动态效果」：读的是 设置 → 辅助功能 → 视觉效果 → 动画效果（SPI_GETCLIENTAREAANIMATION）。
    // 读不到（API 失败）→ 按「允许动画」处理，绝不在读不到的时候假装系统关了动画。
    public static bool ReduceMotion(bool forced) {
      if (forced) return true;
      int v = 0;
      bool ok = false;
      try { ok = SystemParametersInfo(SPI_GETCLIENTAREAANIMATION, 0, ref v, 0); } catch { ok = false; }
      if (!ok) return false;
      return v == 0;
    }
  }

  // 屏幕度量（唯一出处）：px = 物理像素，dip = 设备无关单位；两者只在轮询 / 窗口 API 边界上换算
  internal sealed class Metrics {
    public double pxW, pxH, dipW, dipH, dpi, scale;
    public static Metrics Primary() {
      var m = new Metrics();
      m.pxW = Native.GetSystemMetrics(Native.SM_CXSCREEN);
      m.pxH = Native.GetSystemMetrics(Native.SM_CYSCREEN);
      int dpi = 96;
      IntPtr dc = Native.GetDC(IntPtr.Zero);
      if (dc != IntPtr.Zero) {
        int v = Native.GetDeviceCaps(dc, Native.LOGPIXELSX);
        Native.ReleaseDC(IntPtr.Zero, dc);
        if (v > 0) dpi = v;
      }
      m.dpi = dpi;
      m.scale = dpi / 96.0;
      if (m.scale <= 0) m.scale = 1.0;
      m.dipW = m.pxW / m.scale;
      m.dipH = m.pxH / m.scale;
      return m;
    }
    public static Metrics Fake(double pxW, double pxH, double scale) {
      var m = new Metrics();
      m.pxW = pxW; m.pxH = pxH; m.scale = scale; m.dpi = scale * 96.0;
      m.dipW = pxW / scale; m.dipH = pxH / scale;
      return m;
    }
  }
}
