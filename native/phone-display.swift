// phone-display: adds a virtual "iPhone" monitor to macOS that you use with the laptop's own
// mouse and keyboard (it works like an external monitor; the iPhone shows it).
// Also: a shortcut (default ⌘P, changeable) jumps the cursor between laptop and iPhone screen, a badge on the laptop shows when
// the cursor is on the iPhone screen, and optional input injection for iPhone touch control.
//
// Usage: phone-display <widthPoints> <heightPoints> [right|left|above] [jump shortcut, e.g. cmd+P] [center shortcut, e.g. cmd+O]
// stdout: one JSON line per event, e.g. {"type":"ready","displayID":25,"bounds":{...},"accessibility":true}
// stdin:  one JSON command per line (see handle(_:) below). The display is removed on stdin EOF.
import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

// Run as a background app (no Dock icon) so the hotkey and badge window work.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj),
        let line = String(data: data, encoding: .utf8) else { return }
  print(line)
}

let args = CommandLine.arguments
let widthPt = UInt32(args.count > 1 ? args[1] : "") ?? 1280
let heightPt = UInt32(args.count > 2 ? args[2] : "") ?? 590
let position = args.count > 3 ? args[3] : "right"
let initialHotKeys = ["jump": args.count > 4 ? args[4] : "cmd+P", "center": args.count > 5 ? args[5] : "cmd+O"]

// ---- Virtual display ----
let descriptor = CGVirtualDisplayDescriptor()
descriptor.queue = DispatchQueue.main
descriptor.name = "iPhone Screen"
descriptor.maxPixelsWide = widthPt * 2
descriptor.maxPixelsHigh = heightPt * 2
// Physical size of a ~6" phone screen, in the same shape as the requested size (landscape or portrait).
let longSide = Double(max(widthPt, heightPt))
descriptor.sizeInMillimeters = CGSize(width: 140 * Double(widthPt) / longSide, height: 140 * Double(heightPt) / longSide)
descriptor.productID = 0x1A2B
descriptor.vendorID = 0x3C4D
descriptor.serialNum = 0x0001
descriptor.terminationHandler = { _, _ in
  emit(["type": "error", "error": "display terminated by system"])
  exit(1)
}

guard let display = CGVirtualDisplay(descriptor: descriptor) else {
  emit(["type": "error", "error": "could not create virtual display"])
  exit(1)
}
let settings = CGVirtualDisplaySettings()
settings.hiDPI = 1
settings.modes = [
  CGVirtualDisplayMode(width: widthPt * 2, height: heightPt * 2, refreshRate: 60)!,
  CGVirtualDisplayMode(width: widthPt, height: heightPt, refreshRate: 60)!,
]
guard display.apply(settings) else {
  emit(["type": "error", "error": "could not apply display settings"])
  exit(1)
}
let displayID = CGDirectDisplayID(display.displayID)

// Prefer the HiDPI mode (widthPt points backed by 2x pixels) so text is sharp on the iPhone.
func selectHiDPIMode() {
  let options = [kCGDisplayShowDuplicateLowResolutionModes: kCFBooleanTrue] as CFDictionary
  guard let modes = CGDisplayCopyAllDisplayModes(displayID, options) as? [CGDisplayMode] else { return }
  if let mode = modes.first(where: { $0.width == Int(widthPt) && $0.pixelWidth == Int(widthPt) * 2 }) {
    CGDisplaySetDisplayMode(displayID, mode, nil)
  }
}

// Put the iPhone screen next to the laptop screen, on the side where the phone physically sits.
func placeDisplay() {
  let main = CGDisplayBounds(CGMainDisplayID())
  let w = Int32(widthPt), h = Int32(heightPt)
  let origin: (Int32, Int32)
  switch position {
  case "left": origin = (Int32(main.minX) - w, Int32(main.minY))
  case "above": origin = (Int32(main.midX) - w / 2, Int32(main.minY) - h)
  default: origin = (Int32(main.maxX), Int32(main.minY))
  }
  var config: CGDisplayConfigRef?
  guard CGBeginDisplayConfiguration(&config) == .success else { return }
  CGConfigureDisplayOrigin(config, displayID, origin.0, origin.1)
  CGCompleteDisplayConfiguration(config, .forSession)
}

var bounds = CGRect.zero

func reportReady() {
  bounds = CGDisplayBounds(displayID)
  emit([
    "type": "ready",
    "displayID": Int(displayID),
    "bounds": ["x": bounds.origin.x, "y": bounds.origin.y, "width": bounds.width, "height": bounds.height],
    "accessibility": AXIsProcessTrusted(),
  ])
}

// ---- Input injection ----
let keyCodes: [String: CGKeyCode] = [
  "Enter": 36, "Tab": 48, "Space": 49, "Backspace": 51, "Escape": 53, "Delete": 117,
  "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
  "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121,
]
// ANSI key codes so modifier shortcuts like ⌘S work (they match on key code, not text).
let charKeyCodes: [Character: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
  "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
  "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
  "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46,
  ".": 47, "`": 50, " ": 49,
]

var buttonDown = false
var lastClick = (time: Date.distantPast, point: CGPoint.zero, count: Int64(0))

func toGlobal(_ x: Double, _ y: Double) -> CGPoint {
  CGPoint(
    x: bounds.minX + min(max(x, 0), 1) * (bounds.width - 1),
    y: bounds.minY + min(max(y, 0), 1) * (bounds.height - 1))
}

func cursor() -> CGPoint { CGEvent(source: nil)?.location ?? CGPoint(x: bounds.midX, y: bounds.midY) }

func clampToDisplay(_ p: CGPoint) -> CGPoint {
  CGPoint(x: min(max(p.x, bounds.minX), bounds.maxX - 1), y: min(max(p.y, bounds.minY), bounds.maxY - 1))
}

func mouse(_ type: CGEventType, _ p: CGPoint, button: CGMouseButton = .left, clicks: Int64 = 1) {
  let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: button)
  e?.setIntegerValueField(.mouseEventClickState, value: clicks)
  e?.post(tap: .cghidEventTap)
}

func clickCount(at p: CGPoint) -> Int64 {
  let now = Date()
  let near = hypot(p.x - lastClick.point.x, p.y - lastClick.point.y) < 12
  let count: Int64 = (now.timeIntervalSince(lastClick.time) < 0.45 && near) ? min(lastClick.count + 1, 3) : 1
  lastClick = (now, p, count)
  return count
}

func click(_ p: CGPoint, button: CGMouseButton = .left) {
  let (down, up): (CGEventType, CGEventType) = button == .right ? (.rightMouseDown, .rightMouseUp) : (.leftMouseDown, .leftMouseUp)
  let n = button == .right ? 1 : clickCount(at: p)
  mouse(.mouseMoved, p)
  mouse(down, p, button: button, clicks: n)
  mouse(up, p, button: button, clicks: n)
}

func flags(_ mods: [String]) -> CGEventFlags {
  var f = CGEventFlags()
  for m in mods {
    switch m {
    case "cmd": f.insert(.maskCommand)
    case "ctrl": f.insert(.maskControl)
    case "alt": f.insert(.maskAlternate)
    case "shift": f.insert(.maskShift)
    default: break
    }
  }
  return f
}

func key(_ code: CGKeyCode, mods: [String]) {
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
    e?.flags = flags(mods)
    e?.post(tap: .cghidEventTap)
  }
}

func typeText(_ text: String, mods: [String]) {
  for ch in text {
    if !mods.isEmpty, let code = charKeyCodes[Character(ch.lowercased())] {
      key(code, mods: mods)
      continue
    }
    let units = Array(String(ch).utf16)
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
      e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
      e?.post(tap: .cghidEventTap)
    }
  }
}

func scroll(dx: Double, dy: Double) {
  let e = CGEvent(
    scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
    wheel1: Int32((dy * bounds.height).rounded()), wheel2: Int32((dx * bounds.width).rounded()), wheel3: 0)
  e?.post(tap: .cghidEventTap)
}

// x/y are 0..1 within the virtual display; dx/dy are fractions of its width/height.
func handle(_ cmd: [String: Any]) {
  let num = { (k: String) in (cmd[k] as? NSNumber)?.doubleValue }
  let point = { () -> CGPoint in
    if let x = num("x"), let y = num("y") { return toGlobal(x, y) }
    return clampToDisplay(cursor())
  }
  let mods = cmd["mods"] as? [String] ?? []

  switch cmd["t"] as? String {
  case "click": click(point())
  case "rightclick": click(point(), button: .right)
  case "down":
    let p = point()
    buttonDown = true
    mouse(.mouseMoved, p)
    mouse(.leftMouseDown, p, clicks: clickCount(at: p))
  case "drag":
    mouse(buttonDown ? .leftMouseDragged : .mouseMoved, point())
  case "up":
    mouse(.leftMouseUp, point(), clicks: lastClick.count)
    buttonDown = false
  case "move":
    let c = clampToDisplay(cursor())
    let p = clampToDisplay(CGPoint(x: c.x + (num("dx") ?? 0) * bounds.width, y: c.y + (num("dy") ?? 0) * bounds.height))
    mouse(buttonDown ? .leftMouseDragged : .mouseMoved, p)
  case "scroll":
    if num("x") != nil { mouse(.mouseMoved, point()) }
    scroll(dx: num("dx") ?? 0, dy: num("dy") ?? 0)
  case "key":
    if let name = cmd["k"] as? String, let code = keyCodes[name] { key(code, mods: mods) }
  case "text":
    if let text = cmd["s"] as? String { typeText(text, mods: mods) }
  case "status":
    reportReady()
  case "axprompt":
    // Shows macOS's "would like to control this computer" prompt with a button to Accessibility settings.
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
    reportReady()
  case "home":
    bringCursorHome()
  case "hotkey":
    if let spec = cmd["spec"] as? String { setHotKey(cmd["name"] as? String ?? "jump", spec) }
  default:
    break
  }
}

// ---- Laptop mouse/keyboard on the iPhone screen ----
// The cursor disappears from the laptop when it moves onto the iPhone screen (only the iPhone shows it),
// so: a badge on the laptop screen while it's there, a shortcut to jump back and forth, and "home" to return it.
var lastLaptopPoint: CGPoint?
var lastPhonePoint: CGPoint?
var cursorOnPhone = false

func mainDisplayCenter() -> CGPoint {
  let b = CGDisplayBounds(CGMainDisplayID())
  return CGPoint(x: b.midX, y: b.midY)
}

func warp(_ p: CGPoint) {
  CGWarpMouseCursorPosition(p)
  CGAssociateMouseAndMouseCursorPosition(1)
}

func toggleCursor() {
  let p = cursor()
  if bounds.contains(p) {
    lastPhonePoint = p
    warp(lastLaptopPoint ?? mainDisplayCenter())
  } else {
    lastLaptopPoint = p
    warp(lastPhonePoint.map(clampToDisplay) ?? CGPoint(x: bounds.midX, y: bounds.midY))
  }
}

func bringCursorHome() {
  let p = cursor()
  guard bounds.contains(p) else { return }
  lastPhonePoint = p
  warp(lastLaptopPoint ?? mainDisplayCenter())
}

let badgeLabel = NSTextField(labelWithString: "")

func setBadgeText(_ shortcut: String) {
  badgeLabel.stringValue = "Cursor is on the iPhone screen\n\(shortcut) brings it back"
}

let badge: NSPanel = {
  let size = NSSize(width: 250, height: 54)
  let panel = NSPanel(
    contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel],
    backing: .buffered, defer: false)
  panel.level = .statusBar
  panel.isOpaque = false
  panel.backgroundColor = .clear
  panel.hasShadow = true
  panel.ignoresMouseEvents = true
  panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
  let box = NSView(frame: NSRect(origin: .zero, size: size))
  box.wantsLayer = true
  box.layer?.backgroundColor = NSColor(white: 0.08, alpha: 0.88).cgColor
  box.layer?.cornerRadius = 12
  let label = badgeLabel
  label.textColor = .white
  label.font = .systemFont(ofSize: 13, weight: .medium)
  label.alignment = .center
  label.maximumNumberOfLines = 2
  label.frame = NSRect(x: 8, y: 9, width: size.width - 16, height: 36)
  box.addSubview(label)
  panel.contentView = box
  return panel
}()

// Pin the badge to the edge of the laptop screen that faces the iPhone screen.
func placeBadge() {
  guard let screen = NSScreen.screens.first(where: { $0.frame.origin == .zero }) ?? NSScreen.main else { return }
  let f = screen.visibleFrame, s = badge.frame.size
  let origin: NSPoint
  switch position {
  case "left": origin = NSPoint(x: f.minX + 12, y: f.midY - s.height / 2)
  case "above": origin = NSPoint(x: f.midX - s.width / 2, y: f.maxY - s.height - 12)
  default: origin = NSPoint(x: f.maxX - s.width - 12, y: f.midY - s.height / 2)
  }
  badge.setFrameOrigin(origin)
}

func watchCursor() {
  Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { _ in
    bounds = CGDisplayBounds(displayID) // follows changes made in System Settings → Displays
    let onPhone = bounds.contains(cursor())
    guard onPhone != cursorOnPhone else { return }
    cursorOnPhone = onPhone
    setSystemCursorHidden(onPhone)
    if onPhone {
      placeBadge()
      badge.orderFrontRegardless()
      lastCursorImage = nil // resend the shape for the phone
    } else {
      badge.orderOut(nil)
    }
    emit(["type": "cursor", "onPhone": onPhone])
  }
  streamCursorPosition()
}

// Low-latency cursor for the phone: the phone draws the cursor itself from these positions instead of
// waiting for it to show up in the video (capture → encode → network → decode adds a lot of delay).
// Event-driven via a global mouse monitor (no permission needed for mouse events), plus a 60 Hz poll
// to catch warps and other changes that don't produce mouse events.
var lastSentPos: (x: Int, y: Int)? = nil
var sentOff = false

func sendCursorPosition() {
  let p = cursor()
  guard bounds.width > 0, bounds.contains(p) else {
    if !sentOff { emit(["type": "pos", "off": true]) }
    sentOff = true
    lastSentPos = nil
    return
  }
  // 1/10000 of the screen is far below one pixel; skip duplicates.
  let x = Int(((p.x - bounds.minX) / bounds.width * 10000).rounded())
  let y = Int(((p.y - bounds.minY) / bounds.height * 10000).rounded())
  if let last = lastSentPos, last == (x, y) { return }
  lastSentPos = (x, y)
  sentOff = false
  print("{\"type\":\"pos\",\"x\":\(x),\"y\":\(y)}")
}

// While the cursor is on the iPhone screen nobody sees it on the laptop anyway; hiding the system
// cursor keeps it out of the captured video, so the phone's instant cursor is the only one.
// Calls are balanced (hide/show are counted); the window server shows it again if this process dies.
var systemCursorHidden = false
let backgroundCursorAllowed: Bool = {
  CGSSetConnectionProperty(_CGSDefaultConnection(), _CGSDefaultConnection(), "SetsCursorInBackground" as CFString, kCFBooleanTrue) == .success
}()

func setSystemCursorHidden(_ hidden: Bool) {
  guard backgroundCursorAllowed, hidden != systemCursorHidden else { return }
  systemCursorHidden = hidden
  if hidden { CGDisplayHideCursor(CGMainDisplayID()) } else { CGDisplayShowCursor(CGMainDisplayID()) }
}

// The phone draws the real cursor shape (I-beam over text, hand over links, resize arrows…).
var lastCursorImage: Data?

func sendCursorImage() {
  guard cursorOnPhone, let current = NSCursor.currentSystem,
        let tiff = current.image.tiffRepresentation, tiff != lastCursorImage,
        let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else { return }
  lastCursorImage = tiff
  emit([
    "type": "cursorimg", "png": png.base64EncodedString(),
    "w": current.image.size.width, "h": current.image.size.height,
    "hx": current.hotSpot.x, "hy": current.hotSpot.y,
  ])
}

func streamCursorPosition() {
  Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in sendCursorImage() }
  NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]) { _ in
    sendCursorPosition()
  }
  Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { _ in sendCursorPosition() }
}

// ---- The jump shortcut ----
// Spec format: modifiers and one key joined by "+", e.g. "cmd+P", "ctrl+alt+Space", "cmd+shift+F5".
// Registered as a system-wide hotkey (Carbon), which needs no permission and swallows the key press.
var hotKeyRef: EventHotKeyRef?
let functionKeyCodes: [String: Int] = [
  "F1": kVK_F1, "F2": kVK_F2, "F3": kVK_F3, "F4": kVK_F4, "F5": kVK_F5, "F6": kVK_F6,
  "F7": kVK_F7, "F8": kVK_F8, "F9": kVK_F9, "F10": kVK_F10, "F11": kVK_F11, "F12": kVK_F12,
  "Space": kVK_Space,
]

func parseHotKey(_ spec: String) -> (code: UInt32, mods: UInt32, label: String)? {
  let parts = spec.split(separator: "+").map(String.init)
  guard let key = parts.last, parts.count >= 2 else { return nil }
  var mods: UInt32 = 0
  var label = ""
  // macOS writes modifiers in this order: ⌃⌥⇧⌘
  for (name, flag, symbol) in [("ctrl", controlKey, "⌃"), ("alt", optionKey, "⌥"), ("shift", shiftKey, "⇧"), ("cmd", cmdKey, "⌘")]
  where parts.dropLast().contains(name) {
    mods |= UInt32(flag)
    label += symbol
  }
  guard mods & UInt32(cmdKey | controlKey | optionKey) != 0 else { return nil }
  let code: Int
  if let fn = functionKeyCodes[key] {
    code = fn
  } else if key.count == 1, let c = charKeyCodes[Character(key.lowercased())] {
    code = Int(c)
  } else {
    return nil
  }
  return (UInt32(code), mods, label + (key == "Space" ? "Space" : key.uppercased()))
}

// Two shortcuts, told apart by the id they're registered with:
//   jump   (default ⌘P): cursor back and forth between the laptop and the iPhone screen
//   center (default ⌘O): cursor to the middle of the iPhone screen
let hotKeyIDs: [String: UInt32] = ["jump": 1, "center": 2]
var hotKeyRefs: [String: EventHotKeyRef] = [:]
var hotKeySpecs: [String: String] = [:]

func centerCursorOnPhone() {
  let p = cursor()
  if !bounds.contains(p) { lastLaptopPoint = p }
  warp(CGPoint(x: bounds.midX, y: bounds.midY))
}

func installHotKeyHandler() {
  var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
  InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
    var id = EventHotKeyID()
    GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                      MemoryLayout<EventHotKeyID>.size, nil, &id)
    DispatchQueue.main.async { id.id == hotKeyIDs["center"] ? centerCursorOnPhone() : toggleCursor() }
    return noErr
  }, 1, &spec, nil, nil)
}

// Replaces one shortcut. On failure the old one stays active.
func setHotKey(_ name: String, _ spec: String) {
  guard let number = hotKeyIDs[name] else { return }
  guard let parsed = parseHotKey(spec) else {
    return emit(["type": "hotkey", "name": name, "ok": false, "spec": spec, "error": "not a valid shortcut"])
  }
  if let (other, _) = hotKeySpecs.first(where: { $0.key != name && $0.value == spec }) {
    return emit(["type": "hotkey", "name": name, "ok": false, "spec": spec, "error": "it's already the \(other) shortcut"])
  }
  var newRef: EventHotKeyRef?
  let id = EventHotKeyID(signature: OSType(0x5048_4F4E), id: number) // "PHON"
  let previous = hotKeyRefs[name]
  if let previous { UnregisterEventHotKey(previous) }
  let status = RegisterEventHotKey(parsed.code, parsed.mods, id, GetApplicationEventTarget(), 0, &newRef)
  guard status == noErr, let newRef else {
    hotKeyRefs[name] = nil
    if previous != nil, let current = hotKeySpecs[name] { setHotKey(name, current) } // put the old one back
    return emit(["type": "hotkey", "name": name, "ok": false, "spec": spec, "error": "another app already uses \(parsed.label)"])
  }
  hotKeyRefs[name] = newRef
  hotKeySpecs[name] = spec
  if name == "jump" { setBadgeText(parsed.label) }
  emit(["type": "hotkey", "name": name, "ok": true, "spec": spec, "label": parsed.label])
}

// ---- Main ----
// macOS reconfigures displays asynchronously; only report ready once bounds stop changing.
func waitUntilStable(previous: CGRect, stableTicks: Int) {
  let now = CGDisplayBounds(displayID)
  let ticks = now == previous && now.width > 0 ? stableTicks + 1 : 0
  if ticks >= 4 {
    reportReady()
    return watchCursor()
  }
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { waitUntilStable(previous: now, stableTicks: ticks) }
}

DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
  selectHiDPIMode()
  placeDisplay()
  waitUntilStable(previous: .zero, stableTicks: 0)
}

Thread {
  while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let cmd = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
    DispatchQueue.main.async { handle(cmd) }
  }
  DispatchQueue.main.async {
    bringCursorHome()
    setSystemCursorHidden(false)
    exit(0)  // stdin closed: the server stopped, so remove the display.
  }
}.start()

installHotKeyHandler()
for (name, spec) in initialHotKeys.sorted(by: { $0.key > $1.key }) { // jump first
  setHotKey(name, spec)
}
withExtendedLifetime(display) { app.run() }
