import Foundation

/// The HTTP surface: the web views and the MCP bridge both go through here.
final class API {
    private let store: Store
    private let token: String
    private let webRoot: URL
    private let getPort: () -> UInt16
    /// Only set when launched with CURATOR_DEBUG=1, for testing without Screen Recording permission.
    var debug: ((Request) -> [String: Any])?

    init(store: Store, token: String, webRoot: URL, getPort: @escaping () -> UInt16) {
        self.store = store
        self.token = token
        self.webRoot = webRoot
        self.getPort = getPort
    }

    private func encode<T: Encodable>(_ value: T) -> Any {
        guard let data = try? JSONEncoder().encode(value),
              let object = try? JSONSerialization.jsonObject(with: data) else { return [:] as [String: Any] }
        return object
    }

    func handle(_ request: Request) -> Response {
        // Refuse anything addressed to another hostname, so a web page can't reach us by DNS rebinding.
        guard request.headers["host"] == "127.0.0.1:\(getPort())" else { return .error("forbidden", status: 403) }

        if request.path.hasPrefix("/ui/") { return serveUI(request.path) }

        guard request.query["token"] == token || request.headers["x-curator-token"] == token else {
            return .error("unauthorized", status: 401)
        }
        if request.path.hasPrefix("/media/") { return serveMedia(request.path, range: request.headers["range"]) }

        do {
            switch (request.method, request.path) {
            case ("GET", "/api/health"): return .json(["ok": true])
            case ("POST", "/api/debug"):
                guard let debug else { return .error("not found", status: 404) }
                return .json(debug(request))
            case ("GET", "/api/state"): return .json(state())
            case ("GET", "/api/items"): return .json(["items": items(request.query["ids"] ?? "")])
            case ("GET", "/api/board"): return .json(board(request.query["project"] ?? ""))
            case ("POST", "/api/send"): return .json(try send(request.json))
            case ("POST", "/api/answer"):
                let body = request.json
                try store.answer(id: body["id"] as? String ?? "", action: body["action"] as? String ?? "",
                                 frameId: body["frameId"] as? String, note: body["note"] as? String,
                                 matches: matches(body["matches"]), markups: body["markups"] as? [String],
                                 onScreen: body["onScreen"] as? [String])
                return .json(["ok": true])
            case ("POST", "/api/markup"):
                let body = request.json
                let raw = (body["png"] as? String ?? "").replacingOccurrences(of: "data:image/png;base64,", with: "")
                guard let png = Data(base64Encoded: raw) else { return .error("png must be base64") }
                let file = try store.saveMarkup(id: body["id"] as? String ?? "", frameId: body["frameId"] as? String ?? "", png: png,
                                              time: (body["time"] as? NSNumber)?.doubleValue)
                return .json(["file": file])
            case ("POST", "/api/withdraw"):
                try store.withdraw(id: request.json["id"] as? String ?? "")
                return .json(["ok": true])
            case ("POST", "/api/rule"):
                let body = request.json
                let rule = try store.proposeRule(project: body["project"] as? String ?? "",
                                                 text: body["text"] as? String ?? "", why: body["why"] as? String)
                return .json(encode(rule))
            case ("POST", "/api/rule/answer"):
                let body = request.json
                try store.answerRule(id: body["id"] as? String ?? "", accept: body["accept"] as? Bool ?? false)
                return .json(["ok": true])
            case ("POST", "/api/strip/retire"):
                let body = request.json
                try store.retireStrips(ids: body["strips"] as? [String] ?? [], reason: body["reason"] as? String ?? "")
                return .json(["ok": true])
            case ("POST", "/api/strip/restore"):
                try store.restoreStrip(id: request.json["id"] as? String ?? "")
                return .json(["ok": true])
            case ("POST", "/api/strip/remove"):
                try store.removeStrip(id: request.json["id"] as? String ?? "")
                return .json(["ok": true])
            default:
                return .error("not found", status: 404)
            }
        } catch {
            return .error(error.localizedDescription)
        }
    }

    private func matches(_ raw: Any?) -> [Match]? {
        guard let raw, !(raw is NSNull),
              let data = try? JSONSerialization.data(withJSONObject: raw) else { return nil }
        return try? JSONDecoder().decode([Match].self, from: data)
    }

    private func state() -> [String: Any] {
        let order = { (a: Item, b: Item) in a.createdAt < b.createdAt }
        return [
            "quick": encode(store.pendingQuick.sorted(by: order)),
            "refine": encode(store.pendingRefine.sorted(by: order)),
            "proposedRules": encode(store.proposedRules),
            "rules": encode(store.data.rules.filter { $0.status == "accepted" }),
            "strips": encode(store.data.strips.filter { !$0.removed }.sorted { $0.keptAt > $1.keptAt }),
            "retired": encode(store.data.strips.filter(\.removed).sorted { $0.keptAt > $1.keptAt }),
            "projects": store.projects,
            "paused": store.data.paused,
        ]
    }

    /// What an agent gets back about a card, with real paths it can open.
    private func describe(_ item: Item) -> [String: Any] {
        var out: [String: Any] = ["id": item.id, "stage": item.stage, "status": item.status, "title": item.title,
                                  "project": item.project, "thread": item.thread, "round": item.round]
        if let answer = item.answer {
            var a: [String: Any] = ["action": answer.action]
            if let note = answer.note { a["note"] = note }
            if let markups = answer.markups, !markups.isEmpty {
                a["markups"] = markups.map { store.path(of: $0) }
            }
            if let frame = item.frames.first(where: { $0.id == answer.frameId }) {
                a["chosen"] = ["label": frame.label ?? "", "path": store.path(of: frame.file)]
            }
            if let played = answer.matches, !played.isEmpty {
                let name = { (id: String) -> String in
                    guard let index = item.frames.firstIndex(where: { $0.id == id }) else { return id }
                    return item.frames[index].label ?? "Option \(index + 1)"
                }
                a["matches"] = played.map { ["round": $0.round, "winner": name($0.winner),
                                             "loser": name($0.winner == $0.a ? $0.b : $0.a)] as [String: Any] }
                if let last = played.last {
                    let loser = last.winner == last.a ? last.b : last.a
                    if let frame = item.frames.first(where: { $0.id == loser }) {
                        a["runnerUp"] = ["label": frame.label ?? "", "path": store.path(of: frame.file)]
                    }
                }
            }
            if let shown = answer.onScreen, !shown.isEmpty {
                // The note was written while these two were up, so it may be about them.
                a["onScreen"] = shown.compactMap { id in item.frames.first { $0.id == id } }.map {
                    ["label": $0.label ?? "", "path": store.path(of: $0.file)]
                }
            }
            if answer.action == "keep" || (answer.action == "pick" && item.keepOnPick) { a["onBoard"] = true }
            out["answer"] = a
        }
        return out
    }

    private func items(_ ids: String) -> [[String: Any]] {
        ids.split(separator: ",").compactMap { id in
            store.data.items.first { $0.id == id }.map(describe)
        }
    }

    private func board(_ project: String) -> [String: Any] {
        let same = { (name: String) in name.caseInsensitiveCompare(project) == .orderedSame }
        let strips = store.data.strips.filter { !$0.removed && same($0.project) }.sorted { $0.keptAt > $1.keptAt }
        return [
            "project": project,
            "acceptedRules": store.data.rules.filter { $0.status == "accepted" && same($0.project) }.map(\.text),
            "declinedRules": store.data.rules.filter { $0.status == "declined" && same($0.project) }.map(\.text),
            "recentTournaments": recentTournaments(same),
            "retired": store.data.strips.filter { $0.removed && same($0.project) }.map {
                ["stripId": $0.id, "title": $0.title, "why": $0.retiredReason ?? "Taken down"]
            },
            "kept": strips.map { strip -> [String: Any] in
                let final = strip.frames.filter(\.final)
                let road = strip.frames.filter { !$0.final }
                return ["stripId": strip.id, "title": strip.title, "notes": strip.notes,
                        "keptFiles": final.map { store.path(of: $0.file) },
                        "earlierPasses": road.map { store.path(of: $0.file) }]
            },
        ]
    }

    /// Who beat whom lately: a direct read of preference, even for things never kept.
    private func recentTournaments(_ same: (String) -> Bool) -> [[String: Any]] {
        let played = store.data.items.filter {
            same($0.project) && $0.stage == "quick_pick" && ($0.answer?.action == "pick" || $0.answer?.action == "note")
        }
        return played.suffix(12).map { item in
            let label = { (id: String?) -> String in
                guard let index = item.frames.firstIndex(where: { $0.id == id }) else { return "" }
                return item.frames[index].label ?? "Option \(index + 1)"
            }
            let last = item.answer?.matches?.last
            var out: [String: Any] = ["title": item.title]
            if item.answer?.action == "note" {
                out["answeredWithNote"] = true   // they wrote a note instead of finishing the bracket
                if let shown = item.answer?.onScreen { out["onScreen"] = shown.map { label($0) } }
            } else {
                out["winner"] = label(item.answer?.frameId)
                if let last { out["runnerUp"] = label(last.winner == last.a ? last.b : last.a) }
            }
            if let note = item.answer?.note { out["note"] = note }
            return out
        }
    }

    private func send(_ body: [String: Any]) throws -> [String: Any] {
        guard let raw = body["files"] as? [[String: Any]] else { throw StoreError.message("files is required") }
        let frames: [(path: String, label: String?)] = raw.map {
            (path: $0["path"] as? String ?? "", label: $0["label"] as? String)
        }
        let item = try store.send(project: body["project"] as? String ?? "",
                                  stage: body["stage"] as? String ?? "",
                                  title: body["title"] as? String ?? "",
                                  prompt: body["prompt"] as? String,
                                  frames: frames,
                                  revises: body["revises"] as? String,
                                  keepOnPick: body["keepOnPick"] as? Bool ?? false,
                                  replaces: body["replaces"] as? [String] ?? [])
        return ["id": item.id, "thread": item.thread, "round": item.round, "status": item.status]
    }

    private func serveUI(_ path: String) -> Response {
        contents(of: webRoot, relative: String(path.dropFirst("/ui/".count)))
    }

    private func serveMedia(_ path: String, range: String?) -> Response {
        guard let file = locate(in: store.mediaDir, relative: String(path.dropFirst("/media/".count))) else {
            return .error("not found", status: 404)
        }
        return contents(of: file, range: range)
    }

    private func locate(in root: URL, relative: String) -> URL? {
        let parts = relative.split(separator: "/").map(String.init)
        guard !parts.isEmpty, !parts.contains(".."), !parts.contains(".") else { return nil }
        let file = parts.reduce(root) { $0.appendingPathComponent($1) }.standardizedFileURL
        guard file.path.hasPrefix(root.standardizedFileURL.path + "/") else { return nil }
        return file
    }

    private func contents(of root: URL, relative: String) -> Response {
        guard let file = locate(in: root, relative: relative) else { return .error("not found", status: 404) }
        return contents(of: file, range: nil)
    }

    /// Serves a file, or the byte range asked for. WebKit only plays a video it can fetch in ranges.
    private func contents(of file: URL, range: String?) -> Response {
        let type = HTTPServer.contentType(for: file.pathExtension)
        guard let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.intValue,
              let handle = try? FileHandle(forReadingFrom: file) else { return .error("not found", status: 404) }
        defer { try? handle.close() }
        let ranges = ["Accept-Ranges": "bytes"]
        guard let range, let (start, end) = HTTPServer.byteRange(range, size: size) else {
            if range != nil {
                return Response(status: 416, contentType: type, headers: ["Content-Range": "bytes */\(size)"])
            }
            let data = (try? handle.readToEnd()) ?? Data()
            return Response(contentType: type, body: data, headers: ranges)
        }
        try? handle.seek(toOffset: UInt64(start))
        let data = (try? handle.read(upToCount: end - start + 1)) ?? Data()
        return Response(status: 206, contentType: type, body: data,
                        headers: ranges.merging(["Content-Range": "bytes \(start)-\(start + data.count - 1)/\(size)"]) { a, _ in a })
    }
}
