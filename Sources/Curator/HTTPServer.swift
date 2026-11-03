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
    private let maxBody = 8 * 1024 * 1024

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
        let reason = [200: "OK", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
                      404: "Not Found", 413: "Too Large"][response.status] ?? "Status"
        let head = "HTTP/1.1 \(response.status) \(reason)\r\n"
            + "Content-Type: \(response.contentType)\r\n"
            + "Content-Length: \(response.body.count)\r\n"
            + "Cache-Control: no-store\r\n"
            + "Connection: close\r\n\r\n"
        var out = Data(head.utf8)
        out.append(response.body)
        connection.send(content: out, completion: .contentProcessed { _ in connection.cancel() })
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
        default: return "application/octet-stream"
        }
    }
}
