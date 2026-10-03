import XCTest
@testable import ShufangCore

final class ReaderNavigationTests: XCTestCase {
    func testWrongAxisAndSelectionSizedMovementsDoNotTurnPages() {
        XCTAssertNil(ReaderFlow.horizontal.turn(horizontal: 5, vertical: -150))
        XCTAssertNil(ReaderFlow.vertical.turn(horizontal: -150, vertical: 5))
        XCTAssertNil(ReaderFlow.horizontal.turn(horizontal: -40, vertical: 0))
        XCTAssertNil(ReaderFlow.vertical.turn(horizontal: -90, vertical: -90))
        XCTAssertNil(ReaderFlow.scroll.turn(horizontal: 0, vertical: -200))
    }
    func testBothDirectionsAndModesUseSameForwardConvention() {
        XCTAssertEqual(ReaderFlow.horizontal.turn(horizontal: -100, vertical: 4), 1)
        XCTAssertEqual(ReaderFlow.horizontal.turn(horizontal: 100, vertical: 4), -1)
        XCTAssertEqual(ReaderFlow.vertical.turn(horizontal: 4, vertical: -100), 1)
        XCTAssertEqual(ReaderFlow.vertical.turn(horizontal: 4, vertical: 100), -1)
    }
}
