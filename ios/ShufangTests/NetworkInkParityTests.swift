#if canImport(UIKit) && canImport(PencilKit)
import XCTest
import PencilKit
#if SWIFT_PACKAGE
@testable import ShufangCore
#endif

/// Runs only in the dedicated harness against a disposable Rust server.
final class NetworkInkParityTests: XCTestCase {
    func testAndroidStudyZIPAndIosReturnTransport() throws {
        guard let url = Bundle(for: Self.self).url(forResource: "cross-study", withExtension: "zip") else { throw XCTSkip("Dedicated archive required") }
        let archive = try StudyBackupArchive(zipData: Data(contentsOf: url))
        XCTAssertEqual(archive.manifest.userID, "ink-network-acceptance")
        XCTAssertEqual(try archive.validatedBooks().count, 1)
        XCTAssertTrue(archive.records.contains { $0.kind == "notes" && $0.fields["pdfPortableInk"] != nil })
        XCTAssertTrue(archive.records.contains { $0.kind == "reviews" })
        print("IOS_STUDY_ZIP_BASE64=" + (try archive.zipData()).base64EncodedString())
    }
    @MainActor func testRealStudyStoreNetworkAndPencilKitEditing() async throws {
        guard let metadataURL = Bundle(for: Self.self).url(forResource: "network-ink", withExtension: "json") else { throw XCTSkip("Dedicated network acceptance harness required") }
        let metadata = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: metadataURL)) as? [String: Any])
        let bookID = try XCTUnwrap(metadata["bookId"] as? String)
        let noteID = try XCTUnwrap(metadata["noteId"] as? String)
        let config = try await APIClient.login(address: "http://127.0.0.1:31487", username: "ink-network-acceptance", password: "public-ink-test-password-123")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("network-ink-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = StudyStore(client: APIClient(configuration: config), baseDirectory: root)
        await store.sync()
        XCTAssertNil(store.error)
        XCTAssertTrue(store.records.contains { $0.kind == "notes" && $0.id == noteID })
        let ink = try XCTUnwrap(store.portablePDFInk(bookID: bookID, page: 1))
        XCTAssertEqual(ink.strokes.first?.id, "android-network-stroke")
        let cardID = try XCTUnwrap(metadata["cardId"] as? String)
        let card = try XCTUnwrap(store.cards.first { $0.id == cardID })
        if metadata["verifyOnly"] as? Bool == true {
            let webNoteID = try XCTUnwrap(metadata["webNoteId"] as? String)
            let deletedID = try XCTUnwrap(metadata["webDeletedNoteId"] as? String)
            XCTAssertEqual(store.records.first { $0.kind == "notes" && $0.id == webNoteID }?.fields["content"]?.string, "真实浏览器修改😀")
            XCTAssertFalse(store.records.contains { $0.kind == "notes" && $0.id == deletedID })
            XCTAssertEqual(ink.strokes.count, 3)
            XCTAssertEqual(ink.strokes.last?.id, "android-return-stroke")
            XCTAssertEqual(try ink.pencilDrawing().strokes.count, 3)
            XCTAssertEqual(store.reviewEvents.filter { $0.highlightId == cardID }.count, 2)
            print("NETWORK_INK_ANDROID_IOS_ANDROID_IOS_PASSED strokes=3")
            return
        }
        XCTAssertEqual(ink.strokes.count, 1)
        XCTAssertEqual(store.reviewEvents.filter { $0.highlightId == cardID }.count, 1)
        XCTAssertEqual(card.review?.lastRating, 3)
        var drawing = try ink.pencilDrawing()
        let points = [PKStrokePoint(location: CGPoint(x: 300, y: 300), timeOffset: 0, size: CGSize(width: 3, height: 3), opacity: 1, force: 0.8, azimuth: 0, altitude: .pi / 2),
                      PKStrokePoint(location: CGPoint(x: 450, y: 400), timeOffset: 1, size: CGSize(width: 3, height: 3), opacity: 1, force: 0.8, azimuth: 0, altitude: .pi / 2)]
        drawing.strokes.append(PKStroke(ink: PKInk(.pen, color: .black), path: PKStrokePath(controlPoints: points, creationDate: Date())))
        let edited = try PortableInk(drawing: drawing, height: ink.height, previous: ink)
        XCTAssertEqual(edited.strokes.count, 2)
        XCTAssertEqual(edited.strokes.first, ink.strokes.first)
        try store.savePDFDrawing(bookID: bookID, page: 1, drawing: drawing.dataRepresentation(), preview: drawing.image(from: CGRect(x: 0, y: 0, width: 1000, height: ink.height), scale: 1).pngData(), portableInk: JSONEncoder().encode(edited))
        try store.save(StudyNote(title: "iOS network business acceptance", content: "真实 iOS 核心经网络提交😀"))
        try store.grade(card, rating: 4)
        store.cancelSync()
        await store.sync()
        XCTAssertNil(store.error)
        XCTAssertEqual(store.pendingCount, 0)
        XCTAssertTrue(store.conflicts.isEmpty)
        print("NETWORK_INK_IOS_UPLOAD_PASSED strokes=2")
    }
}
#endif
