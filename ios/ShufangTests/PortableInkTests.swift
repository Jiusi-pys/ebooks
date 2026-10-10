import XCTest
@testable import ShufangCore

final class PortableInkTests: XCTestCase {
    func testVersionAndFiniteCoordinatesAreValidated() throws {
        let value = PortableInk(height: 1400, strokes: [])
        XCTAssertEqual(try JSONDecoder().decode(PortableInk.self, from: JSONEncoder().encode(value)).validated(), value)
        var bad = value; bad.version = 2
        XCTAssertThrowsError(try bad.validated())
        bad = value; bad.height = -.infinity
        XCTAssertThrowsError(try bad.validated())
    }
}
