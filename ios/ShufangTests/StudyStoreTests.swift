import XCTest
@testable import ShufangCore

final class StudyStoreTests: XCTestCase {
    @MainActor func testMindMapNodeIDsWithColonsMatchServerMaterialization() async throws {
        let node = StudyMindNode(id: "import:root", text: "主题", children: [StudyMindNode(id: "import:child", text: "证据")])
        let map = StudyMindMap(title: "兼容测试", root: node)
        let fields = try XCTUnwrap(JSONValue.encoded(map).object)
        let flattened = StudyStore.flatten(kind: "mindMaps", fields: fields)
        let materialized = StudyStore.materialize(kind: "mindMaps", values: flattened)
        let result = try JSONValue.object(materialized).decoded(StudyMindMap.self)
        XCTAssertEqual(result.root, node)
    }
    @MainActor private func store(_ root: URL, user: String = "alice", address: String = "https://books.example.com") throws -> StudyStore {
        let config = try ServerConfiguration(address: address, userID: user, sessionToken: "test", expiresAt: .distantPast, allowExpired: true)
        return StudyStore(client: APIClient(configuration: config), baseDirectory: root)
    }
    @MainActor func testOfflineEditsSurviveRestartAndStayAccountScoped() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let first = try store(root)
        var card = StudyCard(bookId: "book", chapterId: "chapter", text: "中文📚选区", paraIndex: 2, start: 3, end: 10,
            style: StudyStyle(kind: "background", color: "blue"), tags: ["研究"])
        try first.save(card)
        card.note = "离线思考"; card.cloze = ["中文"]
        try first.save(card)
        first.cancelSync()
        let reopened = try store(root, address: "https://BOOKS.example.com:443/")
        XCTAssertEqual(reopened.cards, [card]); XCTAssertEqual(reopened.pendingCount, 2)
        await reopened.sync()
        XCTAssertEqual(reopened.pendingCount, 2)
        XCTAssertEqual(reopened.cards.first?.note, "离线思考")
        XCTAssertTrue(try store(root, user: "bob").cards.isEmpty)
        XCTAssertTrue(try store(root, address: "https://another.example.com").cards.isEmpty)
    }
    @MainActor func testEditingKnownCardFieldsPreservesNewerClientMetadata() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try store(root)
        let card = StudyCard(bookId: "book", text: "正文")
        var fields = try JSONValue.encoded(card).object!
        fields["futureMetadata"] = .object(["keep": .bool(true)])
        try store.saveRecord(.init(id: card.id, kind: "highlights", fields: fields))
        var updated = try XCTUnwrap(store.cards.first); updated.note = "新批注"
        try store.save(updated); store.cancelSync()
        XCTAssertEqual(store.records.first?.fields["futureMetadata"], fields["futureMetadata"])
    }
    @MainActor func testRestoreKeepsBookIdentityAndRemapsLinkedNotesAndCards() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try store(root)
        let note = StudyNote(title: "观点", content: "内容")
        let card = StudyCard(bookId: "book", text: "原文", noteId: note.id)
        try store.save(note); try store.save(card)
        let data = try store.exportData()
        try store.restore(data: data, policy: .keepBoth); store.cancelSync()
        XCTAssertEqual(store.notes.count, 2); XCTAssertEqual(store.cards.count, 2)
        let copied = try XCTUnwrap(store.cards.first { $0.id != card.id })
        XCTAssertEqual(copied.bookId, "book"); XCTAssertNotEqual(copied.noteId, note.id)
        XCTAssertTrue(store.notes.contains { $0.id == copied.noteId })
    }
    @MainActor func testReviewStateAndEventAreSavedTogether() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try store(root)
        let card = StudyCard(bookId: "book", text: "知识", review: .new(now: 1))
        try store.save(card); try store.grade(card, rating: 3); store.cancelSync()
        let reopened = try self.store(root)
        XCTAssertEqual(reopened.cards.first?.review?.lastRating, 3)
        XCTAssertEqual(reopened.reviewEvents.first?.highlightId, card.id)
        let snapshot = try JSONDecoder().decode(StudySnapshot.self, from: Data(contentsOf: store.root.appendingPathComponent("workspace.json")))
        let event = try XCTUnwrap(snapshot.pending.first { $0.operation.kind == "reviews" })
        XCTAssertEqual(event.operation.operationId, event.operation.entityId)
    }
    @MainActor func testGradingPreservesMetadataAndMoreRecentCardEdits() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try store(root)
        let card = StudyCard(bookId: "book", text: "原文", review: .new(now: 1))
        var fields = try JSONValue.encoded(card).object!
        fields["futureMetadata"] = .object(["keep": .bool(true)])
        fields["note"] = .string("评分页面打开后的新批注")
        try store.saveRecord(.init(id: card.id, kind: "highlights", fields: fields))
        try store.grade(card, rating: 3); store.cancelSync()
        let result = try XCTUnwrap(store.records.first { $0.kind == "highlights" })
        XCTAssertEqual(result.fields["futureMetadata"], fields["futureMetadata"])
        XCTAssertEqual(store.cards.first?.note, "评分页面打开后的新批注")
        XCTAssertEqual(store.cards.first?.review?.lastRating, 3)
    }
    @MainActor func testAttachmentIntegrityAndInkSurviveRestart() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try store(root)
        let drawing = Data("pencil-drawing".utf8)
        try store.savePDFDrawing(bookID: "book", page: 7, drawing: drawing, preview: nil); store.cancelSync()
        let reopened = try self.store(root)
        XCTAssertEqual(reopened.pdfDrawing(bookID: "book", page: 7), drawing)
        XCTAssertTrue(reopened.notes.isEmpty)
        try Data("corrupt".utf8).write(to: reopened.attachmentDirectory.appendingPathComponent(StudyStore.hash(drawing)))
        XCTAssertNil(reopened.pdfDrawing(bookID: "book", page: 7))
        XCTAssertNil(reopened.attachmentData("../../credentials"))
    }
    func testCrossParagraphSelectionPreservesUTF16Anchors() {
        let segments = [StudyTextSegment(paragraph: 3, start: 7, text: "甲📚乙"), StudyTextSegment(paragraph: 4, start: 0, text: "second")]
        let selected = StudyTextSelection.sources(segments: segments, range: NSRange(location: 1, length: 7), bookId: "book", chapterId: "c", chapterTitle: "章")
        XCTAssertEqual(selected.map(\.text), ["📚乙", "sec"])
        XCTAssertEqual(selected[0].start, 8); XCTAssertEqual(selected[0].end, 11)
        XCTAssertEqual(selected[1].start, 0); XCTAssertEqual(selected[1].end, 3)
        XCTAssertEqual(StudyTextSelection.range(source: selected[1], segments: segments), NSRange(location: 5, length: 3))
    }
    @MainActor func testNewerLocalFormatIsNeverOverwritten() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let first = try store(root)
        try first.save(StudyNote(title: "保留", content: "正文")); first.cancelSync()
        let url = first.root.appendingPathComponent("workspace.json")
        var file = try JSONDecoder().decode(StudySnapshot.self, from: Data(contentsOf: url)); file.version = 999
        let before = try JSONEncoder().encode(file); try before.write(to: url)
        let reopened = try store(root)
        XCTAssertThrowsError(try reopened.save(StudyNote(title: "不能覆盖", content: "")))
        XCTAssertEqual(try Data(contentsOf: url), before)
    }
}
