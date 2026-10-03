import XCTest
@testable import ShufangCore

// Opt-in exercise of real URLSession + loopback HTTP, NOT a production MySQL test.
final class HTTPIntegrationTests: XCTestCase {
    func testFixtureReadWriteRoundTrip() async throws {
        guard ProcessInfo.processInfo.environment["SHUFANG_SMOKE_TESTS"] == "1" else {
            throw XCTSkip("Start scripts/smoke-server.py and set SHUFANG_SMOKE_TESTS=1 in Debug")
        }
        let config = try await APIClient.login(address: "http://127.0.0.1:8787",
            username: "demo", password: "demo-password")
        let client = APIClient(configuration: config)
        let books: BooksResponse = try await client.request(["books"])
        let book = try XCTUnwrap(books.books.first)
        let toc: ChaptersResponse = try await client.request(["books", book.id, "chapters"])
        XCTAssertEqual(toc.chapters.count, 2)
        let chapter: Chapter = try await client.request(["books", book.id, "chapters", "0"])
        let noteID = UUID().uuidString
        try await client.write(["notes"], body: NoteWrite(extId: noteID, title: "联调笔记", content: "创建内容"))
        let first: NoteDetail = try await client.request(["notes", noteID])
        XCTAssertEqual(first.content, "创建内容")
        try await client.write(["notes", noteID], method: "PATCH", body: NoteWrite(extId: noteID, title: "更新标题", content: "更新内容📚"))
        let updated: NoteDetail = try await client.request(["notes", noteID])
        XCTAssertEqual(updated.content, "更新内容📚")
        XCTAssertEqual(updated.title, "更新标题")
        let highlightID = UUID().uuidString
        try await client.write(["highlights"], body: HighlightWrite(extId: highlightID, bookExtId: book.id,
            bookTitle: book.title, chapterId: chapter.id, chapterTitle: chapter.title,
            text: chapter.paragraphs[0], paraIndex: 0, start: 0,
            end: chapter.paragraphs[0].utf16.count, note: "联调批注", review: .new(now: 1)))
        let highlights: HighlightsResponse = try await client.request(["highlights"])
        XCTAssertEqual(highlights.highlights.first(where: { $0.id == highlightID })?.note, "联调批注")
        let due: ReviewResponse = try await client.request(["review", "due"])
        let card = try XCTUnwrap(due.cards.first(where: { $0.id == highlightID }))
        let next = try XCTUnwrap(card.review).graded(3, now: due.now)
        try await client.write(["highlights", highlightID], method: "PATCH", body: ReviewPatch(review: next))
        let remaining: ReviewResponse = try await client.request(["review", "due"])
        XCTAssertFalse(remaining.cards.contains(where: { $0.id == highlightID }))
        let after: HighlightsResponse = try await client.request(["highlights"])
        XCTAssertEqual(after.highlights.first(where: { $0.id == highlightID })?.review, next)
    }
}
