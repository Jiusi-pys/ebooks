#if canImport(UIKit) && canImport(PencilKit)
import XCTest
import PencilKit
#if SWIFT_PACKAGE
@testable import ShufangCore
#endif

final class PortableInkPencilTests: XCTestCase {
    func testAndroidStrokeRemainsEditableWithIdentityAndPressure() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "android-ink", withExtension: "json"))
        let android = try JSONDecoder().decode(PortableInk.self, from: Data(contentsOf: url)).validated()
        XCTAssertFalse(android.strokes.isEmpty)
        let drawing = try android.pencilDrawing()
        XCTAssertEqual(drawing.strokes.count, android.strokes.count)
        let untouched = try PortableInk(drawing: drawing, height: android.height, previous: android)
        XCTAssertEqual(untouched, android)
        var edited = drawing
        let points = [PKStrokePoint(location: CGPoint(x: 300, y: 300), timeOffset: 0, size: CGSize(width: 3, height: 3), opacity: 1, force: 0.8, azimuth: 0, altitude: .pi / 2),
                      PKStrokePoint(location: CGPoint(x: 450, y: 400), timeOffset: 1, size: CGSize(width: 3, height: 3), opacity: 1, force: 0.8, azimuth: 0, altitude: .pi / 2)]
        edited.strokes.append(PKStroke(ink: PKInk(.pen, color: .black), path: PKStrokePath(controlPoints: points, creationDate: Date())))
        let output = try PortableInk(drawing: edited, height: android.height, previous: android)
        XCTAssertEqual(output.strokes.count, android.strokes.count + 1)
        XCTAssertEqual(output.strokes.first, android.strokes.first)
        let file = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("ios-edited-ink.json")
        try JSONEncoder().encode(output).write(to: file, options: .atomic)
        print("PORTABLE_INK_OUTPUT=\(file.path)")
    }
}
#endif
