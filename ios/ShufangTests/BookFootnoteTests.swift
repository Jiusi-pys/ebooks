import XCTest
@testable import ShufangCore

final class BookFootnoteTests: XCTestCase {
    func testServerChapterPreservesNotesWithoutChangingText() throws {
        let data = Data(#"{"id":"c","index":0,"title":"注释","paragraphs":["书📚[1]正文"],"footnotes":[{"paraIndex":0,"start":3,"end":6,"content":"解释\n<script>保持纯文字</script>"}]}"#.utf8)
        let chapter = try JSONDecoder().decode(Chapter.self, from: data)
        XCTAssertEqual(chapter.paragraphs, ["书📚[1]正文"])
        let notes = ReaderFootnote.visible(try XCTUnwrap(chapter.footnotes), segments: [.init(paragraph: 0, start: 0, text: chapter.paragraphs[0])])
        XCTAssertEqual(notes.first?.range, NSRange(location: 3, length: 3))
        XCTAssertEqual(notes.first?.label, "[1]")
        let roundtrip = try JSONDecoder().decode(Chapter.self, from: JSONEncoder().encode(chapter))
        XCTAssertEqual(roundtrip.footnotes, chapter.footnotes)
        let old = try JSONDecoder().decode(Chapter.self, from: Data(#"{"id":"old","index":0,"title":"","paragraphs":[]}"#.utf8))
        XCTAssertNil(old.footnotes)
    }
    func testPageClippingAndParagraphOffsetsMatchWeb() {
        let notes = [BookFootnote(paraIndex: 2, start: 5, end: 8, content: "完整内容")]
        let first = ReaderFootnote.visible(notes, segments: [.init(paragraph: 1, start: 0, text: "前段📚"), .init(paragraph: 2, start: 4, text: "文[1")])
        XCTAssertEqual(first.first?.range, NSRange(location: 6, length: 2))
        XCTAssertEqual(first.first?.label, "[1")
        let next = ReaderFootnote.visible(notes, segments: [.init(paragraph: 2, start: 7, text: "]后文")])
        XCTAssertEqual(next.first?.label, "]")
        XCTAssertEqual(next.first?.content, "完整内容")
        XCTAssertTrue(ReaderFootnote.visible(notes, segments: [.init(paragraph: 2, start: 8, text: "后文")]).isEmpty)
    }
    func testSkipsEmptyInvalidAndOverlappingNotes() {
        let notes = [BookFootnote(paraIndex: 0, start: -1, end: 1, content: "坏"),
                     .init(paraIndex: 0, start: 0, end: 3, content: "正确"),
                     .init(paraIndex: 0, start: 1, end: 4, content: "重叠"),
                     .init(paraIndex: 0, start: 4, end: 5, content: "")]
        let visible = ReaderFootnote.visible(notes, segments: [.init(paragraph: 0, start: 0, text: "[1]正文")])
        XCTAssertEqual(visible.count, 1)
        XCTAssertEqual(visible.first?.label, "[1]")
    }
    func testOfflineUpgradeRetainsOriginalAndRejectsChangedText() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let configuration = try ServerConfiguration(address: "https://example.com", userID: "reader", sessionToken: "test", expiresAt: Date().addingTimeInterval(3600))
        let library = OfflineLibrary(configuration: configuration, baseDirectory: root)
        let book = Book(extId: "book", title: "注释测试", author: "", format: "epub", folder: "", chapterCount: 1)
        let chapter = Chapter(id: "c", index: 0, title: "章", paragraphs: ["原文[1]"])
        let pdf = Data("%PDF fixture".utf8)
        try await library.save(book: book, chapters: [.init(id: "c", index: 0, title: "章", paragraphs: 1, chars: 5)], contents: [chapter], pdf: pdf)
        var fresh = chapter
        fresh.footnotes = [.init(paraIndex: 0, start: 2, end: 5, content: "注释正文")]
        let upgraded = try await library.refreshFootnotes(bookID: book.id, chapter: fresh)
        XCTAssertEqual(upgraded?.footnotes, fresh.footnotes)
        let reopened = OfflineLibrary(configuration: configuration, baseDirectory: root)
        let saved = await reopened.chapter(bookID: book.id, index: 0)
        let savedPDF = await reopened.pdf(bookID: book.id)
        XCTAssertEqual(saved?.footnotes, fresh.footnotes)
        XCTAssertEqual(savedPDF, pdf)
        let refused = try await library.refreshFootnotes(bookID: book.id, chapter: Chapter(id: "c", index: 0, title: "新章", paragraphs: ["不同正文"]))
        XCTAssertNil(refused)
        let unchanged = await library.chapter(bookID: book.id, index: 0)
        XCTAssertEqual(unchanged?.paragraphs, chapter.paragraphs)
        XCTAssertEqual(unchanged?.footnotes, fresh.footnotes)
    }
}
