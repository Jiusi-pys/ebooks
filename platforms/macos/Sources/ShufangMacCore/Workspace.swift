import Foundation
import PDFKit

public struct Record: Identifiable {
    public let id: String
    public let revision: UInt64
    public let value: [String: Any]
    public let pending: [String]
    public var title: String { value["title"] as? String ?? value["name"] as? String ?? String((value["text"] as? String ?? id).prefix(80)) }
    public init(_ row: [String: Any]) throws {
        guard let value = row["value"] as? [String: Any], let id = value["id"] as? String,
              let revision = row["revision"] as? NSNumber else { throw CoreError.rejected("invalid_record") }
        self.value = value; self.id = id; self.revision = revision.uint64Value
        self.pending = row["pendingFields"] as? [String] ?? []
    }
}

public struct MacWorkspace {
    public let session: LibrarySession
    public init(session: LibrarySession) { self.session = session }
    public func call(_ action: String, _ arguments: [String: Any] = [:]) async throws -> Any {
        try RustCore.value(await session.command(action, arguments: arguments))
    }
    public func get(_ kind: String, _ id: String) async throws -> Record {
        guard let row = try await call("get", ["kind": kind, "id": id]) as? [String: Any] else { throw CoreError.rejected("invalid_record") }
        return try Record(row)
    }
    public func records(_ kind: String) async throws -> [Record] {
        var result: [Record] = [], offset = 0
        while true {
            guard let page = try await call("listPage", ["kind": kind, "offset": offset, "limit": 100]) as? [String: Any],
                  let rows = page["items"] as? [[String: Any]] else { throw CoreError.rejected("invalid_page") }
            result += try rows.map(Record.init)
            guard let next = page["nextOffset"] as? Int else { return result }
            guard next > offset else { throw CoreError.rejected("invalid_page_cursor") }
            offset = next
        }
    }
    public func save(_ kind: String, id: String, revision: UInt64, patch: [String: Any], unset: [String] = []) async throws -> Record {
        guard let row = try await call("save", ["kind": kind, "id": id, "expected": revision, "patch": patch, "unset": unset]) as? [String: Any] else { throw CoreError.rejected("invalid_record") }
        return try Record(row)
    }
    public func job(_ action: String, _ arguments: [String: Any], progress: @escaping (Double) async -> Void = { _ in }) async throws -> Any {
        guard let start = try await call(action, arguments) as? [String: Any], let id = start["job"] as? String else { throw CoreError.rejected("invalid_job") }
        do {
            while true {
                try Task.checkCancellation()
                guard let state = try await call("job", ["id": id]) as? [String: Any], let status = state["status"] as? String else { throw CoreError.rejected("invalid_job") }
                await progress(state["progress"] as? Double ?? 0)
                switch status {
                case "completed": return state["result"] ?? NSNull()
                case "failed", "cancelled": throw CoreError.rejected(state["error"] as? String ?? status)
                case "running": try await Task.sleep(nanoseconds: 150_000_000)
                default: throw CoreError.rejected("invalid_job_status")
                }
            }
        } catch {
            // Cancellation of UI polling must also cancel the Rust-owned job.
            let cleanup = Task.detached {
                _ = try? await self.call("cancelJob", ["id": id])
                for _ in 0..<750 {
                    let state = try? await self.call("job", ["id": id]) as? [String: Any]
                    if state?["status"] as? String != "running" { return }
                    try? await Task.sleep(nanoseconds: 100_000_000)
                }
            }
            await cleanup.value
            throw error
        }
    }
    public func importFile(_ source: URL, progress: @escaping (Double) async -> Void = { _ in }) async throws -> Any {
        if source.pathExtension.lowercased() != "pdf" {
            return try await job("import", ["path": source.path, "readerMode": "reflow"], progress: progress)
        }
        // PDFKit is the platform parser; the core validates and commits the import.
        let parseTask = Task.detached(priority: .userInitiated) { () throws -> URL in
            guard let document = PDFDocument(url: source), !document.isLocked,
                  document.pageCount > 0, document.pageCount <= 20_000 else { throw CoreError.rejected("invalid_or_encrypted_pdf") }
            var chapters: [[String: Any]] = [], total = 0
            for index in 0..<document.pageCount {
                try Task.checkCancellation()
                let text = document.page(at: index)?.string ?? ""
                total += text.utf8.count
                guard total <= 32 * 1024 * 1024 else { throw CoreError.rejected("pdf_text_limit") }
                chapters.append(["id": "page-\(index + 1)", "title": "第 \(index + 1) 页", "paragraphs": [text]])
            }
            let value: [String: Any] = ["title": source.deletingPathExtension().lastPathComponent,
                "author": document.documentAttributes?[PDFDocumentAttribute.authorAttribute] as? String ?? "",
                "format": "pdf", "pageCount": document.pageCount, "chapters": chapters,
                "progress": ["chapterId": "page-1", "ratio": 0], "coverTone": 0]
            let target = FileManager.default.temporaryDirectory.appendingPathComponent("shufang-pdf-\(UUID().uuidString).json")
            try JSONSerialization.data(withJSONObject: value).write(to: target, options: .atomic)
            return target
        }
        let parsed = try await withTaskCancellationHandler(operation: { try await parseTask.value }, onCancel: { parseTask.cancel() })
        defer { try? FileManager.default.removeItem(at: parsed) }
        try Task.checkCancellation()
        return try await call("importParsed", ["path": source.path, "parsedPath": parsed.path, "readerMode": "original"])
    }
}
