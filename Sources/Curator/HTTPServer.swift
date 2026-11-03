import Foundation
import Network

struct Request {
    var method: String
    var path: String
    var query: [String: String]
    var headers: [String: String]
    var body: Data

    var json: [String: Any] {
        (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
    }
}

struct Response {
    var status: Int = 200
    var contentType: String = "application/json"
    var body: Data = Data()
    var headers: [String: String] = [:]

    static func json(_ value: Any, status: Int = 200) -> Response {
        let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
        return Response(status: status, contentType: "application/json", body: data)
    }
    static func error(_ message: String, status: Int = 400) -> Response {
        json(["error": message], status: status)
    }
}

/// A small HTTP/1.1 server, bound to loopback only. Every connection carries one request.
final class HTTPServer {
    private var listener: NWListener?
    private let handler: (Request) -> Response
    private(set) var port: UInt16 = 0
    private let maxBody = 24 * 1024 * 1024  // room for a marked-up picture

    init(handler: @escaping (Request) -> Response) {
        self.handler = handler
    }

    func start(onReady: @escaping (UInt16) -> Void) throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        parameters.allowLocalEndpointReuse = true
        let listener = try NWListener(using: parameters)
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            if case .ready = state, let port = listener?.port?.rawValue {
                self?.port = port
                onReady(port)
            }
            if case .failed(let error) = state {
                NSLog("Curator: server failed: \(error)")
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            connection.start(queue: .main)
            self?.read(connection, buffer: Data())
        }
        listener.start(queue: .main)
        self.listener = listener
    }

    private func read(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, done, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if buffer.count > self.maxBody {
                self.write(.error("request too large", status: 413), to: connection)
                return
            }
            if let request = self.parse(buffer) {
                self.write(self.handler(request), to: connection)
            } else if done || error != nil {
                connection.cancel()
            } else {
                self.read(connection, buffer: buffer)
            }
        }
    }

    private func parse(_ buffer: Data) -> Request? {
        let separator = Data("\r\n\r\n".utf8)
        guard let end = buffer.range(of: separator),
              let head = String(data: buffer[buffer.startIndex..<end.lowerBound], encoding: .utf8) else { return nil }
        var lines = head.components(separatedBy: "\r\n")
        let parts = lines.removeFirst().split(separator: " ", maxSplits: 2).map(String.init)
        guard parts.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        let bodyStart = end.upperBound
        guard buffer.count - (bodyStart - buffer.startIndex) >= length else { return nil }
        let body = buffer[bodyStart..<(bodyStart + length)]

        let target = parts[1].split(separator: "?", maxSplits: 1).map(String.init)
        var query: [String: String] = [:]
        if target.count > 1 {
            for pair in target[1].split(separator: "&") {
                let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
                guard let key = kv.first else { continue }
                query[key] = kv.count > 1 ? (kv[1].removingPercentEncoding ?? kv[1]) : ""
            }
        }
        let path = (target.first ?? "/").removingPercentEncoding ?? "/"
        return Request(method: parts[0], path: path, query: query, headers: headers, body: Data(body))
    }

    private func write(_ response: Response, to connection: NWConnection) {
        let reason = [200: "OK", 206: "Partial Content", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
                      404: "Not Found", 413: "Too Large", 416: "Range Not Satisfiable"][response.status] ?? "Status"
        let extra = response.headers.map { "\($0.key): \($0.value)\r\n" }.sorted().joined()
        let head = "HTTP/1.1 \(response.status) \(reason)\r\n"
            + "Content-Type: \(response.contentType)\r\n"
            + extra
            + "Content-Length: \(response.body.count)\r\n"
            + "Cache-Control: no-store\r\n"
            + "Connection: close\r\n\r\n"
        var out = Data(head.utf8)
        out.append(response.body)
        connection.send(content: out, completion: .contentProcessed { _ in connection.cancel() })
    }

    /// "bytes=a-b", "bytes=a-" or "bytes=-n" as an inclusive range within the file. Only one range.
    static func byteRange(_ header: String, size: Int) -> (Int, Int)? {
        guard header.hasPrefix("bytes="), size > 0 else { return nil }
        let spec = header.dropFirst("bytes=".count).split(separator: ",").first.map(String.init) ?? ""
        let ends = spec.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        guard ends.count == 2 else { return nil }
        if ends[0].isEmpty {
            guard let n = Int(ends[1]), n > 0 else { return nil }
            return (max(0, size - n), size - 1)
        }
        guard let start = Int(ends[0]), start < size else { return nil }
        let end = ends[1].isEmpty ? size - 1 : min(Int(ends[1]) ?? -1, size - 1)
        return end >= start ? (start, end) : nil
    }

    static func contentType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "gif": return "image/gif"
        case "glb": return "model/gltf-binary"
        case "mp4", "m4v": return "video/mp4"
        case "mov": return "video/quicktime"
        case "webm": return "video/webm"
        default: return "application/octet-stream"
        }
    }
}
