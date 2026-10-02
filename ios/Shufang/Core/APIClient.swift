import Foundation

struct ServerConfiguration: Equatable {
    static let defaultAddress = "https://us.jiusi.org"
    static func validatedOrigin(_ address: String) throws -> URL {
        guard let c = URLComponents(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = c.host, !host.isEmpty,
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
              c.path.isEmpty || c.path == "/",
              let scheme = c.scheme?.lowercased() else { throw APIError.invalidAddress }
        var permitted = scheme == "https"
        #if DEBUG
        permitted = permitted || (scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host))
        #endif
        guard permitted, let url = c.url else { throw APIError.invalidAddress }
        return url
    }
    static func sameOrigin(_ first: String, _ second: String) -> Bool {
        guard let left = try? validatedOrigin(first),
              let right = try? validatedOrigin(second) else { return false }
        func port(_ url: URL) -> Int {
            url.port ?? (url.scheme?.lowercased() == "https" ? 443 : 80)
        }
        return left.scheme?.lowercased() == right.scheme?.lowercased()
            && left.host?.lowercased() == right.host?.lowercased()
            && port(left) == port(right)
    }
    let origin: URL
    let userID: String
    let sessionToken: String
    let expiresAt: Date
    init(address: String, userID: String, sessionToken: String, expiresAt: Date,
         allowExpired: Bool = false) throws {
        let url = try Self.validatedOrigin(address)
        guard !userID.isEmpty, !sessionToken.isEmpty,
              sessionToken.allSatisfy({ $0.isASCII &&
                  ($0.isLetter || $0.isNumber || "-_.".contains($0)) }),
              (allowExpired || expiresAt > Date()) else { throw APIError.invalidSession }
        origin = url
        self.userID = userID
        self.sessionToken = sessionToken
        self.expiresAt = expiresAt
    }
    func endpoint(_ components: [String], version: Int = 1) throws -> URL {
        guard components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
              var url = URLComponents(url: origin, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidAddress
        }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        url.percentEncodedPath = "/api/v\(version)/" + components.map {
            $0.addingPercentEncoding(withAllowedCharacters: allowed)!
        }.joined(separator: "/")
        guard let result = url.url else { throw APIError.invalidAddress }
        return result
    }
    static func authEndpoint(_ origin: URL, _ action: String) -> URL {
        origin.appending(path: "api/auth/\(action)")
    }
}
enum APIError: LocalizedError {
    case invalidAddress, invalidSession, invalidResponse, serverNeedsUpdate, http(Int)
    var errorDescription: String? {
        switch self {
        case .invalidAddress: return "请输入 HTTPS 服务器源地址，例如 https://books.example.com，不含路径、查询或账号。调试版仅允许 localhost 使用 HTTP。"
        case .invalidSession: return "登录会话已失效，请重新输入账号密码。"
        case .invalidResponse: return "服务器返回的数据不符合书房接口格式。"
        case .serverNeedsUpdate: return "服务器尚未开放账户会话访问原生 App，请先更新服务器。"
        case .http(401), .http(403): return "账号密码错误，或登录会话已失效。"
        case .http(428): return "服务器账户尚未完成首次设置，请先在网页完成账户设置。"
        case .http(404): return "资源不存在，可能已在其他设备删除，请刷新列表。"
        case .http(409): return "数据发生冲突，请刷新后重试。"
        case .http(503): return "服务不可用，请检查数据库和服务器状态。"
        case .http(let status): return "请求失败（HTTP \(status)），请检查服务器。"
        }
    }
}
// Never forward the custom authentication header to a redirected destination.
final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
final class APIClient {
    let configuration: ServerConfiguration
    var onUnauthorized: (() -> Void)?
    var onUnavailable: (() -> Void)?
    private let routeLock = NSLock()
    private var route: ServerConfiguration
    private var routeLeases = 0
    private var routeAvailable = true
    func suspendRoute() { routeLock.withLock { routeAvailable = false } }
    var transportConfiguration: ServerConfiguration { routeLock.withLock { route } }
    func beginRouteLease() { routeLock.withLock { routeLeases += 1 } }
    func endRouteLease() { routeLock.withLock { routeLeases = max(0, routeLeases - 1) } }
    @discardableResult
    func useRoute(_ configuration: ServerConfiguration) -> Bool {
        routeLock.withLock {
            guard routeLeases == 0, configuration.userID == self.configuration.userID else { return false }
            route = configuration
            routeAvailable = true
            capabilities = nil; checkedCapabilities = false
            return true
        }
    }
    private(set) var capabilities: SyncCapabilities?
    private var checkedCapabilities = false
    private(set) var serverDate: Date?
    private let session: URLSession
    private struct LoginResponse: Decodable {
        struct User: Decodable { let id: String }
        let user: User
        let expiresAt: Double
        let setupRequired: Bool
    }
    static func login(address: String, username: String, password: String,
                      session: URLSession? = nil) async throws -> ServerConfiguration {
        let origin = try ServerConfiguration.validatedOrigin(address)
        let settings = URLSessionConfiguration.ephemeral
        settings.httpShouldSetCookies = false
        let transport = session ?? URLSession(configuration: settings,
            delegate: NoRedirectDelegate(), delegateQueue: nil)
        var request = URLRequest(url: ServerConfiguration.authEndpoint(origin, "login"))
        request.timeoutInterval = 8
        request.httpMethod = "POST"
        request.setValue(origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
                         forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "appId": username, "appSecret": password
        ])
        let (data, response) = try await transport.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200...299).contains(response.statusCode) else { throw APIError.http(response.statusCode) }
        let login = try JSONDecoder().decode(LoginResponse.self, from: data)
        guard !login.setupRequired else { throw APIError.http(428) }
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { result, item in
            if let key = item.key as? String, let value = item.value as? String { result[key] = value }
        }
        guard let cookie = HTTPCookie.cookies(withResponseHeaderFields: headers, for: origin)
            .first(where: { $0.name == "shufang_session" }) else { throw APIError.invalidResponse }
        return try ServerConfiguration(address: origin.absoluteString, userID: login.user.id,
            sessionToken: cookie.value, expiresAt: Date(timeIntervalSince1970: login.expiresAt / 1000))
    }
    init(configuration: ServerConfiguration, session: URLSession? = nil, route: ServerConfiguration? = nil) {
        self.configuration = configuration
        self.route = route ?? configuration
        let settings = URLSessionConfiguration.ephemeral
        settings.timeoutIntervalForRequest = 30
        settings.urlCache = nil
        settings.httpShouldSetCookies = false
        self.session = session ?? URLSession(configuration: settings, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }
    func request<T: Decodable>(_ path: [String], method: String = "GET", body: Data? = nil,
                               timeout: TimeInterval = 30, version: Int = 1,
                               query: [URLQueryItem] = []) async throws -> T {
        let data = try await data(path, method: method, body: body, timeout: timeout,
                                  version: version, query: query)
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError.invalidResponse }
    }
    func data(_ path: [String], method: String = "GET", body: Data? = nil,
              timeout: TimeInterval = 30, version: Int = 1,
              query: [URLQueryItem] = [], headers: [String: String] = [:]) async throws -> Data {
        let configuration = try routeLock.withLock {
            guard routeAvailable else { throw URLError(.cannotConnectToHost) }
            return route
        }
        if configuration.expiresAt <= Date() {
            onUnauthorized?()
            throw APIError.invalidSession
        }
        var components = URLComponents(url: try configuration.endpoint(path, version: version),
                                       resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw APIError.invalidAddress }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = timeout
        request.setValue("shufang_session=\(configuration.sessionToken)", forHTTPHeaderField: "Cookie")
        if method != "GET" && method != "HEAD" {
            request.setValue(configuration.origin.absoluteString.trimmingCharacters(in:
                CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin")
        }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        for (key, value) in headers where ["content-type", "x-chunk-sha256"].contains(key.lowercased()) {
            request.setValue(value, forHTTPHeaderField: key)
        }
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch {
            if (error as? URLError)?.code != .cancelled { onUnavailable?() }
            throw error // Never automatically replay a write with an unknown outcome.
        }
        guard let response = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        if response.statusCode == 401 && configuration == transportConfiguration { onUnauthorized?() }
        if [502, 503, 504].contains(response.statusCode) { onUnavailable?() }
        guard (200...299).contains(response.statusCode) else { throw APIError.http(response.statusCode) }
        if let date = response.value(forHTTPHeaderField: "Date") {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
            serverDate = formatter.date(from: date)
        }
        return data
    }
    @discardableResult
    func detectSync() async throws -> SyncCapabilities? {
        if checkedCapabilities { return capabilities }
        do {
            let result: SyncCapabilities = try await request(["capabilities"], version: 2)
            guard result.version == 2 else { throw APIError.invalidResponse }
            capabilities = result
        } catch APIError.http(404) { capabilities = nil }
        checkedCapabilities = true
        return capabilities
    }
    func dueReviews() async throws -> ReviewResponse {
        guard try await detectSync() != nil else { return try await request(["review", "due"]) }
        let response: HighlightsResponse = try await request(["highlights"])
        let now = (serverDate ?? Date()).timeIntervalSince1970 * 1000
        return ReviewResponse(now: now, cards: response.highlights.filter {
            guard let review = $0.review else { return false }
            return review.due <= now
        }.sorted { $0.review!.due < $1.review!.due })
    }
    func saveProgress(book: String, chapter: String) async throws {
        guard try await detectSync() != nil else { return }
        try await write(["books", book], method: "PATCH",
            body: ProgressPatch(progress: ReadingProgress(chapterId: chapter, ratio: 0)))
    }
    func pushReadingSession(_ item: ReadingSession, replicaID: String) async throws {
        guard let caps = try await detectSync() else { return }
        let operation = ReadingSessionOperation(workspaceId: caps.workspaceId,
            operationId: UUID().uuidString.lowercased(), replicaId: replicaID,
            entityId: item.bookId, clock: "\(Int(Date().timeIntervalSince1970 * 1000)):0",
            patch: ["@readingSession:\(item.id)": item])
        let response: ReadingSessionPushResponse = try await request(["sync", "push"],
            method: "POST", body: JSONEncoder().encode(ReadingSessionPush(operations: [operation])),
            version: 2)
        guard response.receipts.count == 1, response.receipts[0].operationId == operation.operationId,
              response.receipts[0].error == nil else { throw APIError.invalidResponse }
    }
    func fetchReadingSessions() async throws -> [ReadingSession] {
        beginRouteLease(); defer { endRouteLease() }
        guard try await detectSync() != nil else { return [] }
        var after: String?
        var result: [ReadingSession] = []
        repeat {
            let bytes = try await data(["entities"], version: 2,
                query: [URLQueryItem(name: "kind", value: "books")] +
                    (after.map { [URLQueryItem(name: "after", value: $0)] } ?? []))
            guard let page = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                  let entities = page["entities"] as? [[String: Any]] else {
                throw APIError.invalidResponse
            }
            for entity in entities where entity["deleted"] as? Bool != true {
                guard let fields = entity["fields"] as? [String: [String: Any]] else { continue }
                for (key, field) in fields where key.hasPrefix("@readingSession:") {
                    guard let value = field["value"],
                          let bytes = try? JSONSerialization.data(withJSONObject: value),
                          let session = try? JSONDecoder().decode(ReadingSession.self, from: bytes)
                    else { continue }
                    result.append(session)
                }
            }
            after = page["next"] as? String
        } while after != nil
        return ReadingTime.merge(result)
    }
    func write<B: Encodable>(_ path: [String], method: String = "POST", body: B) async throws {
        let response: WriteResponse = try await request(path, method: method, body: JSONEncoder().encode(body))
        guard response.ok else { throw APIError.invalidResponse }
    }
}
private struct ReadingSessionOperation: Encodable {
    let workspaceId: String
    let operationId: String
    let replicaId: String
    let entityId: String
    let clock: String
    let patch: [String: ReadingSession]
    let kind = "books"
    let unset: [String] = []
    let deleted = false
}
private struct ReadingSessionPush: Encodable { let operations: [ReadingSessionOperation] }
private struct ReadingSessionPushResponse: Decodable {
    struct Receipt: Decodable { let operationId: String; let error: String? }
    let receipts: [Receipt]
}
