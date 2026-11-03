import AppKit
import Foundation

/// The stdio MCP bridge. It holds no state: everything goes to the running app over loopback.
enum MCP {
    private static let outputLock = NSLock()

    static let tools: [[String: Any]] = [
        [
            "name": "curator_quick_pick",
            "description": "Stage 1. Run a head-to-head tournament between 2-16 concepts, ideas or blockouts at the top of the user's screen: two at a time, winners advance until one is left, a few seconds per match while they do something else. Returns immediately with a card id; get the answer with curator_wait. Use whenever a direction isn't set yet, before any polished pass.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "project": ["type": "string", "description": "Project name; its art gallery board, e.g. Skyline."],
                    "title": ["type": "string", "description": "What's being chosen, in a few words."],
                    "prompt": ["type": "string", "description": "Optional one-line question or context."],
                    "options": [
                        "type": "array",
                        "description": "2-16 options. Each is a png, jpg, webp, gif, glb, or a video clip (mp4, mov, webm), with an absolute path. Clips in a match play in sync, so animations compare beat for beat. 4 or 8 make a clean bracket.",
                        "items": fileSchema,
                    ],
                    "revises": ["type": "string", "description": "Card id this follows, to stay in the same thread (for example a second quick pick after 'none of these')."],
                    "replaces": ["type": "array", "items": ["type": "string"], "description": "Strip ids from curator_board that this makes stale. If they keep this card, those strips come off the wall. Earlier Keeps on the same revises road are replaced automatically, so don't list those."],
                    "keep_on_pick": ["type": "boolean", "description": "True if the choice is final and belongs straight on the board, with no refinement to follow."],
                ],
                "required": ["project", "title", "options"],
            ] as [String: Any],
        ],
        [
            "name": "curator_refine",
            "description": "Stage 2. Show a real pass inside the chosen direction ('here's your modeled house, any changes?') as a film card stacked in the corner of the user's screen. They Keep it, which puts it on the project's art gallery, or send a note. Returns immediately with a card id; get the answer with curator_wait. A Keep is the only approval.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "project": ["type": "string"],
                    "title": ["type": "string", "description": "The asset, in a few words."],
                    "prompt": ["type": "string", "description": "Optional one-line question, or what changed in this pass."],
                    "files": [
                        "type": "array",
                        "description": "This pass: renders, a glb and/or video clips (mp4, mov, webm), with absolute paths. Put the one that best shows the asset first.",
                        "items": fileSchema,
                    ],
                    "replaces": ["type": "array", "items": ["type": "string"], "description": "Strip ids from curator_board that this makes stale. If they keep this card, those strips come off the wall. Earlier Keeps on the same revises road are replaced automatically, so don't list those."],
                    "revises": ["type": "string", "description": "The quick pick or previous refine card this pass follows. Always set it after the first card, so the kept photo strip shows the whole road."],
                ],
                "required": ["project", "title", "files"],
            ] as [String: Any],
        ],
        [
            "name": "curator_wait",
            "description": "Wait for answers to cards. Returns as soon as any of the listed cards is answered, or with everything still pending after timeout_seconds; if still pending, call it again or carry on with other work. Answers: pick (with the winning file, the runner-up, and every match, which show what beat what), redo (none of these, usually with a note), keep, note (sometimes with `markups`: pictures they drew red marker on to point at what the note means; open them. On a clip, the file name says the moment, like markup_01_at_1.40s_ab12cd.png), or delete (they threw this card away). Follow notes literally.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "ids": ["type": "array", "items": ["type": "string"]],
                    "timeout_seconds": ["type": "number", "description": "Default 240, at most 280."],
                ],
                "required": ["ids"],
            ] as [String: Any],
        ],
        [
            "name": "curator_board",
            "description": "Read a project's taste before starting a visual pass: accepted taste rules, declined rules (don't propose these again), recent tournament results, retired strips (no longer taste, don't build toward them), and everything kept with its stripId, with file paths and the notes that led there. Open the kept images to see them.",
            "inputSchema": [
                "type": "object",
                "properties": ["project": ["type": "string"]],
                "required": ["project"],
            ] as [String: Any],
        ],
        [
            "name": "curator_propose_rule",
            "description": "Propose a written taste rule when Keeps and notes show a repeated pattern. The user sees it as a card and accepts or declines it; only accepted rules count. Keep it specific and short, in the user's language. Rare and earned, not after every note.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "project": ["type": "string"],
                    "rule": ["type": "string", "description": "e.g. 'Toy-simple shapes: flat discs over detailed alloy wheels.'"],
                    "why": ["type": "string", "description": "The Keeps or notes that show it, in one line."],
                ],
                "required": ["project", "rule"],
            ] as [String: Any],
        ],
        [
            "name": "curator_retire_strips",
            "description": "Take strips off a project's art gallery wall when the art direction has moved on and they no longer represent it, such as after an accepted rule or a note that contradicts them. They move to a retired shelf the user can restore from, and stop counting as taste. Use it whenever a strip would mislead the next pass; the wall should show only current taste.",
            "inputSchema": [
                "type": "object",
                "properties": [
                    "strips": ["type": "array", "items": ["type": "string"], "description": "Strip ids from curator_board."],
                    "reason": ["type": "string", "description": "Why, in one short line the user will read, such as 'You moved to a single card with no red circle.'"],
                ],
                "required": ["strips", "reason"],
            ] as [String: Any],
        ],
        [
            "name": "curator_withdraw",
            "description": "Take down a pending card that no longer applies, such as a pass you've already replaced.",
            "inputSchema": [
                "type": "object",
                "properties": ["id": ["type": "string"]],
                "required": ["id"],
            ] as [String: Any],
        ],
    ]

    private static var fileSchema: [String: Any] {
        [
            "type": "object",
            "properties": [
                "path": ["type": "string", "description": "Absolute path."],
                "label": ["type": "string", "description": "Short marker label, like 'A: tall gable'."],
            ],
            "required": ["path"],
        ]
    }

    static func run() -> Never {
        while let line = readLine(strippingNewline: true) {
            guard !line.isEmpty, let data = line.data(using: .utf8),
                  let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
            // Each call gets its own thread, so a long wait doesn't hold up sending more cards.
            DispatchQueue.global().async { handle(message) }
        }
        exit(0)
    }

    private static func handle(_ message: [String: Any]) {
        guard let id = message["id"], let method = message["method"] as? String else { return } // notifications
        switch method {
        case "initialize":
            let version = (message["params"] as? [String: Any])?["protocolVersion"] as? String ?? "2025-06-18"
            reply(id, result: [
                "protocolVersion": version,
                "capabilities": ["tools": [:] as [String: Any]],
                "serverInfo": ["name": "curator", "version": "0.1.0"],
                "instructions": "Curator is the user's taste layer. Read curator_board before a visual pass, use curator_quick_pick to choose a direction, then curator_refine for each real pass. Nothing is approved until it's kept.",
            ])
        case "ping":
            reply(id, result: [:])
        case "tools/list":
            reply(id, result: ["tools": tools])
        case "tools/call":
            let params = message["params"] as? [String: Any] ?? [:]
            let arguments = params["arguments"] as? [String: Any] ?? [:]
            do {
                let output = try call(params["name"] as? String ?? "", arguments)
                let data = try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys])
                reply(id, result: ["content": [["type": "text", "text": String(decoding: data, as: UTF8.self)]]])
            } catch {
                reply(id, result: ["isError": true,
                                   "content": [["type": "text", "text": error.localizedDescription]]])
            }
        default:
            let failure: [String: Any] = ["code": -32601, "message": "Method not found: \(method)"]
            write(["jsonrpc": "2.0", "id": id, "error": failure])
        }
    }

    private static func reply(_ id: Any, result: [String: Any]) {
        write(["jsonrpc": "2.0", "id": id, "result": result])
    }

    private static func write(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        outputLock.lock()
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
        outputLock.unlock()
    }

    // MARK: Tools

    private static func call(_ name: String, _ args: [String: Any]) throws -> [String: Any] {
        switch name {
        case "curator_quick_pick":
            return try post("/api/send", [
                "stage": "quick_pick", "project": args["project"] ?? "", "title": args["title"] ?? "",
                "prompt": args["prompt"] ?? NSNull(), "files": args["options"] ?? [],
                "revises": args["revises"] ?? NSNull(), "keepOnPick": args["keep_on_pick"] ?? false,
                "replaces": args["replaces"] ?? [],
            ])
        case "curator_refine":
            return try post("/api/send", [
                "stage": "refine", "project": args["project"] ?? "", "title": args["title"] ?? "",
                "prompt": args["prompt"] ?? NSNull(), "files": args["files"] ?? [],
                "revises": args["revises"] ?? NSNull(), "replaces": args["replaces"] ?? [],
            ])
        case "curator_wait":
            return try wait(ids: args["ids"] as? [String] ?? [],
                            timeout: min((args["timeout_seconds"] as? NSNumber)?.doubleValue ?? 240, 280))
        case "curator_board":
            let project = (args["project"] as? String ?? "")
                .addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)?
                .replacingOccurrences(of: "&", with: "%26") ?? ""
            return try get("/api/board?project=\(project)")
        case "curator_propose_rule":
            return try post("/api/rule", ["project": args["project"] ?? "", "text": args["rule"] ?? "",
                                          "why": args["why"] ?? NSNull()])
        case "curator_retire_strips":
            return try post("/api/strip/retire", ["strips": args["strips"] ?? [], "reason": args["reason"] ?? ""])
        case "curator_withdraw":
            return try post("/api/withdraw", ["id": args["id"] ?? ""])
        default:
            throw StoreError.message("unknown tool \(name)")
        }
    }

    private static func wait(ids: [String], timeout: Double) throws -> [String: Any] {
        guard !ids.isEmpty else { throw StoreError.message("ids is required") }
        let joined = ids.joined(separator: ",")
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            let result = try get("/api/items?ids=\(joined)")
            let items = result["items"] as? [[String: Any]] ?? []
            if items.count < ids.count { throw StoreError.message("some of those card ids don't exist") }
            let settled = items.filter { $0["status"] as? String != "pending" }
            if !settled.isEmpty || Date() >= deadline {
                return ["answered": settled,
                        "stillPending": items.filter { $0["status"] as? String == "pending" }.compactMap { $0["id"] }]
            }
            Thread.sleep(forTimeInterval: 1)
        }
    }

    // MARK: Talking to the app

    private struct Server { let port: Int; let token: String }

    private static func readServerInfo() -> Server? {
        let url = Store.homeDirectory().appendingPathComponent("server.json")
        guard let data = try? Data(contentsOf: url),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let port = object["port"] as? Int, let token = object["token"] as? String else { return nil }
        return Server(port: port, token: token)
    }

    private static func healthy(_ server: Server) -> Bool {
        (try? request(server, "GET", "/api/health", body: nil, timeout: 2)) != nil
    }

    /// Finds the running app, and opens it if it isn't running.
    private static func connect() throws -> Server {
        if let server = readServerInfo(), healthy(server) { return server }
        var bundle = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        while bundle.pathExtension != "app", bundle.path != "/" { bundle.deleteLastPathComponent() }
        if bundle.pathExtension == "app" {
            NSWorkspace.shared.openApplication(at: bundle, configuration: {
                let config = NSWorkspace.OpenConfiguration()
                config.activates = false
                return config
            }())
        }
        for _ in 0..<40 {
            Thread.sleep(forTimeInterval: 0.25)
            if let server = readServerInfo(), healthy(server) { return server }
        }
        throw StoreError.message("Couldn't reach the Curator app. Is it installed in /Applications?")
    }

    private static func get(_ path: String) throws -> [String: Any] {
        try request(try connect(), "GET", path, body: nil, timeout: 15)
    }

    private static func post(_ path: String, _ body: [String: Any]) throws -> [String: Any] {
        try request(try connect(), "POST", path, body: body, timeout: 60)
    }

    private static func request(_ server: Server, _ method: String, _ path: String,
                                body: [String: Any]?, timeout: Double) throws -> [String: Any] {
        guard let url = URL(string: "http://127.0.0.1:\(server.port)\(path)") else {
            throw StoreError.message("bad path \(path)")
        }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue(server.token, forHTTPHeaderField: "X-Curator-Token")
        if let body {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let done = DispatchSemaphore(value: 0)
        var out: Result<[String: Any], Error> = .failure(StoreError.message("no response"))
        URLSession.shared.dataTask(with: req) { data, response, error in
            defer { done.signal() }
            if let error { out = .failure(error); return }
            let object = data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] } ?? [:]
            if let status = (response as? HTTPURLResponse)?.statusCode, status >= 400 {
                out = .failure(StoreError.message(object["error"] as? String ?? "HTTP \(status)"))
            } else {
                out = .success(object)
            }
        }.resume()
        done.wait()
        return try out.get()
    }
}
