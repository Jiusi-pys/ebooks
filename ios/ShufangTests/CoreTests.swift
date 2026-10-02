import XCTest
@testable import ShufangCore

final class CoreTests: XCTestCase {
    func testReadingTimeMergesCheckpointsAndOverlappingDevices() {
        let first = ReadingSession(id: "a", bookId: "book", startedAt: 1000, endedAt: 5000)
        let checkpoint = ReadingSession(id: "a", bookId: "book", startedAt: 1000, endedAt: 9000)
        let second = ReadingSession(id: "b", bookId: "book", startedAt: 7000, endedAt: 12000)
        XCTAssertEqual(ReadingTime.merge([first, checkpoint, second]).count, 2)
        XCTAssertEqual(ReadingTime.duration([first, checkpoint, second]), 11000)
        XCTAssertEqual(ReadingTime.label(11000), "11 秒")
    }
    func testConfigurationRejectsUnsafeOrigins() throws {
        for address in ["http://books.example.com", "https://user:password@example.com", "https://example.com/api/v1", "https://example.com?key=secret", "https://example.com#fragment", "file:///tmp/test"] {
            XCTAssertThrowsError(try ServerConfiguration(address: address, userID: "reader", sessionToken: "key", expiresAt: Date().addingTimeInterval(3600)), address)
        }
        XCTAssertThrowsError(try ServerConfiguration(address: "https://example.com", userID: "reader", sessionToken: " \n", expiresAt: Date().addingTimeInterval(3600)))
        XCTAssertThrowsError(try ServerConfiguration(address: "https://example.com", userID: "reader", sessionToken: "key\nvalue", expiresAt: Date().addingTimeInterval(3600)))
        XCTAssertTrue(ServerConfiguration.sameOrigin("https://us.jiusi.org",
            "https://us.jiusi.org/"))
        XCTAssertTrue(ServerConfiguration.sameOrigin("https://us.jiusi.org:443/",
            "https://us.jiusi.org"))
        XCTAssertFalse(ServerConfiguration.sameOrigin("https://us.jiusi.org",
            "https://other.jiusi.org"))
    }
    func testExpiredStoredSessionAvoidsNetwork() async throws {
        let config = try ServerConfiguration(address: "https://example.com", userID: "reader",
            sessionToken: "signed.token", expiresAt: Date().addingTimeInterval(-60),
            allowExpired: true)
        let client = APIClient(configuration: config)
        var expired = false
        client.onUnauthorized = { expired = true }
        do {
            let _: BooksResponse = try await client.request(["books"])
            XCTFail("Expired session must not reach the network")
        } catch APIError.invalidSession { }
        XCTAssertTrue(expired)
    }
    func testHTTPIsRestrictedToDebugLoopback() throws {
        #if DEBUG
        XCTAssertNoThrow(try ServerConfiguration(address: "http://127.0.0.1:8787", userID: "reader", sessionToken: "test", expiresAt: Date().addingTimeInterval(3600)))
        #else
        XCTAssertThrowsError(try ServerConfiguration(address: "http://127.0.0.1:8787", userID: "reader", sessionToken: "test", expiresAt: Date().addingTimeInterval(3600)))
        #endif
        XCTAssertThrowsError(try ServerConfiguration(address: "http://192.168.1.1", userID: "reader", sessionToken: "test", expiresAt: Date().addingTimeInterval(3600)))
    }
    func testEndpointEncodesUntrustedBookIDs() throws {
        let config = try ServerConfiguration(address: "https://example.com/", userID: "reader", sessionToken: "key", expiresAt: Date().addingTimeInterval(3600))
        XCTAssertEqual(config.sessionToken, "key")
        let url = try config.endpoint(["books", "书/一?#", "chapters", "0"])
        XCTAssertEqual(url.host, "example.com")
        XCTAssertNil(url.query)
        XCTAssertNil(url.fragment)
        XCTAssertTrue(url.absoluteString.contains("%2F"))
        XCTAssertThrowsError(try config.endpoint(["books", "..", "chapters"]))
    }
    func testDecodesActualServerResponseShapes() throws {
        let json = #"{"books":[{"extId":"b1","title":"论语","author":"孔子","format":"epub","folder":"经典","chapterCount":1,"metadata":{},"contentHash":"","createdAt":"2026-01-01T00:00:00Z"}]}"#
        let books = try JSONDecoder().decode(BooksResponse.self, from: Data(json.utf8))
        XCTAssertEqual(books.books.first?.id, "b1")
        let chapters = #"{"chapters":[{"id":"c1","index":0,"title":"学而","paragraphs":2,"chars":50}]}"#
        XCTAssertEqual(try JSONDecoder().decode(ChaptersResponse.self, from: Data(chapters.utf8)).chapters.first?.paragraphs, 2)
        let notes = #"{"notes":[{"extId":"n1","title":"笔记","chars":10}]}"#
        XCTAssertNil(try JSONDecoder().decode(NotesResponse.self, from: Data(notes.utf8)).notes.first?.content)
        XCTAssertThrowsError(try JSONDecoder().decode(NoteDetail.self, from: Data(#"{"extId":"n1","title":"missing content"}"#.utf8)))
        let review = #"{"now":1700000000000,"count":1,"cards":[{"extId":"h1","bookExtId":"b1","bookTitle":"论语","chapterTitle":"学而","text":"学而时习之","cloze":["习"],"review":{"due":1700000000000,"reps":0,"lapses":0,"interval":0,"addedAt":1700000000000}}]}"#
        XCTAssertEqual(try JSONDecoder().decode(ReviewResponse.self, from: Data(review.utf8)).cards.first?.review?.reps, 0)
    }
    func testHighlightUsesJavaScriptUTF16Offsets() throws {
        let body = HighlightWrite(extId: "h1", bookExtId: "b1", bookTitle: "书",
            chapterId: "c1", chapterTitle: "章", text: "📚文", paraIndex: 3,
            start: 1, end: 4, note: "", review: nil)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        XCTAssertEqual(object["end"] as? Int, 4)
        XCTAssertEqual(object["start"] as? Int, 1)
        XCTAssertEqual(object["paraIndex"] as? Int, 3)
        XCTAssertNil(object["review"])
    }
    func testAskIncludesSelectedText() throws {
        let body = AskWrite(question: "这句话怎么理解？", title: "书", chapterTitle: "章",
                            chapterContext: "上下文", selection: "所选片段")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        XCTAssertEqual(object["selection"] as? String, "所选片段")
    }
    func testReviewMatchesWebScheduling() {
        let state = ReviewState.new(now: 1000)
        XCTAssertEqual(state.graded(1, now: 1000).due, 301000)
        XCTAssertEqual(state.graded(1, now: 1000).lapses, 1)
        XCTAssertEqual(state.graded(2, now: 1000).due, 601000)
        XCTAssertEqual(state.graded(3, now: 1000).interval, 1)
        XCTAssertEqual(state.graded(4, now: 1000).interval, 2)
        var later = state; later.reps = 2; later.interval = 5
        XCTAssertEqual(later.graded(2, now: 1000).interval, 6)
        XCTAssertEqual(later.graded(3, now: 1000).interval, 11)
        XCTAssertEqual(later.graded(4, now: 1000).interval, 16)
        XCTAssertEqual(later.graded(3, now: 1000).addedAt, state.addedAt)
    }
    func testAuthenticatedRequestAndServerFailures() async throws {
        let settings = URLSessionConfiguration.ephemeral
        settings.protocolClasses = [StubProtocol.self]
        let session = URLSession(configuration: settings)
        let client = APIClient(configuration: try .init(address: "https://example.com", userID: "reader", sessionToken: "test-only", expiresAt: Date().addingTimeInterval(3600)), session: session)
        let books: BooksResponse = try await client.request(["books"])
        XCTAssertTrue(books.books.isEmpty)
        for status in [401, 404, 409, 500, 503] {
            do {
                let _: BooksResponse = try await client.request([String(status)])
                XCTFail("Expected HTTP error")
            } catch APIError.http(let actual) { XCTAssertEqual(actual, status) }
        }
        do {
            let _: BooksResponse = try await client.request(["malformed"])
            XCTFail("Expected decoding failure")
        } catch APIError.invalidResponse { }
        try await client.write(["notes"], body: NoteWrite(extId: "n", title: "title", content: "text"))
        do {
            let _: BooksResponse = try await client.request(["offline"])
            XCTFail("Expected network error")
        } catch let error as URLError { XCTAssertEqual(error.code, .notConnectedToInternet) }
    }
    func testAccountLoginUsesSignedSessionWithoutAPIKey() async throws {
        LoginStubProtocol.attempts = 0
        let settings = URLSessionConfiguration.ephemeral
        settings.protocolClasses = [LoginStubProtocol.self]
        let session = URLSession(configuration: settings)
        let config = try await APIClient.login(address: "https://reader.example",
            username: "owner", password: "correct-password", session: session)
        XCTAssertEqual(config.userID, "owner")
        XCTAssertEqual(config.sessionToken, "signed.token")
        XCTAssertThrowsError(try ServerConfiguration(address: "https://reader.example",
            userID: "owner", sessionToken: config.sessionToken,
            expiresAt: Date().addingTimeInterval(-1)))
        do {
            _ = try await APIClient.login(address: "https://reader.example",
                username: "owner", password: "wrong-password", session: session)
            XCTFail("Invalid credentials must fail")
        } catch APIError.http(401) { }
    }
    func testRedirectIsRefused() {
        let delegate = NoRedirectDelegate()
        let session = URLSession(configuration: .ephemeral)
        let task = session.dataTask(with: URL(string: "https://example.com")!)
        let response = HTTPURLResponse(url: URL(string: "https://example.com")!, statusCode: 302, httpVersion: nil, headerFields: nil)!
        delegate.urlSession(session, task: task, willPerformHTTPRedirection: response, newRequest: URLRequest(url: URL(string: "https://other.example")!)) { redirected in
            XCTAssertNil(redirected)
        }
    }
}
final class LoginStubProtocol: URLProtocol {
    static var attempts = 0
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTAssertEqual(request.url?.path, "/api/auth/login")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://reader.example")
        XCTAssertNil(request.value(forHTTPHeaderField: "X-API-Key"))
        let valid = Self.attempts == 0
        Self.attempts += 1
        let headers = valid ? ["Set-Cookie": "shufang_session=signed.token; Path=/; HttpOnly; SameSite=Strict"] : [:]
        let response = HTTPURLResponse(url: request.url!, statusCode: valid ? 200 : 401,
            httpVersion: nil, headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let responseBody = valid
            ? #"{"user":{"id":"owner"},"expiresAt":4102444800000,"setupRequired":false}"#
            : #"{"error":"invalid_credentials"}"#
        client?.urlProtocol(self, didLoad: Data(responseBody.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}

final class StubProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "shufang_session=test-only")
        XCTAssertNil(request.value(forHTTPHeaderField: "X-API-Key"))
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
        let path = request.url!.lastPathComponent
        if path == "offline" {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let status = Int(path) ?? 200
        let body = path == "malformed" ? "<html>" : path == "notes" ? #"{"ok":true}"# : #"{"books":[]}"#
        if path == "notes" {
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

extension CoreTests {
    func testV2MaterializedBooksAndChapters() throws {
        let json = #"{"books":[{"id":"b","extId":"b","title":"论语","author":"孔子","format":"epub","folderId":"classics","progress":{"chapterId":"c2","ratio":0.4},"chapters":[{"id":"c1","title":"学而","paragraphs":["学📚文"]},{"id":"c2","title":"为政","paragraphs":[]}]}]}"#
        let response = try JSONDecoder().decode(BooksResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.books.first?.chapterCount, 2)
        XCTAssertEqual(response.books.first?.folder, "classics")
        XCTAssertEqual(response.books.first?.progress?.chapterId, "c2")
        let chapters = #"{"chapters":[{"id":"c1","title":"学而","paragraphs":["学📚文"]},{"id":"c2","title":"为政","paragraphs":[]}]}"#
        let toc = try JSONDecoder().decode(ChaptersResponse.self, from: Data(chapters.utf8))
        XCTAssertEqual(toc.chapters.map(\.index), [0, 1])
        XCTAssertEqual(toc.chapters.first?.chars, 4)
        XCTAssertEqual(toc.chapters.first?.paragraphs, 1)
        let chapter = try JSONDecoder().decode(Chapter.self, from: Data(#"{"id":"c2","title":"为政","paragraphs":["为政以德"]}"#.utf8))
        XCTAssertEqual(chapter.id, "c2")
    }
    func testV2ReviewUsesLiveHighlightsAndServerClock() async throws {
        let settings = URLSessionConfiguration.ephemeral
        settings.protocolClasses = [SyncStubProtocol.self]
        let client = APIClient(configuration: try .init(address: ServerConfiguration.defaultAddress, userID: "reader", sessionToken: "fixture", expiresAt: Date().addingTimeInterval(3600)), session: URLSession(configuration: settings))
        let result = try await client.dueReviews()
        XCTAssertEqual(client.capabilities?.workspaceId, "personal")
        XCTAssertEqual(result.now, 1_700_000_000_000)
        XCTAssertEqual(result.cards.map(\.id), ["due"])
        XCTAssertEqual(result.cards.first?.bookExtId, "b")
        try await client.saveProgress(book: "b", chapter: "c2")
        let bytes = try await client.data(["books", "b", "source"])
        XCTAssertEqual(String(data: bytes, encoding: .utf8), "%PDF-fixture")
    }
    func testLegacyCapabilityFallbackAndAuthorizationFailure() async throws {
        for host in ["legacy.example", "denied.example"] {
            let settings = URLSessionConfiguration.ephemeral
            settings.protocolClasses = [SyncStubProtocol.self]
            let client = APIClient(configuration: try .init(address: "https://" + host, userID: "reader", sessionToken: "fixture", expiresAt: Date().addingTimeInterval(3600)), session: URLSession(configuration: settings))
            if host == "legacy.example" {
                let result = try await client.dueReviews()
                XCTAssertEqual(result.now, 123)
                XCTAssertNil(client.capabilities)
            } else {
                do { _ = try await client.detectSync(); XCTFail("Must not downgrade authentication errors") }
                catch APIError.http(let status) { XCTAssertEqual(status, 401) }
            }
        }
    }
}
final class OfflineLibraryTests: XCTestCase {
    func testCompletedDownloadIsReadableAndScopedToCredential() async throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("shufang-offline-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: base) }
        let config = try ServerConfiguration(address: "https://example.com", userID: "reader", sessionToken: "key-one", expiresAt: Date().addingTimeInterval(3600))
        let store = OfflineLibrary(configuration: config, baseDirectory: base)
        let book = try JSONDecoder().decode(Book.self, from: Data(
            #"{"extId":"book-one","title":"离线测试","author":"作者","format":"txt","folder":"","chapterCount":2}"#.utf8))
        let summaries = [
            ChapterSummary(id: "c1", index: 0, title: "第一章", paragraphs: 1, chars: 2),
            ChapterSummary(id: "c2", index: 1, title: "第二章", paragraphs: 1, chars: 2),
        ]
        let contents = [
            Chapter(id: "c1", index: 0, title: "第一章", paragraphs: ["正文一"]),
            Chapter(id: "c2", index: 1, title: "第二章", paragraphs: ["正文二"]),
        ]
        try await store.save(book: book, chapters: summaries, contents: contents, pdf: nil)
        let saved = await store.savedBooks()
        let second = await store.chapter(bookID: "book-one", index: 1)
        XCTAssertEqual(saved.map(\.id), ["book-one"])
        XCTAssertEqual(second?.paragraphs, ["正文二"])
        let expired = try ServerConfiguration(address: "https://example.com", userID: "reader",
            sessionToken: "key-one", expiresAt: Date().addingTimeInterval(-60),
            allowExpired: true)
        let reopened = OfflineLibrary(configuration: expired, baseDirectory: base)
        let offlineBooks = await reopened.savedBooks()
        XCTAssertEqual(offlineBooks.map(\.id), ["book-one"])
        let other = OfflineLibrary(configuration: try ServerConfiguration(
            address: "https://example.com", userID: "reader-2", sessionToken: "key-two", expiresAt: Date().addingTimeInterval(3600)), baseDirectory: base)
        let otherBooks = await other.savedBooks()
        XCTAssertTrue(otherBooks.isEmpty)

        do {
            try await store.save(book: book, chapters: summaries,
                                 contents: Array(contents.prefix(1)), pdf: nil)
            XCTFail("Incomplete replacement should be rejected")
        } catch OfflineBookError.incomplete { }
        let preserved = await store.chapter(bookID: "book-one", index: 1)
        XCTAssertEqual(preserved?.paragraphs, ["正文二"])
        try await store.remove(bookID: "book-one")
        let afterRemoval = await store.savedBooks()
        XCTAssertTrue(afterRemoval.isEmpty)
    }
}

final class SyncStubProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "shufang_session=fixture")
        XCTAssertNil(request.value(forHTTPHeaderField: "X-API-Key"))
        let path = request.url!.path
        var status = 200
        var body = ""
        switch path {
        case "/api/v2/capabilities":
            if request.url!.host == "legacy.example" { status = 404; body = "{}" }
            else if request.url!.host == "denied.example" { status = 401; body = "{}" }
            else { body = #"{"version":2,"workspaceId":"personal","nodeId":"linux"}"# }
        case "/api/v1/highlights":
            body = #"{"highlights":[{"id":"due","bookId":"b","text":"学而时习之","review":{"due":1,"reps":0,"lapses":0,"interval":0,"addedAt":1}},{"id":"future","bookId":"b","text":"温故知新","review":{"due":1900000000000,"reps":0,"lapses":0,"interval":0,"addedAt":1}},{"id":"plain","bookId":"b","text":"三人行"}]}"#
        case "/api/v1/books/b":
            XCTAssertEqual(request.httpMethod, "PATCH")
            body = #"{"ok":true}"#
        case "/api/v1/books/b/source": body = "%PDF-fixture"
        case "/api/v1/review/due":
            XCTAssertEqual(request.url!.host, "legacy.example")
            body = #"{"now":123,"cards":[]}"#
        default: XCTFail("Unexpected request: \(path)"); status = 500
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
            headerFields: ["Date": "Tue, 14 Nov 2023 22:13:20 GMT"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
