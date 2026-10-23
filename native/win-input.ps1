# Tether for Windows: turns the iPhone's touches and typing into mouse and keyboard input on the shared screen.
# The Windows counterpart of the input part of phone-display.swift. Windows PowerShell 5.1 (in every Windows 10/11)
# compiles the C# below on start, so nothing needs installing. server.js sends one command per line on stdin,
# already in screen pixels (physical, all monitors): see winInputLine() in server.js.
#
#   click L|R x y | click L|R -     click at a spot (or where the pointer is)
#   down x y | drag x y | up x y    press, move with the button held, release
#   move dx dy                      move the pointer by pixels (trackpad mode)
#   scroll dx dy                    wheel units (120 = one notch); positive dy scrolls up, positive dx right
#   key VK mods                     virtual-key code, mods "ctrl,shift,alt,win" or "-"
#   text BASE64                     type UTF-8 text as Unicode key strokes
#   rect x y w h                    the shared screen; the pointer goes back off it after touches
#   giveback MS | keep              after a touch: return the pointer to the laptop in MS ms / stay put
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class TetherInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public int mouseData; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }

  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  const uint MOVE = 0x1, LDOWN = 0x2, LUP = 0x4, RDOWN = 0x8, RUP = 0x10, WHEEL = 0x800, HWHEEL = 0x1000;
  const uint KEYUP = 0x2, UNICODE = 0x4, EXTENDED = 0x1;

  static readonly object gate = new object();
  static bool buttonDown;
  static int rx, ry, rw, rh;          // the shared screen
  static POINT? touchReturn;         // where the laptop had the pointer before an iPhone touch borrowed it
  static int token;
  static Timer returnTimer;

  static void Mouse(uint flags, int data = 0) {
    var i = new INPUT { type = 0 };
    i.u.mi = new MOUSEINPUT { dwFlags = flags, mouseData = data };
    SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT)));
  }

  static void Key(ushort vk, bool up) {
    var i = new INPUT { type = 1 };
    bool ext = (vk >= 0x21 && vk <= 0x2E) || vk == 0x5B; // arrows, Home/End/PgUp/PgDn, Insert/Delete, Win
    i.u.ki = new KEYBDINPUT { wVk = vk, dwFlags = (up ? KEYUP : 0) | (ext ? EXTENDED : 0) };
    SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT)));
  }

  static void Unicode(char c) {
    foreach (bool up in new[] { false, true }) {
      var i = new INPUT { type = 1 };
      i.u.ki = new KEYBDINPUT { wScan = c, dwFlags = UNICODE | (up ? KEYUP : 0) };
      SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT)));
    }
  }

  static ushort[] Mods(string s) {
    if (s == "-") return new ushort[0];
    var list = new System.Collections.Generic.List<ushort>();
    foreach (var m in s.Split(',')) {
      if (m == "ctrl") list.Add(0x11); else if (m == "shift") list.Add(0x10);
      else if (m == "alt") list.Add(0x12); else if (m == "win") list.Add(0x5B);
    }
    return list.ToArray();
  }

  static bool OnScreen(POINT p) { return rw > 0 && p.x >= rx && p.x < rx + rw && p.y >= ry && p.y < ry + rh; }

  // A touch needs the pointer at that spot; remember where the laptop mouse had it (if it was elsewhere).
  static void Borrow() {
    token++;
    POINT p;
    if (touchReturn == null && GetCursorPos(out p) && !OnScreen(p)) touchReturn = p;
  }

  static void GiveBack(int ms) {
    if (touchReturn == null) return;
    int mine = ++token;
    if (returnTimer != null) returnTimer.Dispose();
    returnTimer = new Timer(_ => {
      lock (gate) {
        if (mine != token || buttonDown || touchReturn == null) return;
        POINT now, back = touchReturn.Value;
        touchReturn = null;
        // Only if the pointer is still on the shared screen: if the laptop mouse already moved it away, leave it.
        if (GetCursorPos(out now) && OnScreen(now)) SetCursorPos(back.x, back.y);
      }
    }, null, ms, Timeout.Infinite);
  }

  static void At(string[] a, int i) {
    if (a.Length > i + 1 && a[i] != "-") SetCursorPos(int.Parse(a[i]), int.Parse(a[i + 1]));
  }

  static void Handle(string[] a) {
    switch (a[0]) {
      case "rect": rx = int.Parse(a[1]); ry = int.Parse(a[2]); rw = int.Parse(a[3]); rh = int.Parse(a[4]); break;
      case "click": {
        bool touched = a[2] != "-";
        if (touched) Borrow();
        At(a, 2);
        bool right = a[1] == "R";
        Mouse(right ? RDOWN : LDOWN);
        Mouse(right ? RUP : LUP);
        GiveBack(400); // long enough for a double tap to land in the same place
        break;
      }
      case "down": Borrow(); At(a, 1); buttonDown = true; Mouse(LDOWN); break;
      case "drag": At(a, 1); break;
      case "up": At(a, 1); Mouse(LUP); buttonDown = false; GiveBack(200); break;
      case "move": {
        token++; touchReturn = null; // trackpad mode moves the pointer on purpose
        POINT p;
        if (GetCursorPos(out p)) SetCursorPos(p.x + int.Parse(a[1]), p.y + int.Parse(a[2]));
        break;
      }
      case "scroll": {
        if (a.Length > 4) { Borrow(); At(a, 3); }
        int dx = int.Parse(a[1]), dy = int.Parse(a[2]);
        if (dy != 0) Mouse(WHEEL, dy);
        if (dx != 0) Mouse(HWHEEL, dx);
        GiveBack(600);
        break;
      }
      case "key": {
        var mods = Mods(a.Length > 2 ? a[2] : "-");
        foreach (var m in mods) Key(m, false);
        ushort vk = ushort.Parse(a[1]);
        Key(vk, false);
        Key(vk, true);
        for (int i = mods.Length - 1; i >= 0; i--) Key(mods[i], true);
        break;
      }
      case "text":
        foreach (char c in Encoding.UTF8.GetString(Convert.FromBase64String(a[1]))) Unicode(c);
        break;
      case "keep": token++; touchReturn = null; break;
      case "giveback": GiveBack(int.Parse(a[1])); break;
    }
  }

  public static void Run() {
    // Physical pixels on every monitor, whatever their scaling: the coordinates server.js sends.
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { SetProcessDPIAware(); }
    Console.Out.WriteLine("{\"type\":\"ready\"}");
    Console.Out.Flush();
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      var a = line.Trim().Split(' ');
      if (a.Length == 0 || a[0] == "") continue;
      lock (gate) {
        try { Handle(a); } catch (Exception e) { Console.Error.WriteLine("win-input: " + e.Message); }
      }
    }
  }
}
'@
[TetherInput]::Run()
