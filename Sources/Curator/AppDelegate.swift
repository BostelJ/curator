import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler {
    private let store = Store()
    private let token = UUID().uuidString + UUID().uuidString
    private var server: HTTPServer!
    private var api: API!
    private var quick: Overlay!
    private var stack: Overlay!
    private var leaves: Overlay!
    private var hotkeys: Hotkeys!
    private var statusItem: NSStatusItem!
    private var galleryWindow: NSWindow?
    private var galleryWeb: WKWebView?
    private var port: UInt16 = 0
    private var heldKeys: Set<Hotkeys.Key> = []

    // The keys each page wants right now, and whether anything is being typed.
    private var quickKeys: Set<Hotkeys.Key> = []
    private var stackKeys: Set<Hotkeys.Key> = []
    private var typing = false
    private var serverInfoURL: URL { store.home.appendingPathComponent("server.json") }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if anotherCopyIsRunning() {
            NSApp.terminate(nil)
            return
        }
        let webRoot = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
        api = API(store: store, token: token, webRoot: webRoot, getPort: { [weak self] in self?.port ?? 0 })
        server = HTTPServer { [weak self] request in
            self?.api.handle(request) ?? .error("shutting down")
        }
        do {
            try server.start { [weak self] port in self?.serverReady(port) }
        } catch {
            NSLog("Curator: couldn't start server: \(error)")
            NSApp.terminate(nil)
        }
    }

    private func anotherCopyIsRunning() -> Bool {
        let mine = ProcessInfo.processInfo.processIdentifier
        return NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .contains { $0.processIdentifier != mine && !$0.isTerminated }
    }

    private func serverReady(_ port: UInt16) {
        self.port = port
        let info: [String: Any] = ["port": Int(port), "token": token]
        if let data = try? JSONSerialization.data(withJSONObject: info) {
            let path = serverInfoURL.path
            FileManager.default.createFile(atPath: path, contents: data, attributes: [.posixPermissions: 0o600])
        }

        hotkeys = Hotkeys { [weak self] key in self?.pressed(key) }
        quick = Overlay(url: pageURL("quick.html"), anchor: .topCenter)
        stack = Overlay(url: pageURL("stack.html"), anchor: .bottomRight)
        leaves = Overlay(url: pageURL("leaves.html"), anchor: .topCenter)
        leaves.onMessage = { [weak self] message in
            if message["type"] as? String == "idle" { self?.leaves.hideLeaves() }
        }
        quick.onMessage = { [weak self] in self?.fromOverlay(self?.quick, $0) }
        stack.onMessage = { [weak self] in self?.fromOverlay(self?.stack, $0) }
        setUpStatusItem()
        setUpMenu()

        if ProcessInfo.processInfo.environment["CURATOR_DEBUG"] == "1" {
            api.debug = { [weak self] in self?.debugCommand($0.json) ?? [:] }
        }
        store.onChange = { [weak self] in self?.stateChanged() }
        stateChanged()
        updateHeldKeys()
    }

    /// Test hook: press a key, run script in a page, snapshot a panel, or report the panels' real frames.
    private func debugCommand(_ body: [String: Any]) -> [String: Any] {
        let overlays: [String: Overlay] = ["quick": quick, "stack": stack, "leaves": leaves]
        let target = overlays[body["panel"] as? String ?? ""]
        switch body["do"] as? String {
        case "press":
            if let raw = body["key"] as? String,
               let key = Hotkeys.Key.allCases.first(where: { "\($0)" == raw }) { pressed(key) }
        case "eval":
            let web: WKWebView? = target?.web ?? galleryWeb
            web?.evaluateJavaScript(body["script"] as? String ?? "") { value, error in
                NSLog("Curator eval: \(String(describing: value)) \(String(describing: error))")
            }
        case "gallery":
            openGallery()
            if let size = body["size"] as? [Double] {
                galleryWindow?.setContentSize(NSSize(width: size[0], height: size[1]))
            }
        case "statusIcon":
            let symbol = AppDelegate.menuBarSymbol()
            let scale = (body["scale"] as? NSNumber)?.doubleValue ?? 2
            let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(18 * scale), pixelsHigh: Int(18 * scale),
                                       bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                       colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            symbol.draw(in: NSRect(x: 0, y: 0, width: 18 * scale, height: 18 * scale))
            NSGraphicsContext.restoreGraphicsState()
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: body["out"] as? String ?? ""))
        case "snapshot":
            let out = body["out"] as? String ?? ""
            let web: WKWebView? = target?.web ?? galleryWeb
            web?.takeSnapshot(with: nil) { image, _ in
                guard let image, let tiff = image.tiffRepresentation,
                      let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
                try? png.write(to: URL(fileURLWithPath: out))
            }
        default: break
        }
        func describe(_ overlay: Overlay) -> [String: Any] {
            let f = overlay.panel.frame
            return ["visible": overlay.panel.isVisible, "key": overlay.panel.isKeyWindow,
                    "level": overlay.panel.level.rawValue, "frame": [f.minX, f.minY, f.width, f.height]]
        }
        let screen = NSScreen.main?.visibleFrame ?? .zero
        return ["quick": describe(quick), "stack": describe(stack),
                "screen": [screen.minX, screen.minY, screen.width, screen.height],
                "active": NSWorkspace.shared.frontmostApplication?.localizedName ?? "",
                "curatorActive": NSApp.isActive, "keysHeld": heldKeys.map { "\($0)" }.sorted()]
    }

    private func pageURL(_ page: String) -> URL {
        URL(string: "http://127.0.0.1:\(port)/ui/\(page)?token=\(token)")!
    }

    func applicationWillTerminate(_ notification: Notification) {
        try? FileManager.default.removeItem(at: serverInfoURL)
    }

    private func stateChanged() {
        let paused = store.data.paused
        quick.hiddenByPause = paused
        stack.hiddenByPause = paused
        for overlay in [quick!, stack!] { overlay.call("window.curatorRefresh && window.curatorRefresh()") }
        galleryWeb?.evaluateJavaScript("window.curatorRefresh && window.curatorRefresh()", completionHandler: nil)
        updateStatusItem()
        updateHeldKeys()
    }

    // MARK: Keys

    private func updateHeldKeys() {
        var keys: Set<Hotkeys.Key> = [.gallery]
        if !store.data.paused && !typing { keys.formUnion(quickKeys.union(stackKeys)) }
        heldKeys = keys
        // Test mode never takes real keys from whoever is using this Mac.
        if ProcessInfo.processInfo.environment["CURATOR_QUIET"] != "1" { hotkeys.hold(keys) }
    }

    /// The pick at the top of the screen gets first say, then the corner stack.
    private func pressed(_ key: Hotkeys.Key) {
        if key == .gallery { return openGallery() }
        let target: Overlay = quickKeys.contains(key) ? quick : stack
        target.call("window.curatorKey && window.curatorKey('\(key)')")
    }

    private func fromOverlay(_ overlay: Overlay?, _ message: [String: Any]) {
        guard let overlay else { return }
        switch message["type"] as? String {
        case "keys":
            let names = message["keys"] as? [String] ?? []
            let wanted = Set(Hotkeys.Key.allCases.filter { names.contains("\($0)") })
            if overlay === quick { quickKeys = wanted } else { stackKeys = wanted }
            updateHeldKeys()
        case "typing":
            typing = message["on"] as? Bool ?? false
            if typing { overlay.takeKeyboard() } else { overlay.giveBackKeyboard() }
            updateHeldKeys()
        case "leaf":
            leaves.dropLeaf(from: overlay, html: message["html"] as? String ?? "",
                            x: (message["x"] as? NSNumber)?.doubleValue ?? 0,
                            y: (message["y"] as? NSNumber)?.doubleValue ?? 0,
                            width: (message["w"] as? NSNumber)?.doubleValue ?? 300,
                            direction: (message["direction"] as? NSNumber)?.doubleValue ?? 1)
        default: break
        }
    }

    // MARK: Menu bar

    private func setUpStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = AppDelegate.menuBarSymbol()
        statusItem.button?.imagePosition = .imageLeading
        rebuildStatusMenu()
    }

    private func updateStatusItem() {
        guard statusItem != nil else { return }
        let waiting = store.waitingCount
        statusItem.button?.title = waiting > 0 ? " \(waiting)" : ""
        statusItem.button?.image = store.data.paused
            ? NSImage(systemSymbolName: "pause.circle", accessibilityDescription: "Curator, paused")
            : AppDelegate.menuBarSymbol()
        rebuildStatusMenu()
    }

    /// The logo as a template image, so macOS colours it for light and dark menu bars.
    /// Matches brand/menu-bar-symbol.svg: a 384 box around the logo's 512 grid.
    static func menuBarSymbol() -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
            let card = NSBezierPath(roundedRect: NSRect(x: 116, y: 86, width: 280, height: 340), xRadius: 8, yRadius: 8)
            card.append(NSBezierPath(rect: NSRect(x: 144, y: 174, width: 224, height: 224)))
            card.windingRule = .evenOdd
            var t = AffineTransform()
            t.scale(18.0 / 384)
            t.translate(x: 256 - 64, y: 256 - 64)
            t.rotate(byDegrees: -8)
            t.translate(x: -256, y: -256)
            card.transform(using: t)
            NSColor.black.setFill()
            card.fill()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Curator"
        return image
    }

    private func rebuildStatusMenu() {
        let menu = NSMenu()
        let waiting = store.waitingCount
        let header = NSMenuItem(title: waiting == 0 ? "Nothing waiting" : "\(waiting) waiting for you", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Open Art Gallery  ⌃⌥G", action: #selector(openGallery), keyEquivalent: "").target = self
        menu.addItem(withTitle: store.data.paused ? "Resume Cards" : "Pause Cards",
                     action: #selector(togglePause), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Curator", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        statusItem.menu = menu
    }

    @objc private func togglePause() {
        store.setPaused(!store.data.paused)
    }

    /// The gallery window needs a real menu for copy and paste to work.
    private func setUpMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Curator", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = window
        NSApp.mainMenu = main
    }

    // MARK: Gallery

    @objc private func openGallery() {
        if galleryWindow == nil {
            let config = WKWebViewConfiguration()
            config.userContentController.add(self, name: "curator")
            let web = WKWebView(frame: .zero, configuration: config)
            if #available(macOS 13.3, *) { web.isInspectable = true }
            web.setValue(false, forKey: "drawsBackground")
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                                  styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                                  backing: .buffered, defer: false)
            window.title = "Art Gallery"
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.backgroundColor = NSColor(red: 0.953, green: 0.945, blue: 0.925, alpha: 1)
            window.isReleasedWhenClosed = false
            window.minSize = NSSize(width: 760, height: 520)
            window.contentView = web
            window.delegate = self
            window.center()
            web.load(URLRequest(url: pageURL("gallery.html")))
            galleryWindow = window
            galleryWeb = web
        }
        if ProcessInfo.processInfo.environment["CURATOR_QUIET"] == "1" {
            galleryWindow?.alphaValue = 0
            galleryWindow?.ignoresMouseEvents = true
            galleryWindow?.orderBack(nil)
            return
        }
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        galleryWindow?.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        // Back to being just a menu bar app.
        NSApp.setActivationPolicy(.accessory)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {}
}
