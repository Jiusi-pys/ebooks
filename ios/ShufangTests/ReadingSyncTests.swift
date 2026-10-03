import XCTest
@testable import ShufangCore

final class ReadingSyncTests: XCTestCase {
    private func client() throws -> APIClient {
        let config = try ServerConfiguration(address: "https://reading.example", userID: "reader",
            sessionToken: "fixture", expiresAt: Date().addingTimeInterval(3600))
        let settings = URLSessionConfiguration.ephemeral
        settings.protocolClasses = [ReadingSyncProtocol.self]
        return APIClient(configuration: config, session: URLSession(configuration: settings))
    }
    override func tearDown() { ReadingSyncProtocol.respond = nil; super.tearDown() }

    func testUploadPinsRouteAndUsesAccountSession() async throws {
        let client = try client()
        let alternate = try ServerConfiguration(address: "https://alternate.example", userID: "reader",
            sessionToken: "other", expiresAt: Date().addingTimeInterval(3600))
        ReadingSyncProtocol.respond = { request in
            XCTAssertEqual(request.url?.host, "reading.example")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "shufang_session=fixture")
            XCTAssertNil(request.value(forHTTPHeaderField: "X-API-Key"))
            XCTAssertFalse(client.useRoute(alternate))
            if request.url!.path.hasSuffix("capabilities") {
                return (200, ["version": 2, "workspaceId": "personal", "nodeId": "node"])
            }
            XCTAssertEqual(request.url!.path, "/api/v2/sync/push")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://reading.example")
            var bytes = request.httpBody ?? Data()
            if let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }
                var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable {
                    let count = stream.read(&buffer, maxLength: buffer.count)
                    if count <= 0 { break }
                    bytes.append(contentsOf: buffer.prefix(count))
                }
            }
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
            let op = try XCTUnwrap((body["operations"] as? [[String: Any]])?.first)
            XCTAssertEqual(op["workspaceId"] as? String, "personal")
            XCTAssertEqual(op["kind"] as? String, "books")
            XCTAssertEqual(op["entityId"] as? String, "book")
            XCTAssertNotNil((op["patch"] as? [String: Any])?["@readingSession:session"])
            return (200, ["receipts": [["operationId": try XCTUnwrap(op["operationId"] as? String)] ]])
        }
        try await client.pushReadingSession(.init(id: "session", bookId: "book", startedAt: 1, endedAt: 2), replicaID: "device")
        XCTAssertTrue(client.useRoute(alternate))
    }

    func testPagesMergeCheckpointsAndIgnoreRemovedOrInvalidSessions() async throws {
        var pages = 0
        ReadingSyncProtocol.respond = { request in
            if request.url!.path.hasSuffix("capabilities") {
                return (200, ["version": 2, "workspaceId": "personal", "nodeId": "node"])
            }
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
            XCTAssertEqual(query.first { $0.name == "kind" }?.value, "books")
            pages += 1
            func field(_ id: String, _ book: String = "book", end: Int = 20, removed: Bool = false) -> [String: Any] {
                ["version": "1:0:device", "removed": removed,
                 "value": ["id": id, "bookId": book, "startedAt": 10, "endedAt": end]]
            }
            if pages == 1 {
                XCTAssertNil(query.first { $0.name == "after" })
                return (200, ["entities": [
                    ["id": "book", "kind": "books", "fields": [
                        "@readingSession:a": field("a"),
                        "@readingSession:removed": field("removed", removed: true),
                        "@readingSession:wrong-book": field("wrong-book", "another"),
                        "@readingSession:wrong-key": field("other"),
                        "@readingSession:reversed": field("reversed", end: 5)]],
                    ["id": "book", "deleted": true, "fields": ["@readingSession:deleted": field("deleted")]]
                ], "next": "books:book"])
            }
            XCTAssertEqual(query.first { $0.name == "after" }?.value, "books:book")
            return (200, ["entities": [["id": "book", "fields": ["@readingSession:a": field("a", end: 30)]]], "next": NSNull()])
        }
        let sessions = try await client().fetchReadingSessions()
        XCTAssertEqual(sessions, [.init(id: "a", bookId: "book", startedAt: 10, endedAt: 30)])
        XCTAssertEqual(pages, 2)
    }

    func testRepeatedCursorFailsInsteadOfLooping() async throws {
        var pages = 0
        ReadingSyncProtocol.respond = { request in
            if request.url!.path.hasSuffix("capabilities") {
                return (200, ["version": 2, "workspaceId": "personal", "nodeId": "node"])
            }
            pages += 1
            return (200, ["entities": [], "next": "books:stuck"])
        }
        do { _ = try await client().fetchReadingSessions(); XCTFail("Must reject a repeated cursor") }
        catch APIError.invalidResponse {}
        XCTAssertEqual(pages, 2)
    }

    func testFailedReceiptIsNotAcknowledgedAndReleasesRoute() async throws {
        let client = try client()
        ReadingSyncProtocol.respond = { request in
            if request.url!.path.hasSuffix("capabilities") {
                return (200, ["version": 2, "workspaceId": "personal", "nodeId": "node"])
            }
            return (200, ["receipts": [["operationId": "wrong", "error": "sync_unavailable"]]])
        }
        do {
            try await client.pushReadingSession(.init(id: "a", bookId: "book", startedAt: 1, endedAt: 2), replicaID: "device")
            XCTFail("Must reject a failed receipt")
        } catch APIError.invalidResponse {}
        XCTAssertTrue(client.useRoute(client.configuration))
    }
}

private final class ReadingSyncProtocol: URLProtocol {
    static var respond: ((URLRequest) throws -> (Int, [String: Any]))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, body) = try Self.respond!(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
                httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: try JSONSerialization.data(withJSONObject: body))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
