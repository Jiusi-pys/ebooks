import XCTest
@testable import ShufangCore

final class StudyInteractionTests: XCTestCase {
    private func tree() -> StudyMindNode {
        StudyMindNode(id: "root", text: "主题", children: [
            StudyMindNode(id: "a", text: "论点", children: [
                StudyMindNode(id: "a1", text: "例证", sourceHighlightId: "card")
            ]),
            StudyMindNode(id: "b", text: "反例", collapsed: true)
        ])
    }
    func testMovePreservesSubtreeAndCardIdentity() throws {
        let moved = try XCTUnwrap(StudyTree.moved(tree(), id: "a", parent: "b"))
        XCTAssertEqual(moved.children.map(\.id), ["b"])
        XCTAssertEqual(moved.children[0].children[0].children[0].sourceHighlightId, "card")
        XCTAssertEqual(moved.children[0].collapsed, false)
        XCTAssertEqual(Set(StudyTree.nodes(moved).map(\.id)), Set(["root", "a", "a1", "b"]))
    }
    func testCannotMoveRootOrCreateCycle() {
        XCTAssertNil(StudyTree.moved(tree(), id: "root", parent: "b"))
        XCTAssertNil(StudyTree.moved(tree(), id: "a", parent: "a1"))
        XCTAssertNil(StudyTree.moved(tree(), id: "a", parent: "a"))
        XCTAssertNil(StudyTree.moved(tree(), id: "a", parent: "missing"))
        XCTAssertNil(StudyTree.moved(tree(), id: "missing", parent: "b"))
    }
    func testSiblingReorderAndSubtreeDeletion() {
        let changed = StudyTree.reorder(tree(), id: "b", delta: -1)
        XCTAssertEqual(changed.children.map(\.id), ["b", "a"])
        XCTAssertEqual(StudyTree.reorder(changed, id: "b", delta: -1), changed)
        let removed = StudyTree.removing(changed, id: "a")
        XCTAssertEqual(StudyTree.nodes(removed).map(\.id), ["root", "b"])
    }
    func testLinkedNodeDisplaysCurrentCardInsteadOfCopiedText() {
        let node = StudyMindNode(text: "旧文字", sourceHighlightId: "card")
        var card = StudyCard(id: "card", bookId: "book", text: "原文：学而时习之")
        XCTAssertEqual(StudyTree.title(node, cards: [card]), "原文：学而时习之")
        card.name = "温故知新"
        XCTAssertEqual(StudyTree.title(node, cards: [card]), "温故知新")
        card.name = ""
        XCTAssertEqual(StudyTree.title(node, cards: [card]), "原文：学而时习之")
        XCTAssertEqual(StudyTree.title(node, cards: []), "旧文字")
    }
    func testCollapseDoesNotDeleteDescendants() {
        let changed = StudyTree.update(tree(), id: "a") { $0.collapsed = true }
        XCTAssertEqual(changed.children[0].collapsed, true)
        XCTAssertEqual(StudyTree.nodes(changed).count, 4)
        XCTAssertEqual(changed.children[0].children[0].sourceHighlightId, "card")
    }
    func testPassageIdentityMatchesWebAndIgnoresSnapshots() throws {
        var source = StudySource(bookId: "book", chapterId: "chapter", text: "学而时习之", paraIndex: 0, start: 1, end: 6)
        XCTAssertEqual(StudyAnchors.key(source), "text:%5B%22text%22%2C%22book%22%2C%22chapter%22%2C0%2C1%2C6%5D")
        let identity = StudyAnchors.key(source)
        source.text = "Edited snapshot"; source.chapterTitle = "New title"
        XCTAssertEqual(StudyAnchors.key(source), identity)
        source.end = 7
        XCTAssertNotEqual(StudyAnchors.key(source), identity)
    }
    func testPDFRelationDeduplicatesReorderedRectsAndDirectionIsDistinct() throws {
        let first = StudyPDFRect(x: 0.1, y: 0.2, width: 0.3, height: 0.04)
        let second = StudyPDFRect(x: 0.1, y: 0.25, width: 0.3, height: 0.04)
        let pdf = StudySource(kind: "pdf", bookId: "book", chapterId: "pdf-page-1", text: "PDF", pdfAnchor: StudyPDFAnchor(page: 1, rects: [first, second]))
        var reordered = pdf; reordered.pdfAnchor?.rects.reverse()
        XCTAssertEqual(StudyAnchors.key(pdf), StudyAnchors.key(reordered))
        let text = StudySource(bookId: "b", chapterId: "c", text: "文字", paraIndex: 0, start: 0, end: 2)
        XCTAssertEqual(StudyAnchors.pairKey(pdf, text, bidirectional: true), StudyAnchors.pairKey(text, pdf, bidirectional: true))
        XCTAssertNotEqual(StudyAnchors.pairKey(pdf, text, bidirectional: false), StudyAnchors.pairKey(text, pdf, bidirectional: false))
        XCTAssertNil(StudyAnchors.pairKey(pdf, reordered, bidirectional: true))
        XCTAssertNil(StudyAnchors.pairKey(StudySource(bookId: "book"), text, bidirectional: true))
    }

}
