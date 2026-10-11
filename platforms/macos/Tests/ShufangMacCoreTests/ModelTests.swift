import AppKit
import Foundation
import XCTest
@testable import ShufangMac
@testable import ShufangMacCore

@MainActor
final class ModelTests: XCTestCase {
    func wait(_ model: LibraryModel) async throws {
        for _ in 0..<300 {
            if !model.busy { return }
            try await Task.sleep(nanoseconds:10_000_000)
        }
        XCTFail("presentation task did not complete")
    }
    func withModel(_ body: (LibraryModel,URL) async throws -> Void) async throws {
        let path = try XCTUnwrap(ProcessInfo.processInfo.environment["SHUFANG_MAC_CORE"])
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let model = LibraryModel()
        await model.open(library:URL(fileURLWithPath:path),localRoot:root)
        XCTAssertTrue(model.ready,model.status)
        do { try await body(model,root); try await model.shutdown() }
        catch { try? await model.shutdown(); try? FileManager.default.removeItem(at:root); throw error }
        try FileManager.default.removeItem(at:root)
    }
    func testDraftIsRetainedOnConflictAndPersistedAfterRestart() async throws {
        try await withModel { model,root in
            model.section = .notes; model.newRecord(); model.title = "Mac 😀"; model.content = "草稿正文"
            model.save(); try await self.wait(model)
            let record = try XCTUnwrap(model.record)
            let workspace = try XCTUnwrap(model.workspace)
            _ = try await workspace.save("notes",id:record.id,revision:record.revision,patch:["content":"其他操作"])
            model.content = "我的未保存草稿"; model.save(); try await self.wait(model)
            XCTAssertEqual(model.content,"我的未保存草稿")
            XCTAssertTrue(model.hasDraft)
            XCTAssertTrue(model.status.contains("草稿已保留"))
            let persisted = try await workspace.get("notes",record.id)
            XCTAssertEqual(persisted.value["content"] as? String,"其他操作")
            try await model.shutdown()
            await model.open(library:URL(fileURLWithPath:ProcessInfo.processInfo.environment["SHUFANG_MAC_CORE"]!),localRoot:root)
            model.select(record.id); try await self.wait(model)
            XCTAssertEqual(model.content,"其他操作")
        }
    }
    func testReadingParagraphPersistsAndMultipleImportsAreRetained() async throws {
        try await withModel { model,root in
            let files = [root.appendingPathComponent("一本.txt"),root.appendingPathComponent("二本.txt")]
            try "第一段\n\n第二段 😀\n\n第三段".write(to:files[0],atomically:true,encoding:.utf8)
            try "另一本不同内容".write(to:files[1],atomically:true,encoding:.utf8)
            model.importFiles(files); try await self.wait(model)
            XCTAssertEqual(model.books.count,2)
            let book = try XCTUnwrap(model.books.first(where:{$0.title == "一本"}))
            model.select(book.id); try await self.wait(model)
            model.checkpoint(0,paragraph:1); try await self.wait(model)
            try await model.shutdown()
            await model.open(library:URL(fileURLWithPath:ProcessInfo.processInfo.environment["SHUFANG_MAC_CORE"]!),localRoot:root)
            model.select(book.id); try await self.wait(model)
            XCTAssertEqual(model.paragraphPosition,1)
            XCTAssertEqual(model.chapters.count,1)
        }
    }
    func testHighlightEditorPreservesSourceAndUnknownFields() async throws {
        try await withModel { model,root in
            let file = root.appendingPathComponent("批注.txt")
            try "中文😀尾".write(to:file,atomically:true,encoding:.utf8)
            model.importFiles([file]); try await self.wait(model)
            let workspace = try XCTUnwrap(model.workspace)
            let book = try await workspace.get("books",model.books[0].id)
            let chapters = book.value["chapters"] as! [[String:Any]]
            let anchor: [String:Any] = ["kind":"text","bookId":book.id,"chapterId":chapters[0]["id"]!,"paraIndex":0,"start":2,"end":4,"text":"😀","future":"原样"]
            _ = try await workspace.save("highlights",id:"h",revision:0,patch:anchor)
            model.changeSection(.highlights); try await self.wait(model)
            model.select("h"); try await self.wait(model)
            model.title = "卡片名称"; model.content = "编辑说明"; model.save(); try await self.wait(model)
            let updated = try await workspace.get("highlights","h")
            XCTAssertEqual(updated.value["text"] as? String,"😀")
            XCTAssertEqual(updated.value["future"] as? String,"原样")
            XCTAssertEqual(updated.value["note"] as? String,"编辑说明")
        }
    }
    func testBookMetadataSaveDoesNotConflictWithItsOwnReadingCheckpoint() async throws {
        try await withModel { model,root in
            let file = root.appendingPathComponent("阅读元数据.txt")
            try "正文😀".write(to:file,atomically:true,encoding:.utf8)
            model.importFiles([file]); try await self.wait(model)
            model.select(model.books[0].id); try await self.wait(model)
            model.author = "Mac 作者"; model.save(); try await self.wait(model)
            XCTAssertTrue(model.status.contains("保存完成"),model.status)
            let workspace = try XCTUnwrap(model.workspace), record = try XCTUnwrap(model.record)
            let saved = try await workspace.get("books",record.id)
            XCTAssertEqual(saved.value["author"] as? String,"Mac 作者")
            _ = try await workspace.save("books",id:record.id,revision:saved.revision,patch:["title":"远端改名"])
            model.author = "我的草稿作者"; model.save(); try await self.wait(model)
            XCTAssertTrue(model.status.contains("草稿已保留"),model.status)
            XCTAssertEqual(model.author,"我的草稿作者")
            let remote = try await workspace.get("books",record.id)
            XCTAssertEqual(remote.value["title"] as? String,"远端改名")
            // shutdown retains the failed metadata draft in this presentation object
        }
    }

    func testLeavingLaterChapterRetainsValidProgressSnapshot() async throws {
        try await withModel { model,_ in
            let workspace = try XCTUnwrap(model.workspace)
            _ = try await workspace.save("books",id:"multi",revision:0,patch:["title":"多章节","author":"","format":"txt","chapters":(0..<3).map { ["id":"c-\($0)","title":"章节 \($0)","paragraphs":["一","二"]] }])
            try await model.refresh(); model.select("multi"); try await self.wait(model)
            model.checkpoint(2,paragraph:1); try await self.wait(model)
            model.changeSection(.search); try await self.wait(model)
            XCTAssertTrue(model.status.contains("刷新完成"),model.status)
            let book = try await workspace.get("books","multi")
            let progress = book.value["progress"] as! [String:Any]
            XCTAssertEqual(progress["chapterId"] as? String,"c-2")
            XCTAssertEqual(progress["paraIndex"] as? Int,1)
            XCTAssertEqual(progress["ratio"] as? Double,2.0/3.0)
        }
    }
    func testFailedWorkspaceSwitchKeepsActiveLibraryAndSuccessfulSwitchClearsEditor() async throws {
        try await withModel { model,root in
            model.section = .notes; model.newRecord(); model.title = "原账户"; model.content = "隔离数据"
            model.save(); try await self.wait(model)
            let id = try XCTUnwrap(model.record?.id)
            do { try await model.switchWorkspace(root.appendingPathComponent("invalid"),identity:"bad/id"); XCTFail("invalid workspace accepted") }
            catch { XCTAssertTrue(model.ready); XCTAssertEqual(model.root,root) }
            let original = try await model.workspace!.get("notes",id)
            XCTAssertEqual(original.value["content"] as? String,"隔离数据")
            try await model.switchWorkspace(root.appendingPathComponent("new-account"),identity:"new-account")
            XCTAssertNil(model.record); XCTAssertTrue(model.content.isEmpty); XCTAssertTrue(model.title.isEmpty); XCTAssertTrue(model.notes.isEmpty)
        }
    }

}
