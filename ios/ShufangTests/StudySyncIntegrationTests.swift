import XCTest
@testable import ShufangCore

/// Optional real-HTTP contract test against the disposable v2 loopback fixture.
final class StudySyncIntegrationTests: XCTestCase {
    private func requireFixture() throws {
        guard ProcessInfo.processInfo.environment["SHUFANG_STUDY_SMOKE_TESTS"] == "1" else {
            throw XCTSkip("Run scripts/study-smoke-server.py on 8788, set SHUFANG_STUDY_SMOKE_TESTS=1")
        }
    }
    private func fixture(_ path: String, body: [String: Any] = [:]) async throws {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8788/test/" + path)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }
    @MainActor func testDurableReplayConflictsLostResponseAndSourceUpload() async throws {
        try requireFixture()
        try await fixture("reset")
        let configuration = try await APIClient.login(address: "http://127.0.0.1:8788", username: "demo", password: "demo-password")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = StudyStore(client: APIClient(configuration: configuration), baseDirectory: root)
        await store.sync()
        XCTAssertNil(store.error)
        var note = try XCTUnwrap(store.notes.first { $0.id == "demo-note" })
        note.content = "本机离线草稿"; try store.save(note); store.cancelSync()
        try await fixture("mutate", body: ["kind": "notes", "id": note.id, "patch": ["content": "另一台设备的修改"]])
        await store.sync()
        let conflict = try XCTUnwrap(store.conflicts.first)
        XCTAssertEqual(conflict.local["content"]?.string, "本机离线草稿")
        XCTAssertEqual(conflict.remote["content"]?.string, "另一台设备的修改")
        try store.resolve(conflict, choice: .copy)
        await store.sync()
        XCTAssertEqual(store.pendingCount, 0); XCTAssertTrue(store.conflicts.isEmpty)
        XCTAssertTrue(store.notes.contains { $0.content == "本机离线草稿" && $0.id != note.id })
        XCTAssertEqual(store.notes.first { $0.id == note.id }?.content, "另一台设备的修改")

        let uncertain = StudyNote(title: "回执丢失", content: "只应创建一份")
        try store.save(uncertain); store.cancelSync()
        try await fixture("drop-next-reply")
        await store.sync()
        XCTAssertGreaterThan(store.pendingCount, 0)
        let restarted = StudyStore(client: APIClient(configuration: configuration), baseDirectory: root)
        await restarted.sync()
        XCTAssertNil(restarted.error); XCTAssertEqual(restarted.pendingCount, 0)
        XCTAssertEqual(restarted.notes.filter { $0.id == uncertain.id }.count, 1)

        let book = Book(extId: UUID().uuidString.lowercased(), title: "上传验收", author: "", format: "pdf", folder: "", chapterCount: 1)
        let pdf = Data("%PDF-1.4\nfixture checksum payload".utf8)
        try restarted.importBook(book: book, contents: [Chapter(id: "c", index: 0, title: "页", paragraphs: [String(repeating: "测试正文", count: 20_000)])], pdf: pdf)
        await restarted.sync()
        XCTAssertNil(restarted.error); XCTAssertEqual(restarted.pendingCount, 0)
        let remote: JSONValue = try await restarted.client.request(["books", book.id])
        XCTAssertEqual(remote.object?["title"]?.string, book.title)
        XCTAssertEqual(restarted.sourcePDF(bookID: book.id), pdf)
        XCTAssertNotNil(restarted.books.first { $0.id == book.id })
        let drawing = Data("ink payload".utf8)
        try restarted.savePDFDrawing(bookID: book.id, page: 1, drawing: drawing, preview: nil)
        await restarted.sync()
        XCTAssertNil(restarted.error)
        let secondRoot = root.appendingPathComponent("second-device")
        let second = StudyStore(client: APIClient(configuration: configuration), baseDirectory: secondRoot)
        await second.sync()
        XCTAssertNil(second.error)
        XCTAssertEqual(second.pdfDrawing(bookID: book.id, page: 1), drawing)
        XCTAssertNotNil(second.books.first { $0.id == book.id })
    }
    @MainActor func testOfflineDeletionDoesNotEraseConcurrentRemoteEdit() async throws {
        try requireFixture()
        try await fixture("reset")
        let configuration = try await APIClient.login(address: "http://127.0.0.1:8788", username: "demo", password: "demo-password")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = StudyStore(client: APIClient(configuration: configuration), baseDirectory: root)
        await store.sync()
        try store.delete(kind: "notes", id: "demo-note"); store.cancelSync()
        try await fixture("mutate", body: ["kind": "notes", "id": "demo-note", "patch": ["content": "远端的新研究成果"]])
        await store.sync()
        let conflict = try XCTUnwrap(store.conflicts.first)
        XCTAssertEqual(conflict.localDeleted, true)
        XCTAssertEqual(conflict.remote["content"]?.string, "远端的新研究成果")
        let remote: JSONValue = try await store.client.request(["notes", "demo-note"])
        XCTAssertEqual(remote.object?["content"]?.string, "远端的新研究成果")
        try store.resolve(conflict, choice: .remote)
        XCTAssertEqual(store.notes.first { $0.id == "demo-note" }?.content, "远端的新研究成果")
        XCTAssertEqual(store.pendingCount, 0)
        try store.delete(kind: "notes", id: "demo-note"); store.cancelSync()
        try await fixture("mutate", body: ["kind": "notes", "id": "demo-note", "patch": ["content": "再次更新"]])
        await store.sync()
        try store.resolve(try XCTUnwrap(store.conflicts.first), choice: .local)
        await store.sync()
        XCTAssertNil(store.error)
        XCTAssertTrue(store.conflicts.isEmpty)
        XCTAssertNil(store.notes.first { $0.id == "demo-note" })
        XCTAssertEqual(store.pendingCount, 0)
    }
}
