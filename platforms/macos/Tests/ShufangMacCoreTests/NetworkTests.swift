import Foundation
import XCTest
@testable import ShufangMacCore

final class NetworkTests: XCTestCase {
    func testRealRustAccountLoginSyncAndLogout() async throws {
        guard let server = ProcessInfo.processInfo.environment["SHUFANG_MAC_TEST_SERVER"] else { throw CoreError.unavailable("real Rust HTTP fixture is required") }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("mac-http-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        let ready = directory.appendingPathComponent("ready.json")
        let process = Process()
        process.executableURL = URL(fileURLWithPath:server)
        process.arguments = [directory.appendingPathComponent("server").path,ready.path]
        process.environment = ["PATH":"/usr/bin:/bin","HOME":directory.path,"SHUFANG_CREDENTIAL_KEY":String(repeating:"a",count:64)]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        defer { if process.isRunning { process.terminate(); process.waitUntilExit() }; try? FileManager.default.removeItem(at:directory) }
        for _ in 0..<300 {
            if FileManager.default.fileExists(atPath:ready.path) { break }
            guard process.isRunning else { throw CoreError.unavailable("Rust HTTP fixture exited") }
            try await Task.sleep(nanoseconds:100_000_000)
        }
        let value = try JSONSerialization.jsonObject(with:Data(contentsOf:ready)) as! [String:String]
        let origin = try XCTUnwrap(value["origin"])
        let connection = try await AccountClient.login(address:origin,username:"mac-test-user",password:"synthetic-mac-password-123")
        XCTAssertEqual(connection.workspaceID,"mac-test")
        XCTAssertEqual(connection.nodeID,"mac-server")
        XCTAssertEqual(connection.userID,"mac-test-user")
        XCTAssertGreaterThan(connection.expiresAt,Date())
        try await WorkspaceTests().withWorkspace { workspace,_,_ in
            _ = try await workspace.call("enableSyncConflicts")
            _ = try await workspace.save("notes",id:"mac-note",revision:0,patch:["title":"Mac 离线","content":"中文 😀","future":"保留"])
            let args: [String:Any] = ["id":connection.nodeID,"url":origin,"token":"","cookie":"shufang_session=\(connection.token)"]
            _ = try await workspace.job("syncOnce",args)
            let remote = try await workspace.get("notes","server-note")
            XCTAssertEqual(remote.value["content"] as? String,"真实 Rust HTTP → Mac 😀")
            _ = try await workspace.job("syncOnce",args)
            let notes = try await workspace.records("notes")
            XCTAssertEqual(notes.count,2)
            let own = try await workspace.get("notes","mac-note")
            XCTAssertEqual(own.value["future"] as? String,"保留")
            let otherSession = LibrarySession(core: try BridgeTests().core())
            let otherRoot = directory.appendingPathComponent("second-client")
            try await otherSession.open(database:otherRoot.appendingPathComponent("library.sqlite3"),workspace:"mac-test",replica:"mac-second-replica")
            let other = MacWorkspace(session:otherSession)
            _ = try await other.call("enableSyncConflicts")
            _ = try await other.job("syncOnce",args)
            let secondBase = try await other.get("notes","mac-note")
            _ = try await other.save("notes",id:"mac-note",revision:secondBase.revision,patch:["content":"另一个客户端编辑"])
            let firstBase = try await workspace.get("notes","mac-note")
            _ = try await workspace.save("notes",id:"mac-note",revision:firstBase.revision,patch:["content":"Mac 未同步草稿"])
            _ = try await other.job("syncOnce",args)
            do { _ = try await workspace.job("syncOnce",args) } catch { /* core may stop when conflicts are recorded */ }
            let conflicts = try await workspace.call("syncConflicts") as! [[String:Any]]
            XCTAssertEqual(conflicts.count,1)
            let projection = try await workspace.call("syncConflictPreview",["id":conflicts[0]["id"]!]) as! [String:Any]
            let preview = try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:projection["path"] as! String))) as! [String:Any]
            _ = try await workspace.call("resolveSyncConflict",["id":preview["id"]!,"fingerprint":preview["fingerprint"]!,"choice":"copy"])
            _ = try await workspace.job("syncOnce",args)
            let merged = try await workspace.records("notes")
            let contents = Set(merged.compactMap { $0.value["content"] as? String })
            XCTAssertTrue(contents.contains("Mac 未同步草稿"))
            XCTAssertTrue(contents.contains("另一个客户端编辑"))
            try await otherSession.close()
            var invalid = args; invalid["cookie"] = "shufang_session=expired-test-token"
            do { _ = try await workspace.job("syncOnce",invalid); XCTFail("invalid cookie accepted") }
            catch { XCTAssertTrue(String(describing:error).contains("401")) }
            let retained = try await workspace.get("notes","mac-note")
            XCTAssertEqual(retained.value["content"] as? String,"另一个客户端编辑")
        }
        do { _ = try await AccountClient.login(address:origin,username:"mac-test-user",password:"wrong-test-password"); XCTFail("wrong password accepted") }
        catch { XCTAssertNotNil(error as? CoreError) }
        try await AccountClient.logout(connection)
    }
    func testCancellingPollingCancelsRustNetworkJob() async throws {
        let server = try XCTUnwrap(ProcessInfo.processInfo.environment["SHUFANG_MAC_TEST_SERVER"])
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("mac-cancel-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        let ready = directory.appendingPathComponent("ready.json")
        let process = Process(); process.executableURL = URL(fileURLWithPath:server)
        process.arguments = [directory.appendingPathComponent("server").path,ready.path,"slow"]
        process.environment = ["PATH":"/usr/bin:/bin","HOME":directory.path]
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        try process.run()
        defer { if process.isRunning { process.terminate(); process.waitUntilExit() }; try? FileManager.default.removeItem(at:directory) }
        for _ in 0..<300 {
            if FileManager.default.fileExists(atPath:ready.path) { break }
            guard process.isRunning else { throw CoreError.unavailable("Rust HTTP fixture exited") }
            try await Task.sleep(nanoseconds:100_000_000)
        }
        let value = try JSONSerialization.jsonObject(with:Data(contentsOf:ready)) as! [String:String]
        try await WorkspaceTests().withWorkspace { workspace,_,_ in
            let jobTask = Task { try await workspace.job("syncOnce",["id":"mac-server","url":value["origin"]!,"token":"synthetic-machine-key-only"]) }
            try await Task.sleep(nanoseconds:400_000_000)
            jobTask.cancel()
            let start = Date()
            do { _ = try await jobTask.value; XCTFail("cancelled polling returned success") }
            catch { XCTAssertTrue(error is CancellationError) }
            XCTAssertLessThan(Date().timeIntervalSince(start),5)
            let notes = try await workspace.records("notes")
            XCTAssertTrue(notes.isEmpty)
        }
    }

}
