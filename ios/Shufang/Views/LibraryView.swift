import SwiftUI
import CryptoKit
import UniformTypeIdentifiers
import PDFKit

private struct ImportedChapter: Encodable {
    let id: String
    let title: String
    let paragraphs: [String]
}

private struct ImportedBook: Encodable {
    let extId: String
    let title: String
    let author: String
    let format: String
    let folder: String
    let contentHash: String
    let chapters: [ImportedChapter]

    init(url: URL) throws {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url)
        guard data.count <= 2_000_000 else { throw ImportError.tooLarge }
        guard let raw = String(data: data, encoding: .utf8)
            ?? String(data: data, encoding: .utf16),
            !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ImportError.unsupportedEncoding
        }
        extId = UUID().uuidString
        title = String(url.deletingPathExtension().lastPathComponent.prefix(255))
        author = ""
        // The v2 books projection accepts txt, but not a separate md format.
        format = "txt"
        folder = ""
        contentHash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let normalized = raw.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        let lines = normalized.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        var pieces: [String] = []
        for line in lines {
            var rest = line[...]
            while !rest.isEmpty {
                let part = String(rest.prefix(5_000))
                guard part.utf16.count <= 20_000 else { throw ImportError.tooLarge }
                pieces.append(part)
                rest = rest.dropFirst(part.count)
            }
        }
        guard pieces.count <= 40_000 else { throw ImportError.tooLarge }
        chapters = stride(from: 0, to: pieces.count, by: 100).enumerated().map { number, start in
            ImportedChapter(id: UUID().uuidString, title: "第 \(number + 1) 部分",
                paragraphs: Array(pieces[start..<min(start + 100, pieces.count)]))
        }
    }
}

private enum ImportError: LocalizedError {
    case tooLarge, unsupportedEncoding
    var errorDescription: String? {
        switch self {
        case .tooLarge: return "目前支持不超过 2 MB 的 TXT / Markdown 文件。"
        case .unsupportedEncoding: return "文件没有可读取的文字，请使用 UTF-8 或 UTF-16 编码。"
        }
    }
}

/// This value owns no PDFKit objects; the document and each page are confined
/// to the worker task while extracting text, then released before UI updates.
private struct PreparedPDFImport {
    let book: Book
    let chapters: [ChapterSummary]
    let contents: [Chapter]
    let bytes: Data

    static func read(_ url: URL) throws -> PreparedPDFImport {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        try Task.checkCancellation()
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 256 * 1024 * 1024 else { throw OfflineBookError.tooLarge }
        let bytes = try Data(contentsOf: url, options: .mappedIfSafe)
        guard bytes.count <= 256 * 1024 * 1024 else { throw OfflineBookError.tooLarge }
        try Task.checkCancellation()
        guard let pdf = PDFDocument(data: bytes), !pdf.isLocked, pdf.pageCount > 0 else { throw StudyError.invalidRecord }
        let title = String(url.deletingPathExtension().lastPathComponent.prefix(240))
        let book = Book(extId: UUID().uuidString.lowercased(), title: title, author: "", format: "pdf", folder: "", chapterCount: pdf.pageCount)
        var contents: [Chapter] = []
        for index in 0..<pdf.pageCount {
            try Task.checkCancellation()
            let chapter: Chapter = autoreleasepool {
                Chapter(id: "pdf-page-\(index + 1)", index: index, title: "第 \(index + 1) 页",
                    paragraphs: (pdf.page(at: index)?.string ?? "").components(separatedBy: .newlines).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty })
            }
            contents.append(chapter)
        }
        try Task.checkCancellation()
        let chapters = contents.map { ChapterSummary(id: $0.id, index: $0.index, title: $0.title, paragraphs: $0.paragraphs.count, chars: $0.paragraphs.joined().count) }
        return PreparedPDFImport(book: book, chapters: chapters, contents: contents, bytes: bytes)
    }
}

struct BookCoverView: View {
    let book: Book
    @State private var coverImage: UIImage?
    private var imageSource: String? { book.customCover.flatMap { $0.isEmpty ? nil : $0 } ?? book.cover }
    private let palettes: [(Color, Color)] = [
        (.init(red: 0.20, green: 0.36, blue: 0.32), .init(red: 0.10, green: 0.23, blue: 0.22)),
        (.init(red: 0.55, green: 0.29, blue: 0.26), .init(red: 0.33, green: 0.17, blue: 0.18)),
        (.init(red: 0.30, green: 0.39, blue: 0.54), .init(red: 0.17, green: 0.24, blue: 0.38)),
        (.init(red: 0.52, green: 0.41, blue: 0.26), .init(red: 0.34, green: 0.25, blue: 0.16)),
        (.init(red: 0.38, green: 0.31, blue: 0.47), .init(red: 0.24, green: 0.20, blue: 0.34)),
    ]
    private var palette: (Color, Color) {
        let value = book.id.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) % 10_000 }
        return palettes[value % palettes.count]
    }
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(LinearGradient(colors: [palette.0, palette.1],
                                         startPoint: .topLeading, endPoint: .bottomTrailing))
                if let coverImage {
                    Image(uiImage: coverImage).resizable().scaledToFill()
                        .frame(width: geometry.size.width, height: geometry.size.height).clipped()
                } else {
                  VStack(alignment: .leading, spacing: 0) {
                    Rectangle().fill(.white.opacity(0.55)).frame(width: 28, height: 2)
                    Spacer(minLength: 12)
                    Text(book.title)
                        .font(.system(size: min(20, max(13, geometry.size.width * 0.13)),
                                      weight: .semibold, design: .serif))
                        .lineLimit(4).minimumScaleFactor(0.8).foregroundStyle(.white)
                    Spacer(minLength: 12)
                    Text(book.author.isEmpty ? "书房藏书" : book.author)
                        .font(.system(size: 10, weight: .medium))
                        .lineLimit(2).foregroundStyle(.white.opacity(0.78))
                    Rectangle().fill(.white.opacity(0.35)).frame(height: 1).padding(.top, 10)
                    Text(book.format.uppercased())
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                        .tracking(2).foregroundStyle(.white.opacity(0.7)).padding(.top, 8)
                  }.padding(max(12, geometry.size.width * 0.10))
                }
            }
            .overlay(alignment: .leading) {
                RoundedRectangle(cornerRadius: 10).fill(.black.opacity(0.10)).frame(width: 5)
            }
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .shadow(color: .black.opacity(0.10), radius: 5, x: 0, y: 3)
        }
        .aspectRatio(0.72, contentMode: .fit)
        .accessibilityLabel("《\(book.title)》，\(book.author)")
        .task(id: imageSource) {
            guard let encoded = imageSource,
                  let comma = encoded.firstIndex(of: ","),
                  let bytes = Data(base64Encoded: String(encoded[encoded.index(after: comma)...])) else {
                coverImage = nil; return
            }
            coverImage = UIImage(data: bytes)
        }
    }
}

struct LibraryView: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.scenePhase) private var phase
    @State private var books: [Book] = []
    @State private var downloadedIDs: Set<String> = []
    @State private var search = ""
    @State private var folder = "全部"
    @State private var error: String?
    @State private var loading = false
    @State private var importing = false
    @State private var showingImporter = false
    @State private var importMessage: String?
    @State private var importTask: Task<Void, Never>?
    private let columns = [GridItem(.adaptive(minimum: 142, maximum: 205), spacing: 22)]
    private var folders: [String] {
        ["全部"] + Array(Set(books.map(\.folder))).filter { !$0.isEmpty && $0 != "全部" }.sorted()
    }
    private var filtered: [Book] {
        books.filter { (folder == "全部" || $0.folder == folder) &&
            (search.isEmpty || ($0.title + $0.author).localizedCaseInsensitiveContains(search)) }
    }
    private var continueBook: Book? { books.first(where: { $0.progress != nil }) ?? books.first }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                ErrorBanner(message: error)
                if state.needsLogin {
                    Label("可阅读已下载书籍；请在设置中重新登录以同步书架。",
                          systemImage: "wifi.slash")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let importMessage {
                    Label(importMessage, systemImage: "checkmark.circle.fill")
                        .font(.subheadline).foregroundStyle(ShufangStyle.pine)
                }
                if importing {
                    HStack {
                        ProgressView("正在读取书籍…")
                        Spacer()
                        Button("取消导入", role: .cancel) { importTask?.cancel() }
                    }
                }
                if let book = continueBook, search.isEmpty {
                    NavigationLink { BookView(book: book) } label: {
                        HStack(spacing: 18) {
                            BookCoverView(book: book).frame(width: 74)
                            VStack(alignment: .leading, spacing: 9) {
                                Text("接着读").font(.caption.weight(.semibold))
                                    .foregroundStyle(ShufangStyle.pine)
                                Text(book.title).font(.title3.weight(.semibold))
                                    .foregroundStyle(ShufangStyle.ink).lineLimit(2)
                                Text(book.author.isEmpty ? "打开这本书" : book.author)
                                    .font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                                Label("继续阅读", systemImage: "arrow.right")
                                    .font(.subheadline.weight(.semibold)).foregroundStyle(ShufangStyle.pine)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
                        .background(ShufangStyle.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    }.buttonStyle(.plain)
                }
                VStack(alignment: .leading, spacing: 16) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("我的书架").font(.title2.bold())
                            .foregroundStyle(ShufangStyle.ink)
                        Spacer()
                        Text("\(filtered.count) 本").font(.subheadline).foregroundStyle(.secondary)
                    }
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(folders, id: \.self) { name in
                                Button(name) { folder = name }
                                    .font(.subheadline.weight(folder == name ? .semibold : .regular))
                                    .foregroundStyle(folder == name ? ShufangStyle.tint : ShufangStyle.ink)
                                    .padding(.horizontal, 16).padding(.vertical, 9)
                                    .background(folder == name ? ShufangStyle.tint.opacity(0.12) : ShufangStyle.surface, in: Capsule())
                            }
                        }
                    }
                }
                if loading && books.isEmpty {
                    ProgressView("正在同步书架…").frame(maxWidth: .infinity).padding(28)
                }
                LazyVGrid(columns: columns, alignment: .leading, spacing: 28) {
                    ForEach(filtered) { book in
                        NavigationLink { BookView(book: book) } label: {
                            VStack(alignment: .leading, spacing: 9) {
                                BookCoverView(book: book)
                                    .overlay(alignment: .bottomTrailing) {
                                        if downloadedIDs.contains(book.id) {
                                            Image(systemName: "arrow.down.circle.fill")
                                                .font(.title3).foregroundStyle(.white, ShufangStyle.pine)
                                                .padding(7)
                                        }
                                    }
                                Text(book.title).font(.subheadline.weight(.semibold))
                                    .foregroundStyle(ShufangStyle.ink).lineLimit(1)
                                Text(book.author.isEmpty ? "佚名" : book.author)
                                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }.buttonStyle(.plain)
                    }
                }
                if !loading && filtered.isEmpty && error == nil {
                    ContentUnavailableView(search.isEmpty ? "书架尚无书籍" : "没有匹配的书籍",
                                           systemImage: "books.vertical",
                                           description: Text("请检查服务器书库或调整搜索条件。"))
                }
            }
            .padding(.horizontal, 22).padding(.vertical, 18)
            .frame(maxWidth: 900).frame(maxWidth: .infinity)
        }
        .background(ShufangStyle.paper.ignoresSafeArea())
        .navigationTitle("书房")
        .searchable(text: $search, prompt: "书名或作者")
        .refreshable { await load() }
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                NavigationLink { ReadingHistoryView() } label: {
                    Image(systemName: "clock.arrow.circlepath")
                }.accessibilityLabel("阅读记录")
                Button { showingImporter = true } label: { Image(systemName: "plus") }
                    .disabled(importing).accessibilityLabel("导入书籍")
                Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                    .disabled(loading).accessibilityLabel("刷新书架")
            }
        }
        .fileImporter(isPresented: $showingImporter,
            allowedContentTypes: [.pdf, .plainText, UTType(filenameExtension: "md") ?? .plainText]) { result in
            importTask = Task { await importFile(result) }
        }
        .task { await load() }
        .onChange(of: phase) { _, value in if value == .active { Task { await load() } } }
        .onDisappear { importTask?.cancel() }
        .onChange(of: state.sessionID) { _, _ in importTask?.cancel() }
    }
    private func load() async {
        guard !loading, let client = state.client else { return }
        loading = true; defer { loading = false }
        var cached = await state.offline?.savedBooks() ?? []
        let cachedIDs = Set(cached.map(\.id))
        cached.append(contentsOf: (state.study?.books ?? []).filter { !cachedIDs.contains($0.id) })
        downloadedIDs = Set(cached.map(\.id))
        if books.isEmpty { books = cached }
        if state.needsLogin {
            error = cached.isEmpty ? "请在设置中重新登录，或先联网下载书籍。" : nil
            return
        }
        do {
            let response: BooksResponse = try await client.request(["books"])
            var combined = response.books
            let remoteIDs = Set(combined.map(\.id))
            combined.append(contentsOf: cached.filter { !remoteIDs.contains($0.id) })
            books = combined; error = nil
        } catch {
            if cached.isEmpty { self.error = error.localizedDescription }
            else { books = cached; self.error = nil }
        }
    }
    private func importFile(_ result: Result<URL, Error>) async {
        guard !importing, let client = state.client else { return }
        let sessionID = state.sessionID
        let scopedStore = state.study, scopedOffline = state.offline
        if case .failure(let error) = result,
           (error as NSError).code == NSUserCancelledError { return }
        importing = true; importMessage = nil; error = nil
        defer { importing = false; importTask = nil }
        do {
            let url = try result.get()
            if url.pathExtension.lowercased() == "pdf" {
                guard let store = scopedStore, let offline = scopedOffline else { throw StudyError.unavailable }
                let parsing = Task.detached(priority: .userInitiated) { try PreparedPDFImport.read(url) }
                let prepared = try await withTaskCancellationHandler {
                    try await parsing.value
                } onCancel: { parsing.cancel() }
                try Task.checkCancellation()
                guard state.sessionID == sessionID else { throw CancellationError() }
                try await offline.save(book: prepared.book, chapters: prepared.chapters, contents: prepared.contents, pdf: prepared.bytes)
                do {
                    try Task.checkCancellation()
                    guard state.sessionID == sessionID else { throw CancellationError() }
                    try store.importBook(book: prepared.book, contents: prepared.contents, pdf: prepared.bytes)
                } catch {
                    // This import has a fresh UUID, so rollback cannot remove an
                    // existing book, even after the selected account changes.
                    try? await offline.remove(bookID: prepared.book.id)
                    throw error
                }
                importMessage = "《\(prepared.book.title)》已保存到本机，将自动上传。可在学习页查看同步进度或重试。"
            } else {
                let book = try ImportedBook(url: url)
                try Task.checkCancellation()
                guard state.sessionID == sessionID else { throw CancellationError() }
                try await client.write(["books"], body: book)
                importMessage = "《\(book.title)》已加入书架"
            }
            if state.sessionID == sessionID { await load() }
        } catch is CancellationError { importMessage = "已取消导入。" }
        catch { if state.sessionID == sessionID { self.error = error.localizedDescription } }
    }
}

struct BookView: View {
    let book: Book
    @EnvironmentObject private var state: AppState
    @State private var chapters: [ChapterSummary] = []
    @State private var offlinePackage: OfflineBookPackage?
    @State private var downloading = false
    @State private var downloadCompleted = 0
    @State private var downloadTotal = 0
    @State private var downloadTask: Task<Void, Never>?
    @State private var removeConfirmation = false
    @State private var remoteProgress: ReadingProgress?
    @State private var hasSync = false
    @State private var error: String?
    @State private var loading = false
    private var resumeIndex: Int {
        if let id = remoteProgress?.chapterId,
           let found = chapters.firstIndex(where: { $0.id == id }) { return found }
        return min(max(0, UserDefaults.standard.integer(forKey: state.progressKey(book: book.id))),
                   max(0, chapters.count - 1))
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                ErrorBanner(message: error)
                HStack(alignment: .top, spacing: 22) {
                    BookCoverView(book: book).frame(width: 118)
                    VStack(alignment: .leading, spacing: 10) {
                        Text(book.title).font(.title2.bold())
                            .foregroundStyle(ShufangStyle.ink)
                        Text(book.author.isEmpty ? "佚名" : book.author)
                            .font(.subheadline).foregroundStyle(.secondary)
                        Text("\(book.format.uppercased()) · \(chapters.count) 章")
                            .font(.caption).foregroundStyle(ShufangStyle.muted)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                if let offlinePackage {
                    Label("已下载，可离线阅读 · \(offlinePackage.chapters.count) 章",
                          systemImage: "checkmark.circle.fill")
                        .font(.subheadline).foregroundStyle(ShufangStyle.pine)
                }
                if downloading {
                    VStack(alignment: .leading, spacing: 8) {
                        ProgressView(value: Double(downloadCompleted),
                                     total: Double(max(downloadTotal, 1)))
                        HStack {
                            Text("正在下载 \(downloadCompleted) / \(downloadTotal)")
                                .font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Button("取消") { downloadTask?.cancel() }
                                .font(.caption)
                        }
                    }
                } else {
                    HStack {
                        Button {
                            downloadTask = Task { await download() }
                        } label: {
                            Label(offlinePackage == nil ? "下载离线书籍" : "重新下载",
                                  systemImage: "arrow.down.to.line")
                        }.buttonStyle(.bordered)
                        if offlinePackage != nil {
                            Button("移除下载", role: .destructive) {
                                removeConfirmation = true
                            }.font(.subheadline)
                        }
                    }
                }
                if !chapters.isEmpty {
                    NavigationLink {
                        ReaderStudyWorkspace(book: book, chapters: chapters, initialIndex: resumeIndex)
                    } label: {
                        Label("继续阅读", systemImage: "book.pages")
                            .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 14)
                    }.buttonStyle(.borderedProminent).tint(ShufangStyle.pine)
                }
                if book.format.lowercased() == "pdf" {
                    NavigationLink { PDFStudyView(book: book) } label: {
                        Label("查看 PDF 原版", systemImage: "doc.richtext")
                    }.buttonStyle(.bordered)
                }
                VStack(alignment: .leading, spacing: 12) {
                    Text("目录").font(.system(.title3, design: .serif).bold())
                    if loading { ProgressView("正在读取目录…").padding(.vertical) }
                    ForEach(Array(chapters.enumerated()), id: \.element.id) { offset, chapter in
                        NavigationLink {
                            ReaderStudyWorkspace(book: book, chapters: chapters, initialIndex: offset)
                        } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 14) {
                                Text(String(format: "%02d", offset + 1))
                                    .font(.caption.monospacedDigit()).foregroundStyle(ShufangStyle.muted)
                                Text(chapter.title).foregroundStyle(ShufangStyle.ink)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                            }
                            .font(.subheadline).padding(.vertical, 12)
                            .overlay(alignment: .bottom) { Divider() }
                        }.buttonStyle(.plain)
                    }
                    if !loading && chapters.isEmpty && error == nil {
                        ContentUnavailableView("暂无文本章节", systemImage: "text.book.closed",
                                               description: Text("PDF 书籍可尝试上方原版入口。"))
                    }
                }
            }.padding(22).frame(maxWidth: 700).frame(maxWidth: .infinity)
        }
        .background(ShufangStyle.paper.ignoresSafeArea())
        .navigationTitle(book.title).navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }.task { await load() }
        .confirmationDialog("移除《\(book.title)》的本机下载？", isPresented: $removeConfirmation) {
            Button("移除下载", role: .destructive) { Task { await removeDownload() } }
        } message: {
            Text("服务器上的书籍不会删除，需要时可重新下载。")
        }
    }
    private func load() async {
        guard !loading, let client = state.client else { return }
        loading = true; defer { loading = false }
        offlinePackage = await state.offline?.package(for: book.id)
        if let offlinePackage {
            chapters = offlinePackage.chapters
            hasSync = offlinePackage.hasPDF
        }
        if state.needsLogin {
            error = offlinePackage == nil ? "请在设置中重新登录后读取这本书。" : nil
            return
        }
        do {
            let response: ChaptersResponse = try await client.request(["books", book.id, "chapters"])
            if offlinePackage == nil { chapters = response.chapters }
            error = nil
            hasSync = try await client.detectSync() != nil
            if hasSync {
                let latest: Book = try await client.request(["books", book.id])
                remoteProgress = latest.progress
            }
        } catch {
            if offlinePackage == nil { self.error = error.localizedDescription }
            else { self.error = nil }
        }
    }
    private func download() async {
        guard !downloading, let client = state.client,
              let offline = state.offline else { return }
        downloading = true; error = nil
        downloadCompleted = 0; downloadTotal = 0
        defer { downloading = false; downloadTask = nil }
        do {
            let response: ChaptersResponse = try await client.request(["books", book.id, "chapters"])
            let summaries = response.chapters
            let needsPDF = book.format.lowercased() == "pdf"
            downloadTotal = summaries.count + (needsPDF ? 1 : 0)
            var contents: [Chapter] = []
            for (offset, summary) in summaries.enumerated() {
                try Task.checkCancellation()
                let chapter: Chapter = try await client.request(
                    ["books", book.id, "chapters", String(offset)])
                guard chapter.id == summary.id else { throw OfflineBookError.incomplete }
                contents.append(chapter)
                downloadCompleted += 1
            }
            var pdf: Data?
            if needsPDF {
                try Task.checkCancellation()
                do {
                    pdf = try await client.data(["books", book.id, "source"], timeout: 180)
                    guard pdf?.starts(with: Data("%PDF".utf8)) == true else {
                        throw APIError.invalidResponse
                    }
                    downloadCompleted += 1
                } catch where !contents.isEmpty {
                    // A PDF with extracted text can still be read offline.
                    pdf = nil
                }
            }
            try Task.checkCancellation()
            try await offline.save(book: book, chapters: summaries,
                                   contents: contents, pdf: pdf)
            offlinePackage = await offline.package(for: book.id)
            chapters = summaries
            hasSync = hasSync || pdf != nil
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
    private func removeDownload() async {
        guard let offline = state.offline else { return }
        do {
            try await offline.remove(bookID: book.id)
            offlinePackage = nil
            chapters = []
            await load()
        } catch { self.error = error.localizedDescription }
    }
}

struct NativeSearchView: View {
    @EnvironmentObject private var state: AppState
    @State private var books: [Book] = []
    @State private var notes: [Note] = []
    @State private var highlights: [Highlight] = []
    @State private var query = ""
    @State private var loading = false
    @State private var error: String?
    private var needle: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var matchedBooks: [Book] {
        books.filter { ($0.title + $0.author).localizedCaseInsensitiveContains(needle) }
    }
    private var matchedNotes: [Note] {
        notes.filter { ($0.title + ($0.content ?? "")).localizedCaseInsensitiveContains(needle) }
    }
    private var matchedHighlights: [Highlight] {
        highlights.filter { ($0.text + ($0.note ?? "") + $0.bookTitle).localizedCaseInsensitiveContains(needle) }
    }
    var body: some View {
        List {
            if let error { Section { ErrorBanner(message: error) } }
            if loading { ProgressView("正在读取书房…") }
            if needle.isEmpty {
                ContentUnavailableView("搜索你的书房", systemImage: "magnifyingglass",
                                       description: Text("查找书名、作者、笔记和摘录。"))
            } else {
                if !matchedBooks.isEmpty {
                    Section("书籍 · \(matchedBooks.count)") {
                        ForEach(matchedBooks) { book in
                            NavigationLink { BookView(book: book) } label: {
                                Label(book.title, systemImage: "books.vertical")
                            }
                        }
                    }
                }
                if !matchedNotes.isEmpty {
                    Section("笔记 · \(matchedNotes.count)") {
                        ForEach(matchedNotes) { note in
                            NavigationLink { NoteEditor(existing: note) } label: {
                                Label(note.title, systemImage: "square.and.pencil")
                            }
                        }
                    }
                }
                if !matchedHighlights.isEmpty {
                    Section("摘录 · \(matchedHighlights.count)") {
                        ForEach(matchedHighlights) { item in
                            NavigationLink { HighlightDetailView(highlight: item) } label: {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(item.text).lineLimit(2)
                                    Text(item.bookTitle).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                if matchedBooks.isEmpty && matchedNotes.isEmpty && matchedHighlights.isEmpty && !loading {
                    ContentUnavailableView("没有找到内容", systemImage: "magnifyingglass",
                                           description: Text("试试书名、作者或摘录中的其他词语。"))
                }
            }
        }
        .scrollContentBackground(.hidden).background(ShufangStyle.paper)
        .navigationTitle("搜索")
        .searchable(text: $query, prompt: "书名、笔记或摘录")
        .refreshable { await load() }.task { await load() }
    }
    private func load() async {
        guard !loading, let client = state.client else { return }
        loading = true; defer { loading = false }
        do {
            let booksResponse: BooksResponse = try await client.request(["books"])
            let notesResponse: NotesResponse = try await client.request(["notes"])
            let highlightsResponse: HighlightsResponse = try await client.request(["highlights"])
            books = booksResponse.books; notes = notesResponse.notes
            highlights = highlightsResponse.highlights; error = nil
        } catch { self.error = error.localizedDescription }
    }
}

struct HighlightDetailView: View {
    let highlight: Highlight
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Image(systemName: "quote.opening").font(.title).foregroundStyle(ShufangStyle.pine)
                Text(highlight.text).font(.system(.title3, design: .serif)).lineSpacing(8)
                    .textSelection(.enabled)
                if let note = highlight.note, !note.isEmpty { Divider(); Text(note).textSelection(.enabled) }
                Text("《\(highlight.bookTitle)》 · \(highlight.chapterTitle)")
                    .font(.footnote).foregroundStyle(.secondary)
            }.padding(24).frame(maxWidth: 700, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(ShufangStyle.paper.ignoresSafeArea())
        .navigationTitle("摘录").navigationBarTitleDisplayMode(.inline)
    }
}
