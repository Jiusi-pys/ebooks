import XCTest
@testable import ShufangCore

final class StudyBackupSelectionTests: XCTestCase {
    @MainActor private func makeStore() throws -> (StudyStore, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let configuration = try ServerConfiguration(address: "https://backup-test.example", userID: "test", sessionToken: "expired", expiresAt: Date().addingTimeInterval(-60), allowExpired: true)
        return (StudyStore(client: APIClient(configuration: configuration), baseDirectory: directory), directory)
    }
    @MainActor func testScopedBackupKeepsSourceClosureAndExcludesUnrelatedSets() async throws {
        let (store, directory) = try makeStore()
        defer { store.cancelSync(); try? FileManager.default.removeItem(at: directory) }
        for id in ["a", "b", "unrelated"] {
            try store.saveRecord(.init(id: id, kind: "books", fields: ["title": .string(id), "format": .string("txt"), "chapters": .array([])]))
            try store.saveRecord(.init(id: id, kind: "sources", fields: ["sha256": .string(String(repeating: "a", count: 64)), "size": .number(3)]))
        }
        let linked = StudyNote(id: "linked-note", title: "关联笔记", content: "[[后续思考|继续阅读]]")
        let next = StudyNote(id: "next-note", title: "后续思考", content: "[[关联笔记]]")
        try store.save(linked); try store.save(next)
        try store.save(StudyNote(id: "other-note", title: "无关笔记", content: "不应进入本学习集备份"))
        try store.save(StudyCard(id: "card-a", bookId: "a", text: "材料", noteId: linked.id))
        try store.save(StudyCard(id: "card-b", bookId: "b", text: "跨书来源"))
        try store.save(StudyCard(id: "card-other", bookId: "unrelated", text: "其他"))
        try store.save(StudyMindMap(id: "map-a", title: "跨书整理", bookId: "a", root: .init(text: "来源", sourceHighlightId: "card-b")))
        try store.save(StudySet(id: "set-a", name: "当前学习集", bookIds: ["a"]))
        try store.save(StudySet(id: "set-other", name: "另一个学习集", bookIds: ["a", "unrelated"]))
        let records = try JSONDecoder().decode([StudyRecord].self, from: store.exportData(bookIDs: ["a"]))
        let keys = Set(records.map(\.key))
        for key in ["books:a", "books:b", "sources:a", "sources:b", "highlights:card-a", "highlights:card-b", "notes:linked-note", "notes:next-note", "mindMaps:map-a", "studySets:set-a"] { XCTAssertTrue(keys.contains(key), key) }
        for key in ["books:unrelated", "sources:unrelated", "highlights:card-other", "notes:other-note", "studySets:set-other"] { XCTAssertFalse(keys.contains(key), key) }
    }
    @MainActor func testAssociationBackupIncludesBothOriginalBooks() async throws {
        let (store, directory) = try makeStore()
        defer { store.cancelSync(); try? FileManager.default.removeItem(at: directory) }
        for id in ["a", "b"] { try store.saveRecord(.init(id: id, kind: "books", fields: ["title": .string(id)])) }
        let association = StudyAssociation(id: "relation", source: .init(bookId: "a"), target: .init(bookId: "b"), pairKey: "a|b")
        try store.save(association)
        let records = try JSONDecoder().decode([StudyRecord].self, from: store.exportData(bookIDs: ["a"]))
        XCTAssertEqual(Set(records.filter { $0.kind == "books" }.map(\.id)), ["a", "b"])
        XCTAssertTrue(records.contains { $0.key == "associations:relation" })
    }
}
