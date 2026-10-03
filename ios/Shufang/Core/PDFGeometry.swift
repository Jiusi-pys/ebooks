import CoreGraphics
import Foundation

/// Shared with the web reader: page is one-based; rectangles use the rotated
/// crop box, normalized to 0...1 from its top-left corner.
typealias PDFNormalizedRect = StudyPDFRect
typealias PDFSourceAnchor = StudyPDFAnchor

extension StudyPDFRect {
    var sanitized: PDFNormalizedRect? {
        guard [x, y, width, height].allSatisfy(\.isFinite), width > 0, height > 0 else { return nil }
        let left = max(0, min(1, x)), top = max(0, min(1, y))
        let right = max(left, min(1, x + width)), bottom = max(top, min(1, y + height))
        guard right > left, bottom > top else { return nil }
        return .init(x: left, y: top, width: right - left, height: bottom - top)
    }
}


enum PDFGeometry {
    static func normalize(_ rect: CGRect, cropBox: CGRect, rotation: Int) -> PDFNormalizedRect? {
        guard cropBox.width > 0, cropBox.height > 0,
              [cropBox.minX, cropBox.minY, cropBox.width, cropBox.height,
               rect.minX, rect.minY, rect.width, rect.height].allSatisfy(\.isFinite) else { return nil }
        let clipped = rect.intersection(cropBox)
        guard !clipped.isNull, clipped.width > 0, clipped.height > 0 else { return nil }
        let corners = points(clipped).map { p -> CGPoint in
            let u = (p.x - cropBox.minX) / cropBox.width
            let v = (cropBox.maxY - p.y) / cropBox.height
            switch ((rotation % 360) + 360) % 360 {
            case 90: return CGPoint(x: 1 - v, y: u)
            case 180: return CGPoint(x: 1 - u, y: 1 - v)
            case 270: return CGPoint(x: v, y: 1 - u)
            default: return CGPoint(x: u, y: v)
            }
        }
        let box = bounding(corners)
        return PDFNormalizedRect(x: box.minX, y: box.minY, width: box.width, height: box.height).sanitized
    }

    static func pageRect(_ rect: PDFNormalizedRect, cropBox: CGRect, rotation: Int) -> CGRect? {
        guard let safe = rect.sanitized, cropBox.width > 0, cropBox.height > 0 else { return nil }
        let corners = points(CGRect(x: safe.x, y: safe.y, width: safe.width, height: safe.height)).map { p -> CGPoint in
            let uv: CGPoint
            switch ((rotation % 360) + 360) % 360 {
            case 90: uv = CGPoint(x: p.y, y: 1 - p.x)
            case 180: uv = CGPoint(x: 1 - p.x, y: 1 - p.y)
            case 270: uv = CGPoint(x: 1 - p.y, y: p.x)
            default: uv = p
            }
            return CGPoint(x: cropBox.minX + uv.x * cropBox.width,
                           y: cropBox.maxY - uv.y * cropBox.height)
        }
        return bounding(corners)
    }

    private static func points(_ rect: CGRect) -> [CGPoint] {
        [CGPoint(x: rect.minX, y: rect.minY), CGPoint(x: rect.maxX, y: rect.minY),
         CGPoint(x: rect.minX, y: rect.maxY), CGPoint(x: rect.maxX, y: rect.maxY)]
    }
    private static func bounding(_ points: [CGPoint]) -> CGRect {
        let xs = points.map(\.x), ys = points.map(\.y)
        return CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!)
    }
}
