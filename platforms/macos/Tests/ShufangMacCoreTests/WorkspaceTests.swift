import AppKit
import Foundation
import PDFKit
import XCTest
@testable import ShufangMacCore

final class WorkspaceTests: XCTestCase {
    func withWorkspace(_ body: (MacWorkspace, URL, RustCore) async throws -> Void) async throws {
        let rust = try BridgeTests().core()
        try rust.installKeychain()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("mac-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let session = LibrarySession(core: rust)
        try await session.open(database: root.appendingPathComponent("library.sqlite3"), workspace: "mac-test", replica: "mac-test-replica")
        do { try await body(MacWorkspace(session: session),root,rust); try await session.close() }
        catch { try? await session.close(); try? FileManager.default.removeItem(at: root); throw error }
        try FileManager.default.removeItem(at: root)
    }
    func testCRUDPaginationHydrationAndUnknownFields() async throws {
        try await withWorkspace { workspace,_,_ in
            let body = String(repeating: "中文😀", count: 3000)
            for index in 0..<105 {
                _ = try await workspace.save("notes", id: "n-\(index)", revision: 0, patch: ["title":"笔记 \(index)","content":body,"future":["keep":true]])
            }
            let rows = try await workspace.records("notes")
            XCTAssertEqual(rows.count,105)
            let full = try await workspace.get("notes","n-0")
            XCTAssertEqual(full.value["content"] as? String,body)
            let update = try await workspace.save("notes",id:full.id,revision:full.revision,patch:["title":"修改"])
            XCTAssertEqual((update.value["future"] as? [String: Bool])?["keep"],true)
            do { _ = try await workspace.save("notes",id:full.id,revision:full.revision,patch:["title":"冲突"]); XCTFail("stale revision accepted") }
            catch { XCTAssertEqual(error as? CoreError,.rejected("revision_conflict")) }
            let search = try await workspace.call("searchPage",["query":"笔记","limit":100,"offset":100]) as! [String: Any]
            XCTAssertEqual((search["items"] as? [Any])?.count,4)
        }
    }
    func importText(_ workspace: MacWorkspace, root: URL) async throws -> Record {
        let file = root.appendingPathComponent("验收😀.txt")
        try "中文😀尾\n\n第二段内容".write(to:file,atomically:true,encoding:.utf8)
        let result = try await workspace.importFile(file) as! [String: Any]
        return try Record(result)
    }
    func testRealImportAnchorsCitationsReviewAndAssociation() async throws {
        try await withWorkspace { workspace,root,_ in
            let book = try await self.importText(workspace,root:root)
            let chapters = try XCTUnwrap(book.value["chapters"] as? [[String:Any]])
            let chapter = try XCTUnwrap(chapters.first?["id"] as? String)
            let paras = try XCTUnwrap(chapters.first?["paragraphs"] as? [String])
            let anchor = try XCTUnwrap(TextSelection.anchor(book:book.id,chapter:chapter,paragraphs:paras,range:NSRange(location:2,length:2)))
            let highlight = try await workspace.save("highlights",id:"h",revision:0,patch:anchor)
            let note = try await workspace.save("notes",id:"n",revision:0,patch:["title":"引用笔记","content":"我的总结"])
            _ = try await workspace.call("cite",["highlight":"h","note":"n","highlightRevision":highlight.revision,"noteRevision":note.revision])
            var h = try await workspace.get("highlights","h")
            XCTAssertEqual(h.value["noteId"] as? String,"n")
            let citedNote = try await workspace.get("notes","n")
            XCTAssertTrue((citedNote.value["content"] as? String)?.contains("😀") == true)
            _ = try await workspace.call("uncite",["highlight":"h","highlightRevision":h.revision,"noteRevision":citedNote.revision])
            h = try await workspace.get("highlights","h")
            _ = try await workspace.call("setReview",["id":"h","expected":h.revision,"enabled":true])
            let queue = try await workspace.call("reviewQueue") as! [[String:Any]]
            XCTAssertEqual(queue.count,1)
            let card = try Record(queue[0])
            _ = try await workspace.call("review",["id":"h","expected":card.revision,"rating":3])
            h = try await workspace.get("highlights","h")
            XCTAssertEqual((h.value["review"] as? [String:Any])?["reps"] as? Int,1)
            var target = anchor; target["start"] = 0; target["end"] = 2; target["text"] = "中文"
            _ = try await workspace.save("associations",id:"a",revision:0,patch:["source":anchor,"target":target,"direction":"source-to-target"])
            _ = try await workspace.save("studySets",id:"s",revision:0,patch:["name":"学习集","bookIds":[book.id]])
            _ = try await workspace.save("mindMaps",id:"m",revision:0,patch:["title":"脑图","root":["id":"root","text":"主题","children":[]]])
            _ = try await workspace.call("checkpoint",["id":book.id,"session":"read-session","activeSeconds":10,"progress":["chapterId":chapter,"paraIndex":0,"ratio":0.1]])
            _ = try await workspace.call("checkpoint",["id":book.id,"session":"read-session","activeSeconds":20,"progress":["chapterId":chapter,"paraIndex":1,"ratio":0.2]])
            let updated = try await workspace.get("books",book.id)
            let sessions = try XCTUnwrap(updated.value["readingSessions"] as? [[String:Any]])
            XCTAssertEqual(sessions.count,1)
            XCTAssertEqual((sessions[0]["endedAt"] as! Double)-(sessions[0]["startedAt"] as! Double),20_000)
            let duplicate = try await self.importText(workspace,root:root)
            XCTAssertEqual(duplicate.id,book.id)
            let books = try await workspace.records("books")
            XCTAssertEqual(books.count,1)
        }
    }
    func testPDFKitImportRetainsOriginalAndNormalizedAnchor() async throws {
        try await withWorkspace { workspace,root,_ in
            let path = root.appendingPathComponent("页面.pdf")
            let data = NSMutableData()
            var bounds = CGRect(x:0,y:0,width:600,height:800)
            let consumer = CGDataConsumer(data:data)!
            let context = CGContext(consumer:consumer,mediaBox:&bounds,nil)!
            context.beginPDFPage(nil)
            let text = NSAttributedString(string:"PDF macOS reading",attributes:[.font:NSFont.systemFont(ofSize:20)])
            let line = CTLineCreateWithAttributedString(text)
            context.textPosition = CGPoint(x:50,y:700); CTLineDraw(line,context)
            context.endPDFPage(); context.closePDF()
            try (data as Data).write(to:path)
            let result = try await workspace.importFile(path) as! [String:Any]
            let book = try Record(result)
            XCTAssertEqual(book.value["format"] as? String,"pdf")
            XCTAssertEqual(book.value["pageCount"] as? Int,1)
            let chapters = book.value["chapters"] as! [[String:Any]]
            XCTAssertTrue((chapters[0]["paragraphs"] as! [String])[0].contains("macOS"))
            let resource = try await workspace.call("bookResource",["id":book.id]) as! [String:Any]
            XCTAssertEqual(try Data(contentsOf:URL(fileURLWithPath:resource["path"] as! String)),data as Data)
            _ = try await workspace.save("highlights",id:"pdf-h",revision:0,patch:["kind":"pdf","bookId":book.id,"chapterId":"page-1","text":"PDF","pdfAnchor":["page":1,"rects":[["x":0.1,"y":0.1,"width":0.2,"height":0.05]]]])
        }
    }
    func testRestoreStalePreviewIdempotenceAndWholeLibraryReopen() async throws {
        try await withWorkspace { workspace,root,rust in
            let note = try await workspace.save("notes",id:"n",revision:0,patch:["title":"离线","content":"未同步😀","future":42])
            let archive = root.appendingPathComponent("study.zip")
            _ = try await workspace.call("exportStudyBackup",["path":archive.path,"origin":"offline","userID":"local"])
            let args: [String:Any] = ["path":archive.path,"origin":"offline","userID":"local","policy":"keepBoth"]
            let preview = try await workspace.call("previewStudyRestore",args) as! [String:Any]
            _ = try await workspace.save("notes",id:"n",revision:note.revision,patch:["content":"新编辑"])
            do { _ = try await workspace.call("commitStudyRestore",preview); XCTFail("stale plan accepted") }
            catch { XCTAssertEqual(error as? CoreError,.rejected("restore_preview_changed")) }
            let next = try await workspace.call("previewStudyRestore",args) as! [String:Any]
            _ = try await workspace.call("commitStudyRestore",next)
            let duplicate = try await workspace.call("commitStudyRestore",next) as! [String:Any]
            XCTAssertEqual(duplicate["duplicate"] as? Bool,true)
            let restoredNotes = try await workspace.records("notes")
            XCTAssertEqual(restoredNotes.count,2)
            let backup = root.appendingPathComponent("whole.zip")
            _ = try await workspace.job("backup",["path":backup.path])
            let destination = root.appendingPathComponent("restored")
            _ = try await workspace.job("restore",["path":backup.path,"destination":destination.path])
            let identity = try await RestoreIdentity.read(core: rust, database:destination.appendingPathComponent("library.sqlite3"))
            let session = LibrarySession(core:rust)
            try await session.open(database:destination.appendingPathComponent("library.sqlite3"),workspace:identity.workspace,replica:identity.replica)
            let restored = MacWorkspace(session:session)
            let n = try await restored.get("notes","n")
            XCTAssertEqual(n.value["future"] as? Int,42)
            XCTAssertEqual(n.value["content"] as? String,"新编辑")
            let originalPending = try await workspace.call("changes")
            let restoredPending = try await restored.call("changes")
            XCTAssertEqual(try JSONSerialization.data(withJSONObject: originalPending, options:.sortedKeys), try JSONSerialization.data(withJSONObject: restoredPending, options:.sortedKeys))
            try await session.close()
        }
    }
    func testKeychainABISecretsNeverEnterLibraryArchive() async throws {
        try await withWorkspace { workspace,root,_ in
            let account = KeychainVault.workspaceAccount(root:root.path,provider:"openai")
            defer { try? KeychainVault().remove(account) }
            _ = try await workspace.call("saveAiConfig",["expected":0,"config":["provider":"openai","model":"synthetic","effort":"none"],"apiKey":"test-secret-not-real"])
            XCTAssertEqual(try KeychainVault().load(account),Data("test-secret-not-real".utf8))
            XCTAssertFalse(FileManager.default.fileExists(atPath:root.appendingPathComponent("credentials/openai").path))
            let legacy = root.appendingPathComponent("credentials")
            try FileManager.default.createDirectory(at:legacy,withIntermediateDirectories:true)
            try Data("legacy-owned-test-secret".utf8).write(to:legacy.appendingPathComponent("openai"))
            let archive = root.appendingPathComponent("no-secrets.zip")
            _ = try await workspace.job("backup",["path":archive.path])
            let data = try Data(contentsOf:archive)
            XCTAssertNil(data.range(of:Data("test-secret-not-real".utf8)))
            XCTAssertNil(data.range(of:Data("legacy-owned-test-secret".utf8)))
            XCTAssertNil(data.range(of:Data("credentials/openai".utf8)))
        }
    }
    func testMalformedPDFAndMissingJobsFailWithoutSkip() async throws {
        try await withWorkspace { workspace,root,_ in
            let path = root.appendingPathComponent("invalid.pdf")
            try Data("not a pdf".utf8).write(to:path)
            do { _ = try await workspace.importFile(path); XCTFail("invalid PDF accepted") }
            catch { XCTAssertEqual(error as? CoreError,.rejected("invalid_or_encrypted_pdf")) }
            do { _ = try await workspace.call("job",["id":"missing"]); XCTFail("unknown job accepted") }
            catch { XCTAssertEqual(error as? CoreError,.rejected("job_not_found")) }
        }
    }
    func testPinnedMobiParserAndFB2Import() async throws {
        guard let sample = ProcessInfo.processInfo.environment["SHUFANG_MAC_MOBI_FIXTURE"], ProcessInfo.processInfo.environment["SHUFANG_MOBITOOL"] != nil else { throw CoreError.unavailable("packaged MOBI parser and pinned fixture required") }
        try await withWorkspace { workspace,root,_ in
            let result = try await workspace.importFile(URL(fileURLWithPath:sample)) as! [String:Any]
            let book = try Record(result)
            XCTAssertEqual(book.value["format"] as? String,"mobi")
            XCTAssertFalse((book.value["chapters"] as! [Any]).isEmpty)
            let file = root.appendingPathComponent("示例.fb2")
            try #"<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><book-title>Mac FB2</book-title><author><first-name>测试</first-name><last-name>作者</last-name></author></title-info></description><body><section><title><p>第一章</p></title><p>中文😀正文</p></section></body></FictionBook>"#.write(to:file,atomically:true,encoding:.utf8)
            let fb2 = try Record(try await workspace.importFile(file) as! [String:Any])
            XCTAssertEqual(fb2.value["format"] as? String,"fb2")
            let paragraphs = (fb2.value["chapters"] as! [[String:Any]]).flatMap { $0["paragraphs"] as? [String] ?? [] }
            XCTAssertTrue(paragraphs.joined().contains("中文😀正文"), paragraphs.joined())
        }
    }
    func testVersionRestoresIntoNewDirectoryAndKeepsCurrentEdits() async throws {
        try await withWorkspace { workspace,root,rust in
            let note = try await workspace.save("notes",id:"version-note",revision:0,patch:["title":"原版","content":"版本一"])
            let version = try await workspace.call("createVersion") as! [String:Any]
            _ = try await workspace.save("notes",id:note.id,revision:note.revision,patch:["content":"新编辑"])
            let result = try await workspace.call("restoreVersion",["id":version["id"]!]) as! [String:Any]
            let target = URL(fileURLWithPath:result["path"] as! String)
            defer { try? FileManager.default.removeItem(at:target) }
            XCTAssertNotEqual(target,root)
            XCTAssertEqual(result["activationRequired"] as? Bool,true)
            XCTAssertTrue(FileManager.default.fileExists(atPath:result["safetyBackup"] as! String))
            let identity = try await RestoreIdentity.read(core:rust,database:target.appendingPathComponent("library.sqlite3"))
            let session = LibrarySession(core:rust)
            try await session.open(database:target.appendingPathComponent("library.sqlite3"),workspace:identity.workspace,replica:identity.replica)
            let restored = try await MacWorkspace(session:session).get("notes",note.id)
            XCTAssertEqual(restored.value["content"] as? String,"版本一")
            try await session.close()
            let current = try await workspace.get("notes",note.id)
            XCTAssertEqual(current.value["content"] as? String,"新编辑")
        }
    }
    func testAttachmentRoundTripAndAIResultsUseCoreValidation() async throws {
        try await withWorkspace { workspace,root,_ in
            let book = try await self.importText(workspace,root:root)
            let chapter = (book.value["chapters"] as! [[String:Any]])[0]["id"] as! String
            let anchor: [String:Any] = ["kind":"text","bookId":book.id,"chapterId":chapter,"paraIndex":0,"start":2,"end":4,"text":"😀"]
            let file = root.appendingPathComponent("drawing.json")
            let ink: [String:Any] = ["format":"ShufangPortableInk","version":1,"width":1000,"height":1400,"strokes":[],"future":"保留"]
            let data = try JSONSerialization.data(withJSONObject:ink,options:.sortedKeys)
            try data.write(to:file)
            let reference = try await workspace.call("putAttachment",["path":file.path,"name":"drawing.ink.json","type":"application/vnd.shufang.ink+json"])
            _ = try await workspace.save("notes",id:"ink",revision:0,patch:["title":"手写","content":"","pdfPortableInk":reference])
            let resource = try await workspace.call("attachmentResource",["reference":reference]) as! [String:Any]
            XCTAssertEqual(try Data(contentsOf:URL(fileURLWithPath:resource["path"] as! String)),data)
            _ = try await workspace.call("saveAiResult",["task":"translate","text":"translated","anchor":anchor,"targetLang":"English"])
            let translations = try await workspace.records("translations")
            XCTAssertEqual(translations.count,1)
            _ = try await workspace.call("saveAiResult",["task":"studyCard","text":#"{"title":"卡片","note":"解释","cloze":["😀"],"tags":["测试"]}"#,"anchor":anchor])
            let cards = try await workspace.call("reviewQueue") as! [Any]
            XCTAssertEqual(cards.count,1)
            do { _ = try await workspace.call("saveAiResult",["task":"studyCard","text":#"{"title":"错误","note":"","cloze":["不存在"],"tags":[]}"#,"anchor":anchor]); XCTFail("invalid cloze accepted") }
            catch { XCTAssertEqual(error as? CoreError,.rejected("cloze_not_in_passage")) }
        }
    }

}
