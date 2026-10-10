import Foundation
import XCTest
@testable import ShufangCore

final class ReviewParityFixtureTests: XCTestCase {
    func testSharedAndroidIOSReviewVectors() throws {
        // The Rust test reads the exact same versioned file.
        #if SWIFT_PACKAGE
        let file = try XCTUnwrap(Bundle.module.url(forResource: "review-v1", withExtension: "json", subdirectory: "Fixtures"))
        #else
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/review-v1.json")
        #endif
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [[String: NSNumber]])
        for row in rows {
            let state = ReviewState(due: 0, reps: row["reps"]!.intValue, lapses: 0, interval: row["interval"]!.doubleValue, addedAt: 0)
            let result = state.graded(row["rating"]!.intValue, now: 1000)
            XCTAssertEqual(result.reps, row["expectedReps"]!.intValue)
            XCTAssertEqual(result.lapses, row["expectedLapses"]!.intValue)
            XCTAssertEqual(result.interval, row["expectedInterval"]!.doubleValue)
            XCTAssertEqual(result.due - 1000, row["dueOffset"]!.doubleValue)
        }
    }
}
