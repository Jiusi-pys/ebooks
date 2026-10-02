import XCTest
@testable import ShufangCore

final class StudyRestoreTests: XCTestCase {
    @MainActor private func makeStore(_ root: URL) throws -> StudyStore {
        let configuration = try ServerConfiguration(address: "https://restore.example", userID: "test", sessionToken: "expired", expiresAt: .distantPast, allowExpired: true)
        return StudyStore(client: APIClient(configuration: configuration), baseDirectory: root)
    }
    @MainActor func testCopyUsesKindQualifiedIDsAndLeavesProseUntouched() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try makeStore(root); defer { store.cancelSync() }
        try store.save(StudyNote(id: "shared", title: "shared", content: "shared"))
        try store.save(StudyCard(id: "shared", bookId: "book", text: "shared", noteId: "shared", tags: ["shared"]))
        let map = StudyMindMap(id: "map", title: "shared", root: .init(id: "shared", text: "shared", sourceHighlightId: "shared"))
        try store.save(map)
        let plan = try store.prepareRestore(data: store.exportData(), policy: .keepBoth)
        let noteID = plan.mappedID(kind: "notes", id: "shared"), cardID = plan.mappedID(kind: "highlights", id: "shared")
        XCTAssertNotEqual(noteID, cardID); XCTAssertNotEqual(noteID, "shared")
        try store.restore(plan: plan)
        let card = try XCTUnwrap(store.cards.first { $0.id == cardID })
        XCTAssertEqual(card.noteId, noteID); XCTAssertEqual(card.text, "shared"); XCTAssertEqual(card.tags, ["shared"])
        XCTAssertEqual(store.notes.first { $0.id == noteID }?.content, "shared")
        let copy = try XCTUnwrap(store.maps.first { $0.id != map.id })
        XCTAssertEqual(copy.title, "shared"); XCTAssertEqual(copy.root.id, "shared"); XCTAssertEqual(copy.root.text, "shared")
        XCTAssertEqual(copy.root.sourceHighlightId, cardID)
    }
    @MainActor func testCopiedNoteLinksResolveIDsAndUniqueTitlesWithoutChangingLabels() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try makeStore(root); defer { store.cancelSync() }
        try store.save(StudyNote(id: "a", title: "甲", content: "正文 b [[b]] [[乙]] [[b|自定义📚]] [[不存在]]"))
        try store.save(StudyNote(id: "b", title: "乙", content: "[[甲]]"))
        let plan = try store.prepareRestore(data: store.exportData(), policy: .keepBoth)
        let a = plan.mappedID(kind: "notes", id: "a"), b = plan.mappedID(kind: "notes", id: "b")
        try store.restore(plan: plan)
        XCTAssertEqual(store.notes.first { $0.id == a }?.content, "正文 b [[\(b)|b]] [[\(b)|乙]] [[\(b)|自定义📚]] [[不存在]]")
        XCTAssertEqual(store.notes.first { $0.id == b }?.content, "[[\(a)|甲]]")
    }
    @MainActor func testDeletedBookRestoresNewSourceAndInkIdentities() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try makeStore(root); defer { store.cancelSync() }
        let pdf = Data("%PDF fixture".utf8), drawing = Data("ink".utf8)
        let book = Book(extId: "book", title: "恢复教材", author: "", format: "pdf", folder: "", chapterCount: 0)
        try store.importBook(book: book, contents: [], pdf: pdf)
        try store.savePDFDrawing(bookID: book.id, page: 3, drawing: drawing, preview: nil)
        try store.save(StudyCard(id: "card", bookId: book.id, text: "原文"))
        try store.save(StudySet(id: "set", name: "备考", bookIds: [book.id]))
        let backup = try store.exportData()
        try store.delete(kind: "books", id: book.id)
        try store.delete(kind: "sources", id: book.id)
        let plan = try store.prepareRestore(data: backup, policy: .replace)
        let newBook = plan.mappedID(kind: "books", id: book.id)
        XCTAssertNotEqual(newBook, book.id)
        XCTAssertEqual(plan.mappedID(kind: "sources", id: book.id), newBook)
        XCTAssertEqual(plan.mappedBook(book).id, newBook)
        try store.restore(plan: plan)
        XCTAssertFalse(store.books.contains { $0.id == book.id })
        XCTAssertTrue(store.books.contains { $0.id == newBook })
        XCTAssertEqual(store.sourcePDF(bookID: newBook), pdf)
        XCTAssertEqual(store.pdfDrawing(bookID: newBook, page: 3), drawing)
        XCTAssertEqual(store.cards.first?.bookId, newBook)
        XCTAssertEqual(store.sets.first?.bookIds, [newBook])
        let reopened = try makeStore(root)
        XCTAssertEqual(reopened.pdfDrawing(bookID: newBook, page: 3), drawing)
    }
    @MainActor func testCopiedCardRetainsReviewHistoryWithNewEventIdentity() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try makeStore(root); defer { store.cancelSync() }
        let card = StudyCard(id: "card", bookId: "book", text: "知识", review: .new(now: 1))
        try store.save(card); try store.grade(card, rating: 3)
        let originalEvent = try XCTUnwrap(store.reviewEvents.first)
        let plan = try store.prepareRestore(data: store.exportData(), policy: .keepBoth)
        let copyID = plan.mappedID(kind: "highlights", id: card.id)
        try store.restore(plan: plan)
        XCTAssertEqual(store.reviewEvents.count, 2)
        let copiedEvent = try XCTUnwrap(store.reviewEvents.first { $0.highlightId == copyID })
        XCTAssertNotEqual(copiedEvent.id, originalEvent.id)
        XCTAssertEqual(copiedEvent.rating, originalEvent.rating)
        XCTAssertEqual(copiedEvent.reviewedAt, originalEvent.reviewedAt)
    }
    @MainActor func testKeepBothLeavesLiveBookSourceAndInkStable() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try makeStore(root); defer { store.cancelSync() }
        let book = Book(extId: "book", title: "教材", author: "", format: "pdf", folder: "", chapterCount: 0)
        try store.importBook(book: book, contents: [], pdf: Data("%PDF fixture".utf8))
        try store.savePDFDrawing(bookID: book.id, page: 1, drawing: Data("ink".utf8), preview: nil)
        let count = store.pendingCount
        let plan = try store.prepareRestore(data: store.exportData(), policy: .keepBoth)
        XCTAssertTrue(plan.idMap.isEmpty); XCTAssertTrue(plan.records.isEmpty)
        try store.restore(plan: plan)
        XCTAssertEqual(store.pendingCount, count)
    }
    @MainActor func testPreparedRestoreRefusesStateDriftWithoutPartiallyQueuingRecords() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try makeStore(root); defer { store.cancelSync() }
        try store.save(StudyNote(id: "a", title: "原笔记", content: "备份内容"))
        let plan = try store.prepareRestore(data: store.exportData(), policy: .keepBoth)
        try store.save(StudyNote(id: "b", title: "恢复期间新增", content: "保留"))
        let before = try Data(contentsOf: store.root.appendingPathComponent("workspace.json"))
        XCTAssertThrowsError(try store.restore(plan: plan)) { XCTAssertTrue($0 is StudyRestoreError) }
        XCTAssertEqual(try Data(contentsOf: store.root.appendingPathComponent("workspace.json")), before)
        XCTAssertEqual(store.notes.count, 2)
    }
    @MainActor func testDeletedNoteRestoresAsCopyEvenWhenKeepingLocal() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try makeStore(root); defer { store.cancelSync() }
        try store.save(StudyNote(id: "deleted", title: "旧笔记", content: "恢复"))
        let backup = try store.exportData()
        try store.delete(kind: "notes", id: "deleted")
        let plan = try store.prepareRestore(data: backup, policy: .keepLocal)
        try store.restore(plan: plan)
        XCTAssertEqual(store.notes.count, 1)
        XCTAssertNotEqual(store.notes.first?.id, "deleted")
        XCTAssertEqual(store.notes.first?.content, "恢复")
    }
    @MainActor func testIsolatedDeletedInkStopsBeforeChangingRecords() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try makeStore(root); defer { store.cancelSync() }
        try store.savePDFDrawing(bookID: "book", page: 1, drawing: Data("ink".utf8), preview: nil)
        let backup = try store.exportData()
        let ink = try XCTUnwrap(store.records.first)
        try store.delete(kind: "notes", id: ink.id)
        let before = try Data(contentsOf: store.root.appendingPathComponent("workspace.json"))
        XCTAssertThrowsError(try store.prepareRestore(data: backup, policy: .replace)) {
            guard case StudyRestoreError.deletedInk = $0 else { return XCTFail("Expected isolated ink tombstone error") }
        }
        XCTAssertEqual(try Data(contentsOf: store.root.appendingPathComponent("workspace.json")), before)
    }
}
