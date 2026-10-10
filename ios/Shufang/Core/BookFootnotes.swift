import Foundation

/// Matches the EPUB parser: offsets refer to the unmodified paragraph in UTF-16.
struct BookFootnote: Codable, Equatable {
    let paraIndex: Int
    let start: Int
    let end: Int
    let content: String
}

struct ReaderFootnote: Identifiable {
    let id: String
    let range: NSRange
    let label: String
    let content: String

    static func visible(_ notes: [BookFootnote], segments: [StudyTextSegment]) -> [Self] {
        var result: [Self] = [], offset = 0
        for segment in segments {
            let text = segment.text as NSString
            var cursor = 0
            for note in notes.filter({ $0.paraIndex == segment.paragraph }).sorted(by: { $0.start < $1.start }) {
                guard note.start >= 0, note.end > note.start, !note.content.isEmpty else { continue }
                let start = max(0, note.start - segment.start)
                let end = min(text.length, note.end - segment.start)
                guard start >= cursor, end > start else { continue }
                let range = NSRange(location: start, length: end - start)
                result.append(Self(id: "\(segment.paragraph):\(note.start):\(note.end)",
                    range: NSRange(location: offset + start, length: range.length),
                    label: text.substring(with: range), content: note.content))
                cursor = end
            }
            offset += text.length + 1
        }
        return result
    }
}
