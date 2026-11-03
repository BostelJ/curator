import Foundation

struct Frame: Codable {
    var id: String
    var label: String?
    var file: String          // "<itemId>/<name>", relative to the media folder
    var kind: String          // "image" or "model"
}

/// One head-to-head in a quick pick tournament, by frame id.
struct Match: Codable {
    var round: Int
    var a: String
    var b: String
    var winner: String
}

struct Answer: Codable {
    var action: String        // pick, redo, keep, note or delete
    var frameId: String?
    var note: String?
    var at: Double
    var matches: [Match]?     // a tournament's results, in the order they were played
}

struct Item: Codable {
    var id: String
    var project: String
    var stage: String         // quick_pick or refine
    var title: String
    var prompt: String?
    var frames: [Frame]
    var thread: String
    var round: Int                 // cards so far on this road, the quick pick included
    var pass: Int?                 // refine cards only: which real pass this is, counting from 1
    var revises: String?
    var keepOnPick: Bool
    var replaces: [String]?        // strips this card takes the place of, if it's kept
    var replacesTitles: [String]?  // their titles, so the card can say so
    var status: String        // pending, answered or withdrawn
    var createdAt: Double
    var answer: Answer?
}

struct StripFrame: Codable {
    var file: String
    var kind: String
    var label: String?
    var round: Int
    var final: Bool
    var stage: String?            // quick_pick or refine
}

struct Strip: Codable {
    var id: String
    var project: String
    var thread: String
    var title: String
    var frames: [StripFrame]
    var notes: [String]       // every note on the way to this Keep, oldest first
    var keptAt: Double
    var removed: Bool             // off the wall, on the retired shelf; files and history stay
    var retiredReason: String?
}

struct Rule: Codable {
    var id: String
    var project: String
    var text: String
    var why: String?
    var status: String        // proposed, accepted or declined
    var createdAt: Double
}

struct StoreData: Codable {
    var items: [Item] = []
    var strips: [Strip] = []
    var rules: [Rule] = []
    var paused: Bool = false
}

enum StoreError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let m) = self { return m }; return nil }
}

/// Everything Curator knows. Only touched from the main queue.
final class Store {
    static let viewableImages: Set<String> = ["png", "jpg", "jpeg", "webp", "gif"]
    static let viewableModels: Set<String> = ["glb"]

    let home: URL
    var mediaDir: URL { home.appendingPathComponent("media") }
    private var stateURL: URL { home.appendingPathComponent("state.json") }
    private(set) var data = StoreData()
    var onChange: (() -> Void)?

    static func homeDirectory() -> URL {
        if let custom = ProcessInfo.processInfo.environment["CURATOR_HOME"], !custom.isEmpty {
            return URL(fileURLWithPath: custom, isDirectory: true)
        }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("Curator", isDirectory: true)
    }

    init() {
        home = Store.homeDirectory()
        try? FileManager.default.createDirectory(at: mediaDir, withIntermediateDirectories: true)
        if let raw = try? Data(contentsOf: stateURL) {
            do {
                data = try JSONDecoder().decode(StoreData.self, from: raw)
            } catch {
                // Never write over a state file we couldn't read.
                let stamp = Int(Date().timeIntervalSince1970)
                let aside = home.appendingPathComponent("state.unreadable-\(stamp).json")
                try? FileManager.default.moveItem(at: stateURL, to: aside)
                NSLog("Curator: state.json could not be read, moved to \(aside.path): \(error)")
            }
        }
    }

    private func commit() {
        if let raw = try? JSONEncoder().encode(data) {
            try? raw.write(to: stateURL, options: .atomic)
        }
        onChange?()
    }

    private func newId(_ prefix: String) -> String {
        prefix + "_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12).lowercased()
    }

    /// Project names are matched without caring about case, and keep the first spelling used.
    private func canonicalProject(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let known = data.items.map(\.project) + data.strips.map(\.project) + data.rules.map(\.project)
        return known.first { $0.caseInsensitiveCompare(trimmed) == .orderedSame } ?? trimmed
    }

    // MARK: Sending

    func send(project: String, stage: String, title: String, prompt: String?,
              frames input: [(path: String, label: String?)], revises: String?, keepOnPick: Bool,
              replaces: [String] = []) throws -> Item {
        guard stage == "quick_pick" || stage == "refine" else {
            throw StoreError.message("stage must be quick_pick or refine")
        }
        let name = canonicalProject(project)
        guard !name.isEmpty else { throw StoreError.message("project is required") }
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw StoreError.message("title is required")
        }
        guard !input.isEmpty else { throw StoreError.message("at least one file is required") }
        if stage == "quick_pick", input.count < 2 {
            throw StoreError.message("a quick pick needs at least 2 options; send one direction as a refine card")
        }
        if stage == "quick_pick", input.count > 16 {
            throw StoreError.message("a quick pick takes at most 16 options, so it stays quick")
        }

        var parent: Item?
        if let revises {
            guard let found = data.items.first(where: { $0.id == revises }) else {
                throw StoreError.message("revises: no card with id \(revises)")
            }
            parent = found
        }

        let replaced = try replaces.map { id -> Strip in
            guard let strip = data.strips.first(where: { $0.id == id }) else {
                throw StoreError.message("replaces: no strip with id \(id). curator_board lists them.")
            }
            return strip
        }

        // Check every file before copying any of them.
        let fm = FileManager.default
        for entry in input {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: entry.path, isDirectory: &isDir), !isDir.boolValue else {
                throw StoreError.message("file not found: \(entry.path)")
            }
            let ext = URL(fileURLWithPath: entry.path).pathExtension.lowercased()
            guard Store.viewableImages.contains(ext) || Store.viewableModels.contains(ext) else {
                throw StoreError.message("can't show .\(ext) files (\(entry.path)). Send png, jpg, webp, gif or glb.")
            }
        }

        let id = newId("card")
        let folder = mediaDir.appendingPathComponent(id, isDirectory: true)
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        var frames: [Frame] = []
        for (index, entry) in input.enumerated() {
            let source = URL(fileURLWithPath: entry.path)
            let safe = source.lastPathComponent.replacingOccurrences(
                of: "[^A-Za-z0-9._-]", with: "_", options: .regularExpression)
            let stored = String(format: "%02d_%@", index + 1, safe)
            do {
                try fm.copyItem(at: source, to: folder.appendingPathComponent(stored))
            } catch {
                try? fm.removeItem(at: folder)
                throw StoreError.message("couldn't copy \(entry.path): \(error.localizedDescription)")
            }
            let ext = source.pathExtension.lowercased()
            frames.append(Frame(id: newId("frame"), label: entry.label, file: "\(id)/\(stored)",
                                kind: Store.viewableModels.contains(ext) ? "model" : "image"))
        }

        let item = Item(id: id, project: parent?.project ?? name, stage: stage, title: title, prompt: prompt,
                        frames: frames, thread: parent?.thread ?? newId("thread"),
                        round: (parent?.round ?? 0) + 1,
                        pass: stage == "refine" ? passesSoFar(on: parent?.thread) + 1 : nil,
                        revises: revises, keepOnPick: keepOnPick,
                        replaces: replaces.isEmpty ? nil : replaces,
                        replacesTitles: replaced.isEmpty ? nil : replaced.map(\.title),
                        status: "pending", createdAt: Date().timeIntervalSince1970, answer: nil)
        data.items.append(item)
        commit()
        return item
    }

    private func passesSoFar(on thread: String?) -> Int {
        guard let thread else { return 0 }
        return data.items.filter { $0.thread == thread && $0.stage == "refine" && $0.status != "withdrawn" }.count
    }

    func withdraw(id: String) throws {
        guard let index = data.items.firstIndex(where: { $0.id == id }) else {
            throw StoreError.message("no card with id \(id)")
        }
        guard data.items[index].status == "pending" else { return }
        data.items[index].status = "withdrawn"
        commit()
    }

    // MARK: Answering

    func answer(id: String, action: String, frameId: String?, note: String?, matches: [Match]? = nil) throws {
        guard let index = data.items.firstIndex(where: { $0.id == id }) else {
            throw StoreError.message("no card with id \(id)")
        }
        guard data.items[index].status == "pending" else {
            throw StoreError.message("that card has already been answered")
        }
        let item = data.items[index]
        let trimmed = note?.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanNote = (trimmed?.isEmpty ?? true) ? nil : trimmed
        switch (item.stage, action) {
        case ("quick_pick", "pick"):
            guard let frameId, item.frames.contains(where: { $0.id == frameId }) else {
                throw StoreError.message("pick needs one of this card's frames")
            }
        case ("quick_pick", "redo"), ("refine", "keep"), (_, "delete"):
            break
        case ("refine", "note"):
            guard cleanNote != nil else { throw StoreError.message("a note can't be empty") }
        default:
            throw StoreError.message("\(action) isn't an answer for a \(item.stage) card")
        }
        data.items[index].status = "answered"
        data.items[index].answer = Answer(action: action, frameId: frameId, note: cleanNote,
                                          at: Date().timeIntervalSince1970, matches: matches)
        if action == "keep" || (action == "pick" && item.keepOnPick) {
            makeStrip(from: data.items[index])
        }
        commit()
    }

    /// A Keep becomes a photo strip: the road to it (the picked direction, each pass) ending on what was kept.
    private func makeStrip(from kept: Item) {
        var frames: [StripFrame] = []
        var notes: [String] = []
        let road = data.items
            .filter { $0.thread == kept.thread && $0.status == "answered" }
            .sorted { $0.createdAt < $1.createdAt }
        for item in road {
            if let note = item.answer?.note { notes.append(note) }
            let isKept = item.id == kept.id
            if item.stage == "quick_pick" {
                if let chosen = item.frames.first(where: { $0.id == item.answer?.frameId }) {
                    frames.append(StripFrame(file: chosen.file, kind: chosen.kind, label: chosen.label,
                                             round: item.round, final: isKept, stage: item.stage))
                }
            } else if isKept {
                frames += item.frames.map {
                    StripFrame(file: $0.file, kind: $0.kind, label: $0.label, round: item.round, final: true, stage: item.stage)
                }
            } else if let first = item.frames.first {
                frames.append(StripFrame(file: first.file, kind: first.kind, label: first.label,
                                         round: item.round, final: false, stage: item.stage))
            }
        }
        // The wall shows current taste. A new Keep takes the place of any earlier Keep on the same
        // road, and of whatever the agent said this card replaces.
        for index in data.strips.indices where !data.strips[index].removed {
            if data.strips[index].thread == kept.thread || kept.replaces?.contains(data.strips[index].id) == true {
                data.strips[index].removed = true
                data.strips[index].retiredReason = "Replaced by “\(kept.title)”"
            }
        }
        data.strips.append(Strip(id: newId("strip"), project: kept.project, thread: kept.thread,
                                 title: kept.title, frames: frames, notes: notes,
                                 keptAt: Date().timeIntervalSince1970, removed: false, retiredReason: nil))
    }

    func removeStrip(id: String) throws {
        guard let index = data.strips.firstIndex(where: { $0.id == id }) else {
            throw StoreError.message("no strip with id \(id)")
        }
        // Taken off the wall, not deleted: it moves to the retired shelf and can be restored.
        data.strips[index].removed = true
        data.strips[index].retiredReason = "Taken down by you"
        commit()
    }

    /// The art direction moved on and these no longer represent it.
    func retireStrips(ids: [String], reason: String) throws {
        let clean = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { throw StoreError.message("say why these no longer fit") }
        guard !ids.isEmpty else { throw StoreError.message("strips is required") }
        for id in ids where !data.strips.contains(where: { $0.id == id }) {
            throw StoreError.message("no strip with id \(id). curator_board lists them.")
        }
        for index in data.strips.indices where ids.contains(data.strips[index].id) && !data.strips[index].removed {
            data.strips[index].removed = true
            data.strips[index].retiredReason = clean
        }
        commit()
    }

    func restoreStrip(id: String) throws {
        guard let index = data.strips.firstIndex(where: { $0.id == id }) else {
            throw StoreError.message("no strip with id \(id)")
        }
        data.strips[index].removed = false
        data.strips[index].retiredReason = nil
        commit()
    }

    // MARK: Taste rules

    func proposeRule(project: String, text: String, why: String?) throws -> Rule {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { throw StoreError.message("a rule can't be empty") }
        let name = canonicalProject(project)
        guard !name.isEmpty else { throw StoreError.message("project is required") }
        if let existing = data.rules.first(where: {
            $0.project == name && $0.text.caseInsensitiveCompare(clean) == .orderedSame && $0.status != "declined"
        }) {
            return existing
        }
        let rule = Rule(id: newId("rule"), project: name, text: clean, why: why, status: "proposed",
                        createdAt: Date().timeIntervalSince1970)
        data.rules.append(rule)
        commit()
        return rule
    }

    func answerRule(id: String, accept: Bool) throws {
        guard let index = data.rules.firstIndex(where: { $0.id == id }) else {
            throw StoreError.message("no rule with id \(id)")
        }
        data.rules[index].status = accept ? "accepted" : "declined"
        commit()
    }

    // MARK: Reading

    func setPaused(_ paused: Bool) {
        data.paused = paused
        commit()
    }

    var pendingQuick: [Item] { data.items.filter { $0.status == "pending" && $0.stage == "quick_pick" } }
    var pendingRefine: [Item] { data.items.filter { $0.status == "pending" && $0.stage == "refine" } }
    var proposedRules: [Rule] { data.rules.filter { $0.status == "proposed" } }
    var waitingCount: Int { pendingQuick.count + pendingRefine.count + proposedRules.count }

    var projects: [String] {
        var seen: [String] = []
        // Only projects with something to show: a card that was answered and left nothing isn't a board.
        let kept = data.strips.map(\.project)  // retired ones too, so their shelf can be reached
        let ruled = data.rules.filter { $0.status == "accepted" }.map(\.project)
        let waiting = data.items.filter { $0.status == "pending" }.map(\.project)
        for name in kept + ruled + waiting where !seen.contains(name) {
            seen.append(name)
        }
        return seen
    }

    func path(of file: String) -> String { mediaDir.appendingPathComponent(file).path }
}
