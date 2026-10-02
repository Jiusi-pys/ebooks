import Foundation
import CryptoKit

struct Book: Codable, Identifiable, Hashable {
    var id: String { extId }
    let extId: String
    let title: String
    let author: String
    let format: String
    let folder: String
    let chapterCount: Int
    var cover: String? = nil
    var customCover: String? = nil
    var coverTone: Int? = nil
    var progress: ReadingProgress? = nil
}
struct BooksResponse: Decodable { let books: [Book] }
struct ChapterSummary: Codable, Identifiable, Hashable {
    let id: String
    let index: Int
    let title: String
    let paragraphs: Int
    let chars: Int
}
struct ChaptersResponse: Decodable { let chapters: [ChapterSummary] }
struct Chapter: Codable {
    let id: String
    let index: Int
    let title: String
    let paragraphs: [String]
    var footnotes: [BookFootnote]? = nil
}
struct Note: Codable, Identifiable {
    var id: String { extId }
    let extId: String
    let title: String
    let content: String?
}
struct NotesResponse: Codable { let notes: [Note] }
struct NoteDetail: Decodable {
    let extId: String
    let title: String
    let content: String
}
struct NoteWrite: Encodable {
    let extId: String
    let title: String
    let content: String
}
struct Highlight: Decodable, Identifiable {
    var id: String { extId }
    let extId: String
    let bookExtId: String
    let bookTitle: String
    let chapterId: String?
    let chapterTitle: String
    let text: String
    let note: String?
    let name: String?
    let cloze: [String]?
    let review: ReviewState?
}
struct HighlightsResponse: Decodable { let highlights: [Highlight] }
struct ReviewResponse: Decodable { let now: Double; let cards: [Highlight] }
struct HighlightWrite: Encodable {
    let extId: String
    let bookExtId: String
    let bookTitle: String
    let chapterId: String
    let chapterTitle: String
    let text: String
    let paraIndex: Int
    let start: Int
    let end: Int
    let note: String
    let review: ReviewState?
    // Explicit encoder keeps the UTF-16 end offset in the wire contract.
    enum CodingKeys: String, CodingKey {
        case extId, bookExtId, bookTitle, chapterId, chapterTitle, text, paraIndex, start, end, note, review
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(extId, forKey: .extId)
        try c.encode(bookExtId, forKey: .bookExtId)
        try c.encode(bookTitle, forKey: .bookTitle)
        try c.encode(chapterId, forKey: .chapterId)
        try c.encode(chapterTitle, forKey: .chapterTitle)
        try c.encode(text, forKey: .text)
        try c.encode(paraIndex, forKey: .paraIndex)
        try c.encode(start, forKey: .start)
        try c.encode(end, forKey: .end)
        try c.encode(note, forKey: .note)
        try c.encodeIfPresent(review, forKey: .review)
    }
}
struct ReviewPatch: Encodable { let review: ReviewState }
struct AskWrite: Encodable {
    let question: String
    let title: String
    let chapterTitle: String
    let chapterContext: String
    let selection: String
}
struct AskResponse: Decodable { let answer: String }
struct WriteResponse: Decodable { let ok: Bool }

struct ReviewState: Codable, Equatable {
    var due: Double
    var reps: Int
    var lapses: Int
    var interval: Double
    var lastRating: Int?
    var lastReviewedAt: Double?
    var addedAt: Double
    static func new(now: Double = Date().timeIntervalSince1970 * 1000) -> Self {
        .init(due: now, reps: 0, lapses: 0, interval: 0, addedAt: now)
    }
    // Matches app/src/lib/srs.ts, including JavaScript's positive rounding.
    func graded(_ rating: Int, now: Double) -> Self {
        precondition((1...4).contains(rating))
        var s = self
        s.lastRating = rating
        s.lastReviewedAt = now
        if rating == 1 {
            s.reps = 0; s.lapses += 1; s.interval = 0; s.due = now + 300_000
        } else if reps == 0 {
            s.reps = 1
            if rating == 2 { s.due = now + 600_000 }
            else {
                s.interval = rating == 3 ? 1 : 2
                s.due = now + s.interval * 86_400_000
            }
        } else {
            let factor = rating == 2 ? 1.2 : rating == 3 ? 2.2 : 3.2
            s.interval = max(1, floor(max(interval, 1) * factor + 0.5))
            s.due = now + s.interval * 86_400_000
            s.reps += 1
        }
        return s
    }
}

struct ReadingProgress: Codable, Hashable {
    let chapterId: String
    let ratio: Double
}
struct ReadingSession: Codable, Hashable, Identifiable {
    let id: String
    let bookId: String
    let startedAt: Double
    var endedAt: Double
}
enum ReadingTime {
    static func merge(_ sessions: [ReadingSession]) -> [ReadingSession] {
        var byID: [String: ReadingSession] = [:]
        for session in sessions where session.endedAt >= session.startedAt {
            if let old = byID[session.id] {
                byID[session.id] = ReadingSession(id: session.id, bookId: old.bookId,
                    startedAt: min(old.startedAt, session.startedAt),
                    endedAt: max(old.endedAt, session.endedAt))
            } else { byID[session.id] = session }
        }
        return byID.values.sorted { $0.startedAt < $1.startedAt }
    }
    static func duration(_ sessions: [ReadingSession]) -> Double {
        let intervals = merge(sessions).filter { $0.endedAt > $0.startedAt }
            .sorted { $0.startedAt < $1.startedAt }
        var end = 0.0
        var total = 0.0
        for item in intervals {
            total += max(0, item.endedAt - max(end, item.startedAt))
            end = max(end, item.endedAt)
        }
        return total
    }
    static func label(_ milliseconds: Double) -> String {
        let seconds = max(0, Int(milliseconds / 1000))
        if seconds > 0 && seconds < 60 { return "\(seconds) 秒" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes) 分钟" }
        return minutes % 60 == 0 ? "\(minutes / 60) 小时" : "\(minutes / 60) 小时 \(minutes % 60) 分钟"
    }
}
struct ProgressPatch: Encodable { let progress: ReadingProgress }
struct SyncCapabilities: Decodable {
    let version: Int
    let workspaceId: String
    let nodeId: String
}

// The v2 compatibility adapter returns materialized workspace records, whereas
// older servers return compact v1 DTOs. Decode both without changing stored IDs.
extension Book {
    private enum CodingKeys: String, CodingKey {
        case extId, id, title, author, format, folder, folderId, chapterCount, chapters, cover, customCover, coverTone, progress
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        extId = try c.decodeIfPresent(String.self, forKey: .extId) ?? c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        author = try c.decodeIfPresent(String.self, forKey: .author) ?? ""
        format = try c.decode(String.self, forKey: .format)
        folder = try c.decodeIfPresent(String.self, forKey: .folder) ?? c.decodeIfPresent(String.self, forKey: .folderId) ?? ""
        chapterCount = try c.decodeIfPresent(Int.self, forKey: .chapterCount) ?? c.decodeIfPresent([Chapter].self, forKey: .chapters)?.count ?? 0
        cover = try c.decodeIfPresent(String.self, forKey: .cover)
        customCover = try c.decodeIfPresent(String.self, forKey: .customCover)
        coverTone = try c.decodeIfPresent(Int.self, forKey: .coverTone)
        progress = try c.decodeIfPresent(ReadingProgress.self, forKey: .progress)
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(extId, forKey: .extId)
        try c.encode(title, forKey: .title)
        try c.encode(author, forKey: .author)
        try c.encode(format, forKey: .format)
        try c.encode(folder, forKey: .folder)
        try c.encode(chapterCount, forKey: .chapterCount)
        try c.encodeIfPresent(cover, forKey: .cover)
        try c.encodeIfPresent(customCover, forKey: .customCover)
        try c.encodeIfPresent(coverTone, forKey: .coverTone)
        try c.encodeIfPresent(progress, forKey: .progress)
    }
}
extension Chapter {
    private enum CodingKeys: String, CodingKey { case id, index, title, paragraphs, footnotes }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        index = try c.decodeIfPresent(Int.self, forKey: .index) ?? 0
        title = try c.decode(String.self, forKey: .title)
        paragraphs = try c.decode([String].self, forKey: .paragraphs)
        footnotes = try c.decodeIfPresent([BookFootnote].self, forKey: .footnotes)
    }
}
extension ChaptersResponse {
    private enum CodingKeys: String, CodingKey { case chapters }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let summaries = try? c.decode([ChapterSummary].self, forKey: .chapters) {
            chapters = summaries
        } else {
            chapters = try c.decode([Chapter].self, forKey: .chapters).enumerated().map { index, chapter in
                ChapterSummary(id: chapter.id, index: index, title: chapter.title,
                    paragraphs: chapter.paragraphs.count,
                    chars: chapter.paragraphs.reduce(0) { $0 + $1.utf16.count })
            }
        }
    }
}
extension Highlight {
    private enum CodingKeys: String, CodingKey {
        case extId, id, bookExtId, bookId, bookTitle, chapterId, chapterTitle, text, note, name, cloze, review
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        extId = try c.decodeIfPresent(String.self, forKey: .extId) ?? c.decode(String.self, forKey: .id)
        bookExtId = try c.decodeIfPresent(String.self, forKey: .bookExtId) ?? c.decode(String.self, forKey: .bookId)
        bookTitle = try c.decodeIfPresent(String.self, forKey: .bookTitle) ?? "书摘"
        chapterId = try c.decodeIfPresent(String.self, forKey: .chapterId)
        chapterTitle = try c.decodeIfPresent(String.self, forKey: .chapterTitle) ?? ""
        text = try c.decode(String.self, forKey: .text)
        note = try c.decodeIfPresent(String.self, forKey: .note)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        cloze = try c.decodeIfPresent([String].self, forKey: .cloze)
        review = try c.decodeIfPresent(ReviewState.self, forKey: .review)
    }
}

// A completed package is promoted into place only after every chapter (and
// optional PDF source) has arrived. Incomplete downloads are never listed.
struct OfflineBookPackage: Codable {
    let book: Book
    let chapters: [ChapterSummary]
    let contents: [Chapter]
    let downloadedAt: Date
    let hasPDF: Bool

    func chapter(at index: Int) -> Chapter? {
        guard chapters.indices.contains(index) else { return nil }
        return contents.first { $0.id == chapters[index].id }
    }
}

enum OfflineBookError: LocalizedError {
    case incomplete, empty, tooLarge
    var errorDescription: String? {
        switch self {
        case .incomplete: return "章节下载不完整，请重新下载。"
        case .empty: return "服务器没有可离线阅读的章节或 PDF 原文件。"
        case .tooLarge: return "PDF 原文件超过 256 MB，暂不能下载到本机。"
        }
    }
}

actor OfflineLibrary {
    private let root: URL
    private let files = FileManager.default

    init(configuration: ServerConfiguration, baseDirectory: URL? = nil) {
        let base = baseDirectory ?? FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let scope = configuration.origin.absoluteString + "|" + configuration.userID
        let digest = SHA256.hash(data: Data(scope.utf8))
            .map { String(format: "%02x", $0) }.joined()
        root = base.appendingPathComponent("Shufang/Offline", isDirectory: true)
            .appendingPathComponent(digest, isDirectory: true)
    }

    private func directory(for bookID: String) -> URL {
        let digest = SHA256.hash(data: Data(bookID.utf8))
            .map { String(format: "%02x", $0) }.joined()
        return root.appendingPathComponent(digest, isDirectory: true)
    }

    func package(for bookID: String) -> OfflineBookPackage? {
        let url = directory(for: bookID).appendingPathComponent("manifest.json")
        guard let data = try? Data(contentsOf: url),
              let package = try? JSONDecoder().decode(OfflineBookPackage.self, from: data),
              package.book.id == bookID,
              package.chapters.count == package.contents.count,
              (!package.contents.isEmpty || package.hasPDF) else { return nil }
        return package
    }

    func savedBooks() -> [Book] {
        guard let directories = try? files.contentsOfDirectory(
            at: root, includingPropertiesForKeys: nil) else { return [] }
        return directories.compactMap { directory -> Book? in
            let url = directory.appendingPathComponent("manifest.json")
            guard let data = try? Data(contentsOf: url),
                  let package = try? JSONDecoder().decode(OfflineBookPackage.self, from: data),
                  self.directory(for: package.book.id).lastPathComponent == directory.lastPathComponent,
                  package.chapters.count == package.contents.count,
                  (!package.contents.isEmpty || package.hasPDF) else { return nil }
            return package.book
        }
    }

    func chapter(bookID: String, index: Int) -> Chapter? {
        package(for: bookID)?.chapter(at: index)
    }

    /// Upgrade old offline manifests without changing text, source offsets or PDFs.
    func refreshFootnotes(bookID: String, chapter incoming: Chapter) throws -> Chapter? {
        guard let saved = package(for: bookID),
              let position = saved.contents.firstIndex(where: { $0.id == incoming.id }),
              saved.contents[position].paragraphs == incoming.paragraphs else { return nil }
        var contents = saved.contents
        contents[position].footnotes = incoming.footnotes ?? []
        let updated = OfflineBookPackage(book: saved.book, chapters: saved.chapters,
            contents: contents, downloadedAt: saved.downloadedAt, hasPDF: saved.hasPDF)
        try JSONEncoder().encode(updated).write(to: directory(for: bookID)
            .appendingPathComponent("manifest.json"), options: .atomic)
        return contents[position]
    }

    func pdf(bookID: String) -> Data? {
        guard package(for: bookID)?.hasPDF == true else { return nil }
        return try? Data(contentsOf: directory(for: bookID)
            .appendingPathComponent("source.pdf"))
    }

    func save(book: Book, chapters: [ChapterSummary], contents: [Chapter],
              pdf: Data?) throws {
        try Task.checkCancellation()
        guard chapters.count == contents.count,
              zip(chapters, contents).allSatisfy({ $0.0.id == $0.1.id }) else {
            throw OfflineBookError.incomplete
        }
        guard !contents.isEmpty || pdf != nil else { throw OfflineBookError.empty }
        if let pdf, pdf.count > 256 * 1024 * 1024 { throw OfflineBookError.tooLarge }
        try files.createDirectory(at: root, withIntermediateDirectories: true)
        var rootURL = root
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        try rootURL.setResourceValues(resourceValues)
        let temporary = root.appendingPathComponent(".partial-\(UUID().uuidString)",
            isDirectory: true)
        try files.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? files.removeItem(at: temporary) }
        let package = OfflineBookPackage(book: book, chapters: chapters,
            contents: contents, downloadedAt: Date(), hasPDF: pdf != nil)
        try JSONEncoder().encode(package).write(
            to: temporary.appendingPathComponent("manifest.json"), options: .atomic)
        if let pdf {
            try pdf.write(to: temporary.appendingPathComponent("source.pdf"), options: .atomic)
        }
        #if os(iOS)
        let protected = [temporary.appendingPathComponent("manifest.json"),
            temporary.appendingPathComponent("source.pdf")]
        for url in protected where files.fileExists(atPath: url.path) {
            try files.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: url.path)
        }
        #endif
        let destination = directory(for: book.id)
        try Task.checkCancellation()
        let backup = root.appendingPathComponent(".previous-\(UUID().uuidString)",
            isDirectory: true)
        let existed = files.fileExists(atPath: destination.path)
        if existed { try files.moveItem(at: destination, to: backup) }
        do {
            try files.moveItem(at: temporary, to: destination)
            if existed { try? files.removeItem(at: backup) }
        } catch {
            if existed { try? files.moveItem(at: backup, to: destination) }
            throw error
        }
    }

    func remove(bookID: String) throws {
        let url = directory(for: bookID)
        if files.fileExists(atPath: url.path) { try files.removeItem(at: url) }
    }
}
