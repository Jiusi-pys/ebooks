import Foundation
import CoreGraphics

/// Convert host NSTextView selection offsets to shared UTF-16 source coordinates.
public enum TextSelection {
    public static func range(paragraphs: [String], anchor: [String: Any]?) -> NSRange? {
        guard let anchor, let index = anchor["paraIndex"] as? Int, paragraphs.indices.contains(index),
              let start = anchor["start"] as? Int, let end = anchor["end"] as? Int,
              start >= 0, end > start, end <= (paragraphs[index] as NSString).length else { return nil }
        let offset = paragraphs.prefix(index).reduce(0) { $0 + ($1 as NSString).length + 1 }
        return NSRange(location: offset+start, length: end-start)
    }

    public static func anchor(book: String, chapter: String, paragraphs: [String], range: NSRange) -> [String: Any]? {
        guard range.location != NSNotFound, range.length > 0 else { return nil }
        var offset = 0, ranges: [[String: Any]] = []
        for (index, paragraph) in paragraphs.enumerated() {
            let length = (paragraph as NSString).length
            let intersection = NSIntersectionRange(range, NSRange(location: offset, length: length))
            if intersection.length > 0 {
                let local = NSRange(location: intersection.location - offset, length: intersection.length)
                ranges.append(["kind": "text", "bookId": book, "chapterId": chapter, "paraIndex": index,
                               "start": local.location, "end": NSMaxRange(local),
                               "text": (paragraph as NSString).substring(with: local)])
            }
            offset += length + 1
        }
        guard var first = ranges.first else { return nil }
        if ranges.count > 1 {
            first["sourceRanges"] = ranges
            first["text"] = ranges.compactMap { $0["text"] as? String }.joined(separator: "\n")
        }
        return first
    }
}

/// PDFKit coordinate adapter: rotated crop box, normalized from top left.
public enum PDFCoordinates {
    public static func normalize(_ rect: CGRect, crop: CGRect, rotation: Int) -> [String: Double]? {
        guard crop.width > 0, crop.height > 0 else { return nil }
        let clipped = rect.intersection(crop)
        guard !clipped.isNull, clipped.width > 0, clipped.height > 0 else { return nil }
        let points = [CGPoint(x: clipped.minX, y: clipped.minY), CGPoint(x: clipped.maxX, y: clipped.minY),
                      CGPoint(x: clipped.minX, y: clipped.maxY), CGPoint(x: clipped.maxX, y: clipped.maxY)].map { point -> CGPoint in
            let u = (point.x - crop.minX) / crop.width, v = (crop.maxY - point.y) / crop.height
            switch (rotation % 360 + 360) % 360 {
            case 90: return CGPoint(x: 1-v, y: u)
            case 180: return CGPoint(x: 1-u, y: 1-v)
            case 270: return CGPoint(x: v, y: 1-u)
            default: return CGPoint(x: u, y: v)
            }
        }
        let xs = points.map(\.x), ys = points.map(\.y)
        return ["x": xs.min()!, "y": ys.min()!, "width": xs.max()!-xs.min()!, "height": ys.max()!-ys.min()!]
    }
    public static func pageRect(_ value: [String: Double], crop: CGRect, rotation: Int) -> CGRect? {
        guard let x = value["x"], let y = value["y"], let width = value["width"], let height = value["height"],
              [x, y, width, height].allSatisfy({ $0.isFinite && (0...1).contains($0) }),
              x+width <= 1.000001, y+height <= 1.000001 else { return nil }
        let points = [CGPoint(x: x, y: y), CGPoint(x: x+width, y: y), CGPoint(x: x, y: y+height), CGPoint(x: x+width, y: y+height)].map { p -> CGPoint in
            let uv: CGPoint
            switch (rotation % 360 + 360) % 360 {
            case 90: uv = CGPoint(x: p.y, y: 1-p.x)
            case 180: uv = CGPoint(x: 1-p.x, y: 1-p.y)
            case 270: uv = CGPoint(x: 1-p.y, y: p.x)
            default: uv = p
            }
            return CGPoint(x: crop.minX + uv.x*crop.width, y: crop.maxY-uv.y*crop.height)
        }
        let xs = points.map(\.x), ys = points.map(\.y)
        return CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()!-xs.min()!, height: ys.max()!-ys.min()!)
    }
}
