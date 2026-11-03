import AppKit

// One binary, two jobs: `Curator mcp` is the stdio bridge Claude Code talks to,
// and with no arguments it's the menu bar app itself.
if CommandLine.arguments.count > 1, CommandLine.arguments[1] == "mcp" {
    MCP.run()
} else {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
