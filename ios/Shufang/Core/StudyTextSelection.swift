import Foundation

struct StudyTextSegment {
    var paragraph: Int
    var start: Int
    var text: String
}
enum StudyTextSelection {
    static func sources(segments: [StudyTextSegment], range: NSRange, bookId: String,
                        chapterId: String, chapterTitle: String) -> [StudySource] {
        var offset = 0
        return segments.compactMap { segment in
            defer { offset += segment.text.utf16.count + 1 }
            let intersection = NSIntersectionRange(range, NSRange(location: offset, length: segment.text.utf16.count))
            guard intersection.length > 0 else { return nil }
            let relative = NSRange(location: intersection.location - offset, length: intersection.length)
            let text = (segment.text as NSString).substring(with: relative)
            return StudySource(bookId: bookId, chapterId: chapterId, chapterTitle: chapterTitle,
                text: text, paraIndex: segment.paragraph, start: segment.start + relative.location,
                end: segment.start + NSMaxRange(relative))
        }
    }
    static func range(source: StudySource, segments: [StudyTextSegment]) -> NSRange? {
        var offset = 0
        for segment in segments {
            defer { offset += segment.text.utf16.count + 1 }
            guard segment.paragraph == source.paraIndex else { continue }
            let start = source.start ?? 0, end = source.end ?? start + source.text.utf16.count
            let intersection = NSIntersectionRange(NSRange(location: start, length: max(0, end - start)),
                NSRange(location: segment.start, length: segment.text.utf16.count))
            if intersection.length > 0 { return NSRange(location: offset + intersection.location - segment.start, length: intersection.length) }
        }
        return nil
    }
}
