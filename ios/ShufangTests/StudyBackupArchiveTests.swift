import XCTest
@testable import ShufangCore

final class StudyBackupArchiveTests: XCTestCase {
    private func sample() throws -> StudyBackupArchive {
        let pdf = Data("%PDF-1.7\nsample original".utf8)
        let hash = StudyBackupArchive.hash(pdf)
        let book = Book(extId: "书一", title: "教材", author: "", format: "pdf", folder: "", chapterCount: 0)
        let package = OfflineBookPackage(book: book, chapters: [], contents: [], downloadedAt: Date(timeIntervalSince1970: 100), hasPDF: true)
        let records = [StudyRecord(id: book.id, kind: "sources", fields: ["sha256": .string(hash), "size": .number(Double(pdf.count)), "name": .string("source.pdf"), "type": .string("application/pdf")])]
        let prefix = "books/" + StudyBackupArchive.hash(Data(book.id.utf8)) + "/"
        return try StudyBackupArchive(title: "我的备份", origin: "https://books.example/", userID: "account-1", payloads: [
            "study.json": JSONEncoder().encode(records),
            prefix + "package.json": JSONEncoder().encode(package),
            prefix + "source.pdf": pdf,
            "attachments/" + hash: pdf
        ])
    }
    private func replaceManifest(_ wrapper: FileWrapper, transform: (inout [String: Any]) -> Void) throws {
        let original = try XCTUnwrap(wrapper.fileWrappers?["manifest.json"])
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(original.regularFileContents)) as? [String: Any])
        transform(&json)
        wrapper.removeFileWrapper(original)
        let replacement = FileWrapper(regularFileWithContents: try JSONSerialization.data(withJSONObject: json))
        replacement.preferredFilename = "manifest.json"; wrapper.addFileWrapper(replacement)
    }
    func testRoundTripRetainsOriginalAndHashesWithoutCredentials() throws {
        let archive = try sample()
        let wrapper = try archive.fileWrapper()
        let loaded = try StudyBackupArchive(wrapper: wrapper)
        XCTAssertEqual(loaded.payloads, archive.payloads)
        XCTAssertEqual(try loaded.validatedBooks().first?.1.book.id, "书一")
        let manifest = try XCTUnwrap(wrapper.fileWrappers?["manifest.json"]?.regularFileContents)
        let text = try XCTUnwrap(String(data: manifest, encoding: .utf8))
        XCTAssertFalse(text.contains("sessionToken"))
        XCTAssertFalse(text.contains("password"))
        XCTAssertEqual(loaded.manifest.version, 1)
    }
    func testRejectsTamperedPayload() throws {
        let wrapper = try sample().fileWrapper()
        let old = try XCTUnwrap(wrapper.fileWrappers?["study.json"])
        wrapper.removeFileWrapper(old)
        let altered = FileWrapper(regularFileWithContents: Data("[]".utf8)); altered.preferredFilename = "study.json"; wrapper.addFileWrapper(altered)
        XCTAssertThrowsError(try StudyBackupArchive(wrapper: wrapper))
    }
    func testRejectsFutureVersionBeforeRestoring() throws {
        let wrapper = try sample().fileWrapper()
        try replaceManifest(wrapper) { $0["version"] = 2 }
        XCTAssertThrowsError(try StudyBackupArchive(wrapper: wrapper)) { error in
            guard case StudyBackupError.unsupported = error else { return XCTFail("Expected unsupported version") }
        }
    }
    func testRejectsDuplicateManifestPaths() throws {
        let wrapper = try sample().fileWrapper()
        try replaceManifest(wrapper) { value in
            var entries = value["entries"] as! [[String: Any]]; entries.append(entries[0]); value["entries"] = entries
        }
        XCTAssertThrowsError(try StudyBackupArchive(wrapper: wrapper))
    }
    func testRejectsTraversalPathsAndDeclaredOversizeWithoutAllocation() throws {
        for invalidPath in ["../study.json", "books/../../secret"] {
            let wrapper = try sample().fileWrapper()
            try replaceManifest(wrapper) { value in
                var entries = value["entries"] as! [[String: Any]]; entries[0]["path"] = invalidPath; value["entries"] = entries
            }
            XCTAssertThrowsError(try StudyBackupArchive(wrapper: wrapper))
        }
        let wrapper = try sample().fileWrapper()
        try replaceManifest(wrapper) { value in
            var entries = value["entries"] as! [[String: Any]]; entries[0]["bytes"] = Int.max; value["entries"] = entries
        }
        XCTAssertThrowsError(try StudyBackupArchive(wrapper: wrapper))
    }
    func testRejectsIncompleteReferencedAttachment() throws {
        let blob = Data("ink".utf8)
        let hash = StudyBackupArchive.hash(blob)
        let record = StudyRecord(id: "ink", kind: "notes", fields: ["pdfDrawing": .object(["$attachment": .object(["sha256": .string(hash), "size": .number(Double(blob.count))])])])
        let archive = try StudyBackupArchive(title: "test", origin: "https://books.example", userID: "a", payloads: ["study.json": JSONEncoder().encode([record])])
        XCTAssertThrowsError(try StudyBackupArchive(wrapper: archive.fileWrapper()))
    }
    func testScopeCanonicalizesOriginButRequiresSameAccount() throws {
        let archive = try sample()
        XCTAssertNoThrow(try archive.validateScope(origin: "https://BOOKS.example:443", userID: "account-1"))
        XCTAssertThrowsError(try archive.validateScope(origin: "https://other.example", userID: "account-1"))
        XCTAssertThrowsError(try archive.validateScope(origin: "https://books.example", userID: "account-2"))
    }
    func testRejectsMissingPDFSourceDespiteValidManifest() throws {
        let archive = try sample()
        let files = archive.payloads.filter { !$0.key.hasSuffix("source.pdf") }
        let incomplete = try StudyBackupArchive(title: "test", origin: archive.manifest.origin, userID: archive.manifest.userID, payloads: files)
        let loaded = try StudyBackupArchive(wrapper: incomplete.fileWrapper())
        XCTAssertThrowsError(try loaded.validatedBooks())
    }
}
