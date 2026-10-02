import SwiftUI
import UniformTypeIdentifiers
import CryptoKit

extension UTType {
    static let shufangStudyBackup = UTType(exportedAs: "org.shufang.study-backup", conformingTo: .package)
}

typealias StudyBackupDocument = StudyBackupArchive
extension StudyBackupArchive: FileDocument {
    static var readableContentTypes: [UTType] { [.shufangStudyBackup] }
    init(configuration: ReadConfiguration) throws { try self.init(wrapper: configuration.file) }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { try fileWrapper() }
}

struct StudyTransferView: View {
    var studySetID: String? = nil
    @EnvironmentObject private var state: AppState
    var body: some View {
        Group {
            if let store = state.study { StudyTransferContent(store: store, initialSetID: studySetID) }
            else { ContentUnavailableView("请先登录书房", systemImage: "person.crop.circle") }
        }.navigationTitle("导出与备份").navigationBarTitleDisplayMode(.inline)
    }
}

private struct StudyTransferContent: View {
    @ObservedObject var store: StudyStore
    let initialSetID: String?
    @EnvironmentObject private var state: AppState
    @State private var selectedSetID = ""
    @State private var document: StudyBackupDocument?
    @State private var showingExporter = false
    @State private var importing = false
    @State private var restoring: StudyBackupDocument?
    @State private var restorePolicy = 0
    @State private var busy = false
    @State private var progress = ""
    @State private var operation: Task<Void, Never>?
    @State private var error: String?
    @State private var message: String?
    @State private var markdownURL: URL?
    private var selectedSet: StudySet? { store.sets.first { $0.id == selectedSetID } }
    private var bookIDs: Set<String>? { selectedSet.map { Set($0.bookIds) } }
    private var title: String { selectedSet?.name ?? "我的书房" }
    var body: some View {
        Form {
            ErrorBanner(message: error)
            if let message { Label(message, systemImage: "checkmark.circle").foregroundStyle(ShufangStyle.pine) }
            Section("备份范围") {
                Picker("学习资料", selection: $selectedSetID) {
                    Text("全部学习资料").tag("")
                    ForEach(store.sets) { Text($0.name).tag($0.id) }
                }.disabled(busy)
                Text("包含卡片、笔记、学习集、脑图、复习记录、手写附件和书籍原文。尚未下载的原文会先下载。来源关联引用的其他书籍也会一并备份。备份不含密码和登录凭据。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("导出") {
                Button("导出 Markdown 笔记与卡片", systemImage: "doc.text") { exportMarkdown() }.disabled(busy)
                if let markdownURL { ShareLink(item: markdownURL) { Label("分享 Markdown 文件", systemImage: "square.and.arrow.up") } }
                Button("创建完整备份", systemImage: "archivebox") {
                    operation = Task { await createBackup() }
                }.disabled(busy)
                if busy {
                    ProgressView(progress)
                    Button("取消", role: .cancel) { operation?.cancel() }.disabled(restoring != nil)
                }
            }
            Section("恢复") {
                Button("选择备份文件", systemImage: "arrow.counterclockwise") { importing = true }.disabled(busy)
                Text("先校验文件并预览差异，再选择如何处理已有内容。仅可恢复到原服务器和原账户。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let backup = restoring { restorePreview(backup) }
        }
        .onAppear { selectedSetID = initialSetID ?? "" }
        .fileExporter(isPresented: $showingExporter, document: document, contentType: .shufangStudyBackup, defaultFilename: title + "-学习备份") { result in
            switch result { case .success: message = "备份已保存。"; case .failure(let failure): error = failure.localizedDescription }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.shufangStudyBackup], allowsMultipleSelection: false) { result in
            do {
                guard let url = try result.get().first else { return }
                let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                let wrapper = try FileWrapper(url: url, options: .immediate)
                let candidate = try StudyBackupDocument(wrapper: wrapper)
                try validateScope(candidate)
                _ = try candidate.validatedBooks()
                restoring = candidate; restorePolicy = 0; message = nil; error = nil
            } catch { self.error = error.localizedDescription }
        }
        .onDisappear { if restoring == nil { operation?.cancel() } }
    }
    @ViewBuilder private func restorePreview(_ backup: StudyBackupDocument) -> some View {
        let existing = Set(store.records.map(\.key))
        let conflicts = backup.records.filter { existing.contains($0.key) }.count
        Section("恢复预览") {
            Text(backup.manifest.title).font(.headline)
            LabeledContent("备份时间", value: backup.manifest.createdAt.formatted(date: .abbreviated, time: .shortened))
            LabeledContent("学习记录", value: "\(backup.records.count) 项")
            LabeledContent("原文", value: "\(backup.books.count) 本")
            LabeledContent("与本机相同标识", value: "\(conflicts) 项")
            LabeledContent("已校验文件", value: "\(backup.manifest.entries.count) 个")
            Picker("已有内容", selection: $restorePolicy) {
                Text("保留本机版本").tag(0)
                Text("保留双方副本").tag(1)
                Text("使用备份版本").tag(2)
            }.disabled(busy)
            Text(restorePolicy == 2 ? "相同标识的学习记录和离线原文将使用备份版本；其他记录保留。更改会加入待同步队列。" : restorePolicy == 1 ? "已存在的学习记录会创建副本并重连引用；相同书籍继续共用原文。" : "跳过已有记录，仅恢复缺失内容。")
                .font(.caption).foregroundStyle(.secondary)
            Button("确认恢复") { operation = Task { await restore(backup) } }.disabled(busy)
            Button("取消恢复", role: .cancel) { restoring = nil }.disabled(busy)
        }
    }
    private func validateScope(_ backup: StudyBackupDocument) throws {
        guard let config = state.client?.configuration else { throw StudyBackupError.wrongAccount }
        try backup.validateScope(origin: config.origin.absoluteString, userID: config.userID)
    }
    private func createBackup() async {
        guard !busy, let client = state.client, let offline = state.offline else { return }
        let config = client.configuration
        busy = true; error = nil; message = nil
        defer { busy = false; operation = nil }
        do {
            var payloads: [String: Data] = ["study.json": try store.exportData(bookIDs: bookIDs)]
            let downloaded = await offline.savedBooks()
            var byID = Dictionary(uniqueKeysWithValues: downloaded.map { ($0.id, $0) })
            store.books.forEach { byID[$0.id] = $0 }
            let exported = try JSONDecoder().decode([StudyRecord].self, from: payloads["study.json"]!)
            let exportedBookIDs = Set(exported.filter { $0.kind == "books" }.map(\.id)).union(bookIDs ?? [])
            let books = byID.values.filter { bookIDs == nil || exportedBookIDs.contains($0.id) }.sorted { $0.title < $1.title }
            if !exportedBookIDs.isSubset(of: Set(books.map(\.id))) { throw StudyBackupError.invalid }
            for (offset, book) in books.enumerated() {
                try Task.checkCancellation()
                progress = "准备原文 \(offset + 1)/\(books.count)：\(book.title)"
                var package = await offline.package(for: book.id)
                if package == nil || (book.format.lowercased() == "pdf" && package?.hasPDF != true) {
                    try await download(book, client: client, offline: offline)
                    package = await offline.package(for: book.id)
                }
                guard let package else { throw StudyBackupError.missingBook(book.title) }
                let prefix = "books/" + StudyBackupDocument.hash(Data(book.id.utf8)) + "/"
                payloads[prefix + "package.json"] = try JSONEncoder().encode(package)
                if package.hasPDF {
                    guard let pdf = await offline.pdf(bookID: book.id), pdf.starts(with: Data("%PDF".utf8)) else { throw StudyBackupError.missingBook(book.title) }
                    payloads[prefix + "source.pdf"] = pdf
                }
                if payloads.values.reduce(0, { $0 + $1.count }) > StudyBackupDocument.maximumBytes { throw StudyBackupError.tooLarge }
            }
            // Preserve every referenced blob, including original PDFs and ink that
            // has not yet been opened on this device. Content hashes de-duplicate it.
            let records = try JSONDecoder().decode([StudyRecord].self, from: payloads["study.json"]!)
            let references = try StudyBackupDocument.referencedAttachments(records)
            for (hash, size) in references {
                try Task.checkCancellation()
                guard hash.count == 64, hash.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { throw StudyBackupError.invalid }
                progress = "准备附件…"
                let bytes: Data
                if let local = store.attachmentData(hash) { bytes = local }
                else if let original = payloads.values.first(where: { $0.count == size && StudyBackupDocument.hash($0) == hash }) { bytes = original }
                else { bytes = try await client.data(["blobs", hash], timeout: 180, version: 2) }
                guard bytes.count == size, StudyBackupDocument.hash(bytes) == hash else { throw StudyBackupError.invalid }
                payloads["attachments/" + hash] = bytes
                if payloads.values.reduce(0, { $0 + $1.count }) > StudyBackupDocument.maximumBytes { throw StudyBackupError.tooLarge }
            }
            try Task.checkCancellation()
            document = try StudyBackupDocument(title: title, origin: config.origin.absoluteString, userID: config.userID, payloads: payloads)
            showingExporter = true
        } catch is CancellationError { message = "已取消备份。" }
        catch { self.error = error.localizedDescription }
    }
    private func download(_ book: Book, client: APIClient, offline: OfflineLibrary) async throws {
        guard client.transportConfiguration.expiresAt > Date() else { throw StudyBackupError.missingBook(book.title) }
        let chapters: ChaptersResponse = try await client.request(["books", book.id, "chapters"])
        var contents: [Chapter] = []
        for index in chapters.chapters.indices {
            try Task.checkCancellation()
            let chapter: Chapter = try await client.request(["books", book.id, "chapters", String(index)])
            contents.append(chapter)
        }
        let pdf = book.format.lowercased() == "pdf" ? try await client.data(["books", book.id, "source"], timeout: 180) : nil
        if let pdf, !pdf.starts(with: Data("%PDF".utf8)) { throw StudyBackupError.invalid }
        try await offline.save(book: book, chapters: chapters.chapters, contents: contents, pdf: pdf)
    }
    private func restore(_ backup: StudyBackupDocument) async {
        guard !busy, let offline = state.offline else { return }
        busy = true; progress = "正在恢复学习资料…"; error = nil
        defer { busy = false; operation = nil }
        var previous: [(String, OfflineBookPackage?, Data?)] = []
        do {
            try validateScope(backup)
            guard let data = backup.payloads["study.json"] else { throw StudyBackupError.invalid }
            let policy: StudyRestorePolicy = restorePolicy == 2 ? .replace : restorePolicy == 1 ? .keepBoth : .keepLocal
            // Freeze IDs and queue validation before the first await. Restored
            // tombstoned books and their offline packages must share one new ID.
            let plan = try store.prepareRestore(data: data, policy: policy)
            let books = try backup.validatedBooks()
            // Validate all original-content conflicts before touching any package.
            for (prefix, package) in books {
                let book = plan.mappedBook(package.book)
                if let current = await offline.package(for: book.id), policy != .replace {
                    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
                    let currentText = try encoder.encode(current.contents)
                    let backupText = try encoder.encode(package.contents)
                    let currentPDF = await offline.pdf(bookID: book.id)
                    if currentText != backupText || (package.hasPDF && currentPDF != nil && currentPDF != backup.payloads[prefix + "source.pdf"]) { throw StudyBackupError.changedBook(package.book.title) }
                }
            }
            for (prefix, package) in books {
                let book = plan.mappedBook(package.book)
                let old = await offline.package(for: book.id)
                if let old, policy != .replace && (old.hasPDF || !package.hasPDF) { continue }
                previous.append((book.id, old, await offline.pdf(bookID: book.id)))
                try await offline.save(book: book, chapters: package.chapters, contents: package.contents, pdf: backup.payloads[prefix + "source.pdf"])
            }
            for (path, data) in backup.payloads where path.hasPrefix("attachments/") {
                _ = try store.attachment(name: String(path.dropFirst("attachments/".count)), data: data)
            }
            guard state.study === store else { throw StudyBackupError.wrongAccount }
            try store.restore(plan: plan)
            previous = []
            restoring = nil; message = "学习资料已恢复到本机，待联网后同步。"
            Task { await store.sync() }
        } catch {
            var rollbackFailed = false
            for (id, package, pdf) in previous.reversed() {
                do {
                    if let package { try await offline.save(book: package.book, chapters: package.chapters, contents: package.contents, pdf: pdf) }
                    else { try await offline.remove(bookID: id) }
                } catch { rollbackFailed = true }
            }
            self.error = error.localizedDescription + (rollbackFailed ? " 部分离线原文未能恢复原状，请重新下载受影响的书籍。" : "")
        }
    }
    private func exportMarkdown() {
        do {
            let ids = bookIDs
            let cards = store.cards.filter { ids?.contains($0.bookId) ?? true }
            let linkedNoteIDs = Set(cards.compactMap(\.noteId))
            let notes = store.notes.filter { ids == nil || linkedNoteIDs.contains($0.id) }
            var text = "# \(title)\n\n"
            for note in notes { text += "## \(note.title)\n\n\(note.content)\n\n" }
            text += "## 学习卡片\n\n"
            for card in cards {
                let bookTitle = store.books.first { $0.id == card.bookId }?.title ?? card.bookId
                text += "### \(card.name ?? "摘录")\n\n> " + card.text.replacingOccurrences(of: "\n", with: "\n> ") + "\n\n"
                text += "来源：《\(bookTitle)》 \(card.chapterTitle)\(card.pdfAnchor.map { " 第\($0.page)页" } ?? "")\n\n"
                if let note = card.note, !note.isEmpty { text += note + "\n\n" }
                if let tags = card.tags, !tags.isEmpty { text += tags.map { "#" + $0 }.joined(separator: " ") + "\n\n" }
                for qa in card.aiQa ?? [] { text += "**问：\(qa.q)**\n\n\(qa.a)\n\n" }
            }
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("学习笔记-\(UUID().uuidString).md")
            try Data(text.utf8).write(to: url, options: .atomic)
            markdownURL = url; error = nil
        } catch { self.error = error.localizedDescription }
    }
}
