// Draws the app icon from the logo: a solid instant print, tilted 8 degrees, whose window is
// pure negative space. It must match brand/app-icon.svg, the master chosen in Curator.
// Usage: swift scripts/make-icon.swift Resources/Curator.icns
import AppKit

func draw(_ size: CGFloat) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size),
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    // The macOS icon grid: art sits in an 824 tile on a 1024 canvas.
    let u = size / 1024
    NSColor(red: 0.984, green: 0.98, blue: 0.965, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 100 * u, y: 100 * u, width: 824 * u, height: 824 * u),
                 xRadius: 186 * u, yRadius: 186 * u).fill()
    // The print, on the logo's 512 grid, y flipped: card 280 by 340, window 224 square.
    let k = 1.7 * u
    let card = NSBezierPath(roundedRect: NSRect(x: 116, y: 86, width: 280, height: 340), xRadius: 8, yRadius: 8)
    card.append(NSBezierPath(rect: NSRect(x: 144, y: 174, width: 224, height: 224)))
    card.windingRule = .evenOdd
    var t = AffineTransform()
    t.translate(x: 76.8 * u, y: 76.8 * u)
    t.scale(k)
    t.translate(x: 256, y: 256)
    t.rotate(byDegrees: -8)
    t.translate(x: -256, y: -256)
    card.transform(using: t)
    NSColor(red: 0.067, green: 0.063, blue: 0.063, alpha: 1).setFill()
    card.fill()
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let out = CommandLine.arguments[1]
let set = NSTemporaryDirectory() + "Curator-\(UUID().uuidString).iconset"
try FileManager.default.createDirectory(atPath: set, withIntermediateDirectories: true)
for (size, scale) in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)] {
    let name = scale == 1 ? "icon_\(size)x\(size).png" : "icon_\(size)x\(size)@2x.png"
    try draw(CGFloat(size * scale)).write(to: URL(fileURLWithPath: "\(set)/\(name)"))
}
let tool = Process()
tool.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
tool.arguments = ["-c", "icns", set, "-o", out]
try tool.run()
tool.waitUntilExit()
try FileManager.default.removeItem(atPath: set)
