import CoreGraphics
import XCTest
@testable import ShufangCore

final class PDFGeometryTests: XCTestCase {
    func testRotatedCroppedPageRoundTrip() throws {
        let crop = CGRect(x: 23, y: 47, width: 600, height: 800)
        let selection = CGRect(x: 83, y: 687, width: 180, height: 40)
        for rotation in [0, 90, 180, 270, -90, 450] {
            let normalized = try XCTUnwrap(PDFGeometry.normalize(selection, cropBox: crop, rotation: rotation))
            let restored = try XCTUnwrap(PDFGeometry.pageRect(normalized, cropBox: crop, rotation: rotation))
            XCTAssertEqual(restored.minX, selection.minX, accuracy: 0.00001)
            XCTAssertEqual(restored.minY, selection.minY, accuracy: 0.00001)
            XCTAssertEqual(restored.width, selection.width, accuracy: 0.00001)
            XCTAssertEqual(restored.height, selection.height, accuracy: 0.00001)
        }
    }
    func testTopLeftMatchesWebAndRotation() throws {
        let crop = CGRect(x: 0, y: 0, width: 100, height: 200)
        let rect = CGRect(x: 10, y: 140, width: 30, height: 20)
        let standard = try XCTUnwrap(PDFGeometry.normalize(rect, cropBox: crop, rotation: 0))
        XCTAssertEqual(standard.x, 0.1, accuracy: 0.00001)
        XCTAssertEqual(standard.y, 0.2, accuracy: 0.00001)
        let rotated = try XCTUnwrap(PDFGeometry.normalize(rect, cropBox: crop, rotation: 90))
        XCTAssertEqual(rotated.x, 0.7, accuracy: 0.00001)
        XCTAssertEqual(rotated.y, 0.1, accuracy: 0.00001)
    }
    func testInvalidAndOutOfPageRectangles() {
        XCTAssertNil(PDFNormalizedRect(x: .nan, y: 0, width: 1, height: 1).sanitized)
        XCTAssertNil(PDFNormalizedRect(x: 2, y: 0, width: 1, height: 1).sanitized)
        XCTAssertNil(PDFGeometry.normalize(.zero, cropBox: .zero, rotation: 0))
        let clipped = PDFNormalizedRect(x: -0.1, y: 0.9, width: 0.3, height: 0.2).sanitized!
        XCTAssertEqual(clipped.x, 0)
        XCTAssertEqual(clipped.width, 0.2, accuracy: 0.00001)
        XCTAssertEqual(clipped.height, 0.1, accuracy: 0.00001)
    }
}
