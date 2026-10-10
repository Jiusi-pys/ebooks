import Foundation

enum JSONValue: Codable, Equatable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
    var string: String? { if case .string(let v) = self { return v }; return nil }
    var object: [String: JSONValue]? { if case .object(let v) = self { return v }; return nil }
    var array: [JSONValue]? { if case .array(let v) = self { return v }; return nil }
    var number: Double? { if case .number(let v) = self { return v }; return nil }
    static func encoded<T: Encodable>(_ value: T) throws -> JSONValue {
        try JSONDecoder().decode(Self.self, from: JSONEncoder().encode(value))
    }
    func decoded<T: Decodable>(_ type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(self))
    }
}

struct StudyPDFRect: Codable, Equatable { var x: Double; var y: Double; var width: Double; var height: Double }
struct StudyPDFAnchor: Codable, Equatable { var page: Int; var rects: [StudyPDFRect] }
struct StudyStyle: Codable, Equatable { var kind = "underline"; var color = "orange" }
struct StudyQA: Codable, Equatable { var q: String; var a: String; var ts: Double }
struct StudySource: Codable, Equatable, Identifiable {
    var id: String { StudyAnchors.key(self) ?? (bookId + ":" + chapterId) }
    var kind = "text"
    var bookId: String
    var chapterId = ""
    var chapterTitle = ""
    var text = ""
    var paraIndex: Int? = nil
    var start: Int? = nil
    var end: Int? = nil
    var pdfAnchor: StudyPDFAnchor? = nil
}
struct StudyCard: Codable, Equatable, Identifiable {
    var id = UUID().uuidString.lowercased()
    var bookId: String
    var chapterId = ""
    var chapterTitle = ""
    var text: String
    var paraIndex: Int? = nil
    var start: Int? = nil
    var end: Int? = nil
    var pdfAnchor: StudyPDFAnchor? = nil
    var style: StudyStyle? = nil
    var name: String? = nil
    var note: String? = nil
    var noteId: String? = nil
    var aiQa: [StudyQA]? = nil
    var tags: [String]? = nil
    var cloze: [String]? = nil
    var review: ReviewState? = nil
    var sourceRanges: [StudySource]? = nil
    var createdAt = Date().timeIntervalSince1970 * 1000
    var source: StudySource {
        StudySource(kind: pdfAnchor == nil ? "text" : "pdf", bookId: bookId,
            chapterId: chapterId, chapterTitle: chapterTitle, text: text,
            paraIndex: paraIndex, start: start, end: end, pdfAnchor: pdfAnchor)
    }
}
struct StudyNote: Codable, Equatable, Identifiable {
    var id = UUID().uuidString.lowercased()
    var title: String
    var content: String
    var createdAt = Date().timeIntervalSince1970 * 1000
    var updatedAt = Date().timeIntervalSince1970 * 1000
}
struct StudySet: Codable, Equatable, Identifiable {
    var id = UUID().uuidString.lowercased()
    var name: String
    var description: String? = nil
    var bookIds: [String] = []
    var createdAt = Date().timeIntervalSince1970 * 1000
    var updatedAt = Date().timeIntervalSince1970 * 1000
}
struct StudyMindNode: Codable, Equatable, Identifiable {
    var id = UUID().uuidString.lowercased()
    var text: String
    var children: [StudyMindNode] = []
    var chapterId: String? = nil
    var sourceHighlightId: String? = nil
    var collapsed: Bool? = nil
}
struct StudyMindMap: Codable, Equatable, Identifiable {
    var id = UUID().uuidString.lowercased()
    var title: String
    var bookId: String? = nil
    var root: StudyMindNode
    var createdAt = Date().timeIntervalSince1970 * 1000
    var updatedAt = Date().timeIntervalSince1970 * 1000
}
struct StudyAssociation: Codable, Equatable, Identifiable {
    var id = UUID().uuidString.lowercased()
    var source: StudySource
    var target: StudySource
    var direction = "bidirectional"
    var label: String? = nil
    var pairKey: String
    var createdAt = Date().timeIntervalSince1970 * 1000
    var updatedAt = Date().timeIntervalSince1970 * 1000
}
struct StudyReviewEvent: Codable, Equatable, Identifiable {
    var id = UUID().uuidString.lowercased()
    var highlightId: String
    var rating: Int
    var reviewedAt: Double
    var review: ReviewState
}
struct StudyRecord: Codable, Equatable, Identifiable {
    var id: String
    var kind: String
    var fields: [String: JSONValue]
    var key: String { kind + ":" + id }
}
struct StudyConflict: Codable, Identifiable {
    var id: String
    var kind: String
    var entityId: String
    var local: [String: JSONValue]
    var remote: [String: JSONValue]
    var localDeleted: Bool? = nil
}
enum StudyConflictChoice { case local, remote, copy }
