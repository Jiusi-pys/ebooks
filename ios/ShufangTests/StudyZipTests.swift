import XCTest
#if SWIFT_PACKAGE
@testable import ShufangCore
#endif

final class StudyZipTests: XCTestCase {
    func testStoredZipRoundTripAndTampering() throws {
        let archive = try StudyBackupArchive(title: "跨端😀", origin: "https://example.org", userID: "isolated", payloads: ["study.json": Data("[]".utf8)])
        let bytes = try archive.zipData()
        let restored = try StudyBackupArchive(zipData: bytes)
        XCTAssertEqual(restored.manifest.title, archive.manifest.title)
        XCTAssertEqual(restored.payloads, archive.payloads)
        var broken = bytes
        broken[40] ^= 1
        XCTAssertThrowsError(try StudyBackupArchive(zipData: broken))
        XCTAssertThrowsError(try StudyBackupArchive(zipData: bytes.dropLast()))
        XCTAssertThrowsError(try StudyBackupArchive(zipData: Data()))
    }
}
