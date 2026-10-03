import XCTest
@testable import ShufangCore

private final class RouteProtocol: URLProtocol {
    static var received: [URLRequest] = []
    static var failure: Error?
    static var responseBody: ((URLRequest) -> Data)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.received.append(request)
        if let error = Self.failure { client?.urlProtocol(self, didFailWithError: error); return }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200,
            httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody?(request) ?? Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class AccountRouteTests: XCTestCase {
    func config(_ host: String, token: String = "session", user: String = "reader") throws -> ServerConfiguration {
        try ServerConfiguration(address: "https://\(host)", userID: user, sessionToken: token,
            expiresAt: Date().addingTimeInterval(3600))
    }
    func testFastestFallbackManualAndHysteresis() {
        let samples: [RouteMeasurement] = [.init(address: "cloud", milliseconds: 180), .init(address: "home", milliseconds: 10)]
        XCTAssertEqual(RouteSelection.best(samples, current: "cloud", manual: nil), "home")
        XCTAssertEqual(RouteSelection.best(samples, current: "home", manual: "cloud"), "cloud")
        XCTAssertNil(RouteSelection.best(samples, current: "cloud", manual: "missing"))
        XCTAssertEqual(RouteSelection.best([.init(address: "cloud", milliseconds: 30), .init(address: "home", milliseconds: 20)], current: "cloud", manual: nil), "cloud")
        XCTAssertEqual(RouteSelection.best([.init(address: "cloud", milliseconds: 150), .init(address: "home", message: "offline")], current: "home", manual: nil), "cloud")
        XCTAssertNil(RouteSelection.best([], current: "cloud", manual: nil))
    }
    func testIdentityRequiresBothAccountAndWorkspace() throws {
        let account = AccountRoutes(anchorAddress: "https://cloud", userID: "reader", workspaceID: "w", addresses: ["https://cloud", "https://home"])
        XCTAssertTrue(account.accepts(userID: "reader", workspaceID: "w"))
        XCTAssertFalse(account.accepts(userID: "other", workspaceID: "w"))
        XCTAssertFalse(account.accepts(userID: "reader", workspaceID: "other"))
        XCTAssertEqual(try JSONDecoder().decode(AccountRoutes.self, from: JSONEncoder().encode(account)), account)
    }
    func testRouteSwitchKeepsStorageAnchorAndPinsTransactions() throws {
        let cloud = try config("cloud.example"), home = try config("home.example")
        let client = APIClient(configuration: cloud)
        client.beginRouteLease()
        XCTAssertFalse(client.useRoute(home))
        XCTAssertEqual(client.transportConfiguration, cloud)
        client.endRouteLease()
        XCTAssertTrue(client.useRoute(home))
        XCTAssertEqual(client.configuration, cloud)
        XCTAssertFalse(client.useRoute(try config("wrong.example", user: "someone-else")))
    }
    func testRequestsUseOnlyDestinationSessionAndDoNotReplayFailedWrites() async throws {
        RouteProtocol.received = []; RouteProtocol.failure = nil
        defer { RouteProtocol.failure = nil }
        let settings = URLSessionConfiguration.ephemeral; settings.protocolClasses = [RouteProtocol.self]
        let client = APIClient(configuration: try config("cloud.example", token: "cloud-token"),
            session: URLSession(configuration: settings))
        XCTAssertTrue(client.useRoute(try config("home.example", token: "home-token")))
        _ = try await client.data(["notes"], method: "POST", body: Data("{}".utf8))
        XCTAssertEqual(RouteProtocol.received.last?.url?.host, "home.example")
        XCTAssertEqual(RouteProtocol.received.last?.value(forHTTPHeaderField: "Cookie"), "shufang_session=home-token")
        XCTAssertEqual(RouteProtocol.received.last?.value(forHTTPHeaderField: "Origin"), "https://home.example")
        client.suspendRoute()
        do { _ = try await client.data(["notes"]); XCTFail() } catch {}
        XCTAssertEqual(RouteProtocol.received.count, 1)
        XCTAssertTrue(client.useRoute(try config("home.example", token: "home-token")))
        RouteProtocol.failure = URLError(.networkConnectionLost)
        var notified = false; client.onUnavailable = { notified = true }
        do { _ = try await client.data(["notes"], method: "POST", body: Data("{}".utf8)); XCTFail() } catch {}
        XCTAssertEqual(RouteProtocol.received.count, 2)
        XCTAssertTrue(notified)
    }
    @MainActor func testOldSnapshotAndPendingSurviveNewRoute() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let client = APIClient(configuration: try config("cloud.example"))
        let store = StudyStore(client: client, baseDirectory: root)
        try store.save(StudyNote(id: "offline", title: "待同步", content: "本地成果")); store.cancelSync()
        let pending = store.pendingCount
        XCTAssertTrue(client.useRoute(try config("home.example")))
        let reopened = StudyStore(client: client, baseDirectory: root)
        XCTAssertEqual(reopened.root, store.root)
        XCTAssertEqual(reopened.pendingCount, pending)
        XCTAssertEqual(reopened.notes.first?.content, "本地成果")
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: store.root.appendingPathComponent("workspace.json"))) as? [String: Any])
        json.removeValue(forKey: "cursorOrigin")
        let old = try JSONDecoder().decode(StudySnapshot.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertNil(old.cursorOrigin)
        XCTAssertEqual(old.pending.count, pending)
    }
    @MainActor func testSwitchStartsNewSnapshotWithoutSendingOtherNodeCursor() async throws {
        RouteProtocol.received = []; RouteProtocol.failure = nil
        RouteProtocol.responseBody = { request in
            let host = request.url!.host!
            let path = request.url!.path
            let body: String
            if path.hasSuffix("capabilities") {
                body = "{\"version\":2,\"workspaceId\":\"same\",\"nodeId\":\"\(host)\"}"
            } else if path.hasSuffix("snapshots") {
                body = "{\"id\":\"snapshot\",\"cursor\":\"\(host)\"}"
            } else if path.hasSuffix("snapshot") {
                body = "{\"entities\":[],\"next\":null,\"cursor\":\"\(host)\"}"
            } else {
                body = "{\"operations\":[],\"hasMore\":false,\"cursor\":\"\(host)\"}"
            }
            return Data(body.utf8)
        }
        defer { RouteProtocol.responseBody = nil }
        let settings = URLSessionConfiguration.ephemeral; settings.protocolClasses = [RouteProtocol.self]
        let client = APIClient(configuration: try config("cloud.example"), session: URLSession(configuration: settings))
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = StudyStore(client: client, baseDirectory: root)
        await store.sync(); XCTAssertNil(store.error)
        XCTAssertTrue(client.useRoute(try config("home.example")))
        await store.sync(); XCTAssertNil(store.error)
        let starts = RouteProtocol.received.filter { $0.url!.path.hasSuffix("snapshots") }
        XCTAssertEqual(starts.count, 2)
        let changes = RouteProtocol.received.filter { $0.url!.path.hasSuffix("changes") }
        XCTAssertGreaterThanOrEqual(changes.count, 2)
        for request in changes {
            let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "cursor" }?.value
            XCTAssertEqual(cursor, request.url!.host)
        }
    }
    @MainActor func testLaggingReplicaCannotEraseNewerFieldsOrTombstones() {
        let newer = StudyEntity(id: "a", kind: "notes", deleted: true, fields: ["title": .init(version: "003", value: .string("new"))])
        let older = StudyEntity(id: "a", kind: "notes", deleted: false, fields: ["title": .init(version: "001", value: .string("old")), "content": .init(version: "002", value: .string("body"))])
        let result = StudyStore.merged([newer.key: newer], [older.key: older])
        XCTAssertEqual(result[newer.key]?.fields["title"]?.value?.string, "new")
        XCTAssertEqual(result[newer.key]?.fields["content"]?.value?.string, "body")
        XCTAssertEqual(result[newer.key]?.deleted, true)
        XCTAssertNotNil(StudyStore.merged([newer.key: newer], [:])[newer.key])
    }
}
