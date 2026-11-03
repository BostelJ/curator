import AppKit
import WebKit

/// A floating panel that shows over everything, fullscreen apps included, without activating Curator.
/// It only takes the keyboard when asked to (typing a note) and gives it straight back.
final class OverlayPanel: NSPanel {
    var allowKey = false
    override var canBecomeKey: Bool { allowKey }
    override var canBecomeMain: Bool { false }

    // There's no active app menu to catch these while we're non-activating.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
           let action = ["x": #selector(NSText.cut(_:)), "c": #selector(NSText.copy(_:)),
                         "v": #selector(NSText.paste(_:)), "a": #selector(NSText.selectAll(_:))][event.charactersIgnoringModifiers ?? ""] {
            return NSApp.sendAction(action, to: nil, from: self)
        }
        return super.performKeyEquivalent(with: event)
    }
}

/// A web view that takes the first click even though Curator isn't the active app.
final class FirstClickWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

enum Anchor { case topCenter, bottomRight }

final class Overlay: NSObject, WKScriptMessageHandler {
    let panel: OverlayPanel
    let web: FirstClickWebView
    private let anchor: Anchor
    private var size = NSSize(width: 10, height: 10)
    private var hasContent = false
    var hiddenByPause = false { didSet { applyVisibility() } }
    var onMessage: (([String: Any]) -> Void)?

    init(url: URL, anchor: Anchor) {
        self.anchor = anchor
        panel = OverlayPanel(contentRect: NSRect(x: 0, y: 0, width: 10, height: 10),
                             styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        let config = WKWebViewConfiguration()
        config.suppressesIncrementalRendering = false
        web = FirstClickWebView(frame: .zero, configuration: config)
        super.init()
        config.userContentController.add(self, name: "curator")
        web.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) { web.isInspectable = true }

        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar
        panel.hidesOnDeactivate = false
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.isMovable = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.contentView = web
        // Test mode: everything runs and renders, but nothing shows or takes clicks on the real screen.
        if ProcessInfo.processInfo.environment["CURATOR_QUIET"] == "1" {
            panel.alphaValue = 0
            panel.ignoresMouseEvents = true
        }
        web.load(URLRequest(url: url))
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if body["type"] as? String == "size" {
            let width = (body["w"] as? NSNumber)?.doubleValue ?? 0
            let height = (body["h"] as? NSNumber)?.doubleValue ?? 0
            hasContent = width > 0 && height > 0
            size = NSSize(width: width, height: height)
            place()
            applyVisibility()
            return
        }
        onMessage?(body)
    }

    private func screen() -> NSScreen {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens[0]
    }

    private func place() {
        guard hasContent else { return }
        let visible = screen().visibleFrame
        var origin = NSPoint.zero
        switch anchor {
        case .topCenter:
            origin = NSPoint(x: visible.midX - size.width / 2, y: visible.maxY - size.height)
        case .bottomRight:
            origin = NSPoint(x: visible.maxX - size.width, y: visible.minY)
        }
        panel.setFrame(NSRect(origin: origin, size: size), display: true)
    }

    private func applyVisibility() {
        if hasContent && !hiddenByPause {
            if !panel.isVisible { place() }
            panel.orderFrontRegardless()
        } else {
            giveBackKeyboard()
            panel.orderOut(nil)
        }
    }

    /// Show a leaf falling from a spot on another overlay. This panel covers that overlay's whole
    /// screen for the moment it takes, and clicks pass straight through it.
    func dropLeaf(from source: Overlay, html: String, x: Double, y: Double, width: Double, direction: Double) {
        guard let screen = source.panel.screen ?? NSScreen.main else { return }
        panel.ignoresMouseEvents = true
        if panel.frame != screen.frame { panel.setFrame(screen.frame, display: true) }
        panel.orderFrontRegardless()
        let left = x + source.panel.frame.minX - screen.frame.minX
        let top = y + screen.frame.maxY - source.panel.frame.maxY
        guard let data = try? JSONSerialization.data(withJSONObject: [html]),
              let list = String(data: data, encoding: .utf8) else { return }
        call("window.drop(\(list)[0], \(left), \(top), \(width), \(direction))")
    }

    func hideLeaves() {
        panel.orderOut(nil)
    }

    func takeKeyboard() {
        // Test mode must never take typing from whoever is using this Mac.
        if ProcessInfo.processInfo.environment["CURATOR_QUIET"] == "1" { return }
        panel.allowKey = true
        panel.makeKeyAndOrderFront(nil)
    }

    /// Hand typing back to the app that was in front.
    func giveBackKeyboard() {
        guard panel.allowKey else { return }
        panel.allowKey = false
        if panel.isKeyWindow {
            panel.resignKey()
            panel.orderOut(nil)
            if hasContent && !hiddenByPause { panel.orderFrontRegardless() }
        }
    }

    func call(_ script: String) {
        web.evaluateJavaScript(script, completionHandler: nil)
    }
}
