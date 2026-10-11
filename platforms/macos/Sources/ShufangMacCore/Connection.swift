import CryptoKit
import Foundation

public struct Connection: Codable, Equatable {
    public let origin: URL
    public let userID: String
    public let workspaceID: String
    public let nodeID: String
    public let token: String
    public let expiresAt: Date
    public var scope: String {
        SHA256.hash(data: Data("\(origin.absoluteString)|\(userID)|\(workspaceID)".utf8))
            .map { String(format: "%02x", $0) }.joined()
    }
    public static func origin(_ input: String) throws -> URL {
        guard let parts = URLComponents(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = parts.host, parts.user == nil, parts.password == nil, parts.query == nil,
              parts.fragment == nil, ["", "/"].contains(parts.path),
              parts.scheme == "https" || (parts.scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)),
              let url = parts.url else { throw CoreError.rejected("请输入 HTTPS 服务器地址，本机测试可用 localhost") }
        return url
    }
}

private final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

public enum AccountClient {
    private static func transport() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        return URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }
    public static func login(address: String, username: String, password: String) async throws -> Connection {
        let origin = try Connection.origin(address)
        let transport = transport()
        defer { transport.finishTasksAndInvalidate() }
        var request = URLRequest(url: origin.appendingPathComponent("api/auth/login"))
        request.timeoutInterval = 15
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["appId": username, "appSecret": password])
        let (data, response) = try await transport.data(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let user = value["user"] as? [String: Any], let userID = user["id"] as? String,
              let expiry = value["expiresAt"] as? Double, value["setupRequired"] as? Bool == false else {
            throw CoreError.rejected("登录失败，请检查账号密码及服务器账户设置")
        }
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { values, item in
            if let key = item.key as? String, let value = item.value as? String { values[key] = value }
        }
        guard let token = HTTPCookie.cookies(withResponseHeaderFields: headers, for: origin).first(where: { $0.name == "shufang_session" })?.value,
              !token.isEmpty, token.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "-_.".contains($0)) }) else {
            throw CoreError.rejected("登录会话格式无效")
        }
        request = URLRequest(url: origin.appendingPathComponent("api/v2/capabilities"))
        request.timeoutInterval = 15
        request.setValue("shufang_session=\(token)", forHTTPHeaderField: "Cookie")
        let (capData, capResponse) = try await transport.data(for: request)
        guard let capResponse = capResponse as? HTTPURLResponse, capResponse.statusCode == 200,
              let caps = try JSONSerialization.jsonObject(with: capData) as? [String: Any],
              let workspace = caps["workspaceId"] as? String, !workspace.isEmpty,
              let node = caps["nodeId"] as? String, !node.isEmpty, caps["version"] as? Int == 2 else {
            throw CoreError.rejected("服务器尚未提供兼容的离线同步接口")
        }
        return Connection(origin: origin, userID: userID, workspaceID: workspace, nodeID: node,
                          token: token, expiresAt: Date(timeIntervalSince1970: expiry / 1000))
    }
    public static func logout(_ connection: Connection) async throws {
        let transport = transport()
        defer { transport.finishTasksAndInvalidate() }
        var request = URLRequest(url: connection.origin.appendingPathComponent("api/auth/logout"))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("shufang_session=\(connection.token)", forHTTPHeaderField: "Cookie")
        request.setValue(connection.origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin")
        let (_, response) = try await transport.data(for: request)
        guard let response = response as? HTTPURLResponse, [200, 204, 401].contains(response.statusCode) else {
            throw CoreError.rejected("无法确认服务器已退出，可先断开本机连接")
        }
    }
}
