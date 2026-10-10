import XCTest
#if SWIFT_PACKAGE
@testable import ShufangCore
#endif
final class StudyCardCompatibilityTests: XCTestCase {
    func testPdfCardAcceptsAbsentTextChapterMetadata() throws {
        let data = Data("{\"id\":\"pdf-card\",\"bookId\":\"book\",\"text\":\"PDF\",\"createdAt\":123,\"pdfAnchor\":{\"page\":1,\"rects\":[]}}".utf8)
        let card = try JSONDecoder().decode(StudyCard.self, from: data)
        XCTAssertEqual(card.chapterId, "")
        XCTAssertEqual(card.chapterTitle, "")
        XCTAssertEqual(card.pdfAnchor?.page, 1)
        XCTAssertEqual(card.createdAt, 123)
        XCTAssertThrowsError(try JSONDecoder().decode(StudyCard.self, from: Data("{\"text\":\"missing book\"}".utf8)))
    }
}
