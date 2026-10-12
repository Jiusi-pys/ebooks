import CoreGraphics
import Foundation
import XCTest
@testable import ShufangMacCore

final class AdapterTests: XCTestCase {
    func testTextSelectionUsesUTF16AndMultipleParagraphs() throws {
        let anchor = try XCTUnwrap(TextSelection.anchor(book: "b", chapter: "c", paragraphs: ["中文😀尾", "第二段"], range: NSRange(location: 2, length: 7)))
        XCTAssertEqual(anchor["start"] as? Int, 2)
        XCTAssertEqual(anchor["end"] as? Int, 5)
        XCTAssertEqual(anchor["text"] as? String, "😀尾\n第二段")
        let ranges = try XCTUnwrap(anchor["sourceRanges"] as? [[String: Any]])
        XCTAssertEqual(ranges.count, 2)
        XCTAssertEqual(ranges[1]["paraIndex"] as? Int, 1)
        XCTAssertEqual(TextSelection.range(paragraphs:["中文😀尾","第二段"],anchor:ranges[1]),NSRange(location:6,length:3))
        XCTAssertNil(TextSelection.range(paragraphs:["a"],anchor:["paraIndex":0,"start":0,"end":20]))
        XCTAssertNil(TextSelection.anchor(book: "b", chapter: "c", paragraphs: ["中文"], range: NSRange(location: NSNotFound, length: 1)))
        XCTAssertNil(TextSelection.anchor(book: "b", chapter: "c", paragraphs: ["中文"], range: NSRange(location: 20, length: 1)))
    }
    func testPDFCoordinatesRoundTripEveryRotationAndCropOffset() throws {
        let crop = CGRect(x: 30, y: 50, width: 400, height: 600)
        let rect = CGRect(x: 100, y: 200, width: 80, height: 110)
        for rotation in [0,90,180,270,-90,450] {
            let value = try XCTUnwrap(PDFCoordinates.normalize(rect, crop: crop, rotation: rotation))
            let restored = try XCTUnwrap(PDFCoordinates.pageRect(value, crop: crop, rotation: rotation))
            XCTAssertEqual(restored.minX, rect.minX, accuracy: 0.00001)
            XCTAssertEqual(restored.minY, rect.minY, accuracy: 0.00001)
            XCTAssertEqual(restored.width, rect.width, accuracy: 0.00001)
            XCTAssertEqual(restored.height, rect.height, accuracy: 0.00001)
        }
        XCTAssertNil(PDFCoordinates.normalize(.zero, crop: crop, rotation: 0))
        XCTAssertNil(PDFCoordinates.pageRect(["x": .nan,"y":0,"width":0.1,"height":0.1], crop: crop, rotation: 0))
    }
    func testConnectionRejectsCredentialBearingAndUnencryptedRemoteURLs() throws {
        for input in ["http://example.com", "https://u:pass@example.com", "https://example.com/path", "https://example.com?secret=a", "file:///tmp"] {
            XCTAssertThrowsError(try Connection.origin(input))
        }
        XCTAssertEqual(try Connection.origin("http://127.0.0.1:1234").port, 1234)
        XCTAssertEqual(try Connection.origin("https://example.com/").host, "example.com")
        let a = Connection(origin: URL(string: "https://example.com")!, userID: "a", workspaceID: "w", nodeID: "n", token: "synthetic", expiresAt: .distantFuture)
        let b = Connection(origin: a.origin, userID: "b", workspaceID: "w", nodeID: "n", token: "synthetic", expiresAt: .distantFuture)
        XCTAssertNotEqual(a.scope,b.scope)
    }
    func testRealKeychainUpdatesAndWorkspaceIsolation() throws {
        let vault = KeychainVault(service: "org.shufang.mac.tests.\(UUID().uuidString)")
        defer { try? vault.remove("own-test"); try? vault.remove("other-test") }
        XCTAssertNil(try vault.load("own-test"))
        try vault.save("own-test", data: Data("synthetic-1".utf8))
        try vault.save("own-test", data: Data("synthetic-2".utf8))
        XCTAssertEqual(try vault.load("own-test"), Data("synthetic-2".utf8))
        XCTAssertNil(try vault.load("other-test"))
        XCTAssertNotEqual(KeychainVault.workspaceAccount(root: "/tmp/a", provider: "openai"), KeychainVault.workspaceAccount(root: "/tmp/b", provider: "openai"))
        try vault.remove("own-test")
        XCTAssertNil(try vault.load("own-test"))
    }
    func testPortableInkRetainsExtensionsAndRejectsUnsafePoints() throws {
        var ink: [String: Any] = ["format":"ShufangPortableInk","version":1,"width":1000,"height":1400,"unknown":"保留",
            "strokes":[["id":"a","tool":"pen","width":2.0,"color":[0.1,0.2,0.3,1.0],"extension":true,
                        "points":[["x":2.0,"y":3.0,"pressure":0.5,"tilt":0.0,"azimuth":0.0,"time":0.0]]]]]
        try PortableInk.validate(ink)
        let decoded = try PortableInk.decode(JSONSerialization.data(withJSONObject: ink))
        XCTAssertEqual(decoded["unknown"] as? String, "保留")
        var strokes = ink["strokes"] as! [[String: Any]]
        var points = strokes[0]["points"] as! [[String: Any]]
        points[0]["x"] = -1.0; strokes[0]["points"] = points; ink["strokes"] = strokes
        XCTAssertThrowsError(try PortableInk.validate(ink))
        points[0]["x"] = 1.0; points[0]["time"] = -1.0; strokes[0]["points"] = points; ink["strokes"] = strokes
        XCTAssertThrowsError(try PortableInk.validate(ink))
        let original = decoded["strokes"] as! [[String: Any]]
        ink["strokes"] = [original[0], original[0]]
        XCTAssertThrowsError(try PortableInk.validate(ink))
    }
    func testKeychainCallbackRejectsInvalidPointersAndBounds() {
        XCTAssertEqual(keychainStore(nil,0,nil,0,nil,0),-1)
        XCTAssertEqual(keychainLoad(nil,0,nil,0,nil,0),-1)
        XCTAssertEqual(keychainStore(nil,16385,nil,0,nil,4097),-1)
        XCTAssertEqual(keychainLoad(nil,0,nil,0,nil,-1),-1)
    }

    func testNewInkCanvasUsesJSONNumbersAndRotatedPageRatio() throws {
        let empty = try PortableInk.empty(pageSize:CGSize(width:600,height:800),rotation:0)
        XCTAssertEqual(empty["width"] as? Double,1000)
        XCTAssertEqual(empty["height"] as? Double,800.0/600.0*1000)
        XCTAssertEqual((empty["strokes"] as? [Any])?.count,0)
        let rotated = try PortableInk.empty(pageSize:CGSize(width:600,height:800),rotation:90)
        XCTAssertEqual(rotated["height"] as? Double,750)
        XCTAssertThrowsError(try PortableInk.empty(pageSize:.zero,rotation:0))
        var invalid = empty; invalid["width"] = true
        XCTAssertThrowsError(try PortableInk.validate(invalid))
    }

}
