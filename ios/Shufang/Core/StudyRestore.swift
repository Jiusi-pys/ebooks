import Foundation

/// IDs are qualified by entity kind: a note and a card may share the same ID.
/// A prepared restore is immutable so staging originals cannot change its mapping.
struct StudyRestorePlan {
    let records: [StudyRecord]
    let idMap: [String: String]
    let fingerprint: String
    let scope: String

    func mappedID(kind: String, id: String) -> String { idMap[kind + ":" + id] ?? id }
    func mappedBook(_ book: Book) -> Book {
        Book(extId: mappedID(kind: "books", id: book.id), title: book.title, author: book.author,
             format: book.format, folder: mappedID(kind: "folders", id: book.folder), chapterCount: book.chapterCount,
             cover: book.cover, customCover: book.customCover, coverTone: book.coverTone, progress: book.progress)
    }
}

enum StudyRestoreError: LocalizedError {
    case changed, deletedInk
    var errorDescription: String? {
        switch self {
        case .changed: return "恢复期间学习资料已发生变化。请重新预览备份后重试，现有学习记录未被覆盖。"
        case .deletedInk: return "此备份包含单独删除过的页面手写。当前版本不支持单独恢复这种手写，尚未恢复任何学习记录。原备份已保留。"
        }
    }
}

enum StudyRestoreRemapping {
    static func fields(_ record: StudyRecord, ids: [String: String], notes: [StudyRecord]) -> [String: JSONValue] {
        func mapped(_ id: String, _ kind: String) -> String { ids[kind + ":" + id] ?? id }
        func reference(_ fields: inout [String: JSONValue], _ key: String, _ kind: String) {
            if let id = fields[key]?.string { fields[key] = .string(mapped(id, kind)) }
        }
        func source(_ value: JSONValue) -> JSONValue {
            guard var object = value.object else { return value }
            reference(&object, "bookId", "books")
            return .object(object)
        }
        func node(_ value: JSONValue) -> JSONValue {
            guard var object = value.object else { return value }
            reference(&object, "sourceHighlightId", "highlights")
            if let children = object["children"]?.array { object["children"] = .array(children.map(node)) }
            return .object(object)
        }
        var fields = record.fields
        // Only schema-defined references are remapped. Prose, labels, tags, QA,
        // and extension metadata may contain identical strings and stay intact.
        switch record.kind {
        case "books":
            reference(&fields, "extId", "books")
            reference(&fields, "folderId", "folders")
            reference(&fields, "folder", "folders")
        case "folders": reference(&fields, "parentId", "folders")
        case "highlights":
            reference(&fields, "bookId", "books"); reference(&fields, "noteId", "notes")
            if let ranges = fields["sourceRanges"]?.array { fields["sourceRanges"] = .array(ranges.map(source)) }
        case "notes":
            reference(&fields, "bookId", "books")
            if let content = fields["content"]?.string { fields["content"] = .string(noteLinks(content, ids: ids, notes: notes)) }
        case "studySets":
            if let books = fields["bookIds"]?.array {
                fields["bookIds"] = .array(books.map { value in value.string.map { .string(mapped($0, "books")) } ?? value })
            }
        case "mindMaps":
            reference(&fields, "bookId", "books")
            if let root = fields["root"] { fields["root"] = node(root) }
        case "associations":
            if let value = fields["source"] { fields["source"] = source(value) }
            if let value = fields["target"] { fields["target"] = source(value) }
            if let first = fields["source"], let second = fields["target"],
               let left = try? first.decoded(StudySource.self), let right = try? second.decoded(StudySource.self),
               let pair = StudyAnchors.pairKey(left, right, bidirectional: fields["direction"]?.string != "source-to-target") {
                fields["pairKey"] = .string(pair)
            }
        case "reviews": reference(&fields, "highlightId", "highlights")
        case "translations": reference(&fields, "bookId", "books")
        default: break
        }
        return fields
    }

    private static func noteLinks(_ content: String, ids: [String: String], notes: [StudyRecord]) -> String {
        guard let expression = try? NSRegularExpression(pattern: #"\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]*))?\]\]"#) else { return content }
        let original = content as NSString
        let output = NSMutableString(string: content)
        for match in expression.matches(in: content, range: NSRange(location: 0, length: original.length)).reversed() {
            let target = original.substring(with: match.range(at: 1)).trimmingCharacters(in: .whitespacesAndNewlines)
            let exact = notes.filter { $0.id.caseInsensitiveCompare(target) == .orderedSame }
            let candidates = exact.isEmpty ? notes.filter { $0.fields["title"]?.string?.caseInsensitiveCompare(target) == .orderedSame } : exact
            // Ambiguous title links remain ambiguous rather than choosing a
            // different source. Explicit IDs and unique titles can be rebound.
            guard candidates.count == 1, let note = candidates.first, let id = ids[note.key] else { continue }
            let labelRange = match.range(at: 2)
            let label = labelRange.location == NSNotFound ? target : original.substring(with: labelRange)
            output.replaceCharacters(in: match.range, with: "[[\(id)|\(label)]]")
        }
        return output as String
    }
}
