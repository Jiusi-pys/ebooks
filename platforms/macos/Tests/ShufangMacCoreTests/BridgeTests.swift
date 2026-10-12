import Foundation
import XCTest
@testable import ShufangMacCore

final class BridgeTests: XCTestCase {
    func core() throws -> RustCore {
        guard let path = ProcessInfo.processInfo.environment["SHUFANG_MAC_CORE"] else {
            throw CoreError.unavailable("Set SHUFANG_MAC_CORE to the built Rust dylib")
        }
        return try RustCore(library: URL(fileURLWithPath: path))
    }

    func testRealABIConflictRestartAndClose() async throws {
        let rust = try core()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = directory.appendingPathComponent("library.sqlite3")
        let session = LibrarySession(core: rust)
        try await session.open(database: database, workspace: "mac-test", replica: "mac-replica")
        let save: [String: Any] = ["kind": "notes", "id": "n", "expected": 0,
                                  "patch": ["title": "书房😀", "content": "离线内容"]]
        _ = try await session.command("save", arguments: save)
        do {
            _ = try await session.command("save", arguments: save)
            XCTFail("stale revision was accepted")
        } catch { XCTAssertEqual(error as? CoreError, .rejected("revision_conflict")) }
        try await session.close()
        do {
            _ = try await session.command("list", arguments: ["kind": "notes"])
            XCTFail("closed session was accepted")
        } catch { XCTAssertEqual(error as? CoreError, .rejected("session_closed")) }
        try await session.open(database: database, workspace: "mac-test", replica: "mac-replica")
        let rows = try RustCore.value(await session.command("list", arguments: ["kind": "notes"])) as! [[String: Any]]
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual((rows[0]["value"] as? [String: Any])?["title"] as? String, "书房😀")
        try await session.close()
    }

    func testRawABIRejectsMalformedInputAndRetainsEscapedUTF16() async throws {
        let rust = try core()
        let invalid = try await rust.rawCall(Data("{".utf8))
        XCTAssertThrowsError(try RustCore.value(invalid))
        let response = try await rust.call("normalizeJson", arguments: [
            "json": #"{"unknown":"\ud800"}"#, "canonical": true,
        ])
        let value = try RustCore.value(response) as? String
        XCTAssertTrue(value?.contains("\\ud800") == true)
        for _ in 0..<100 {
            _ = try RustCore.value(await rust.call("nextClock", arguments: ["previous": "0:0", "now": 1]))
        }
    }
}
