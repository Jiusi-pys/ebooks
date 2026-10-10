#if canImport(UIKit) && canImport(PencilKit)
import UIKit
import PencilKit
import CryptoKit

extension PortableInk {
    init(drawing: PKDrawing, height: Double, previous: PortableInk? = nil, fingerprintOnly: Bool = false) throws {
        self.init(height: height, strokes: [])
        for stroke in drawing.strokes {
            let ranges = stroke.maskedPathRanges
            for range in ranges {
                let samples = Array(stroke.path.interpolatedPoints(in: range, by: .distance(1)))
                guard !samples.isEmpty else { continue }
                let points = samples.map { point -> Point in
                    let location = point.location.applying(stroke.transform)
                    return Point(x: min(1000, max(0, Double(location.x))), y: min(height, max(0, Double(location.y))),
                        pressure: min(1, max(0, Double(point.force))), tilt: Double.pi / 2 - Double(point.altitude),
                        azimuth: Double(point.azimuth), time: point.timeOffset)
                }
                var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 1
                stroke.ink.color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
                let color = [Double(red), Double(green), Double(blue), Double(alpha)]
                let tool = stroke.ink.inkType == .pencil ? "pencil" : stroke.ink.inkType == .marker ? "marker" : "pen"
                let width = min(100, max(0.1, Double(samples[0].size.width)))
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.sortedKeys]
                let body = try encoder.encode(points)
                let identity = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
                strokes.append(Stroke(id: identity, tool: tool, color: color, width: width, points: points))
            }
        }
        if let previous {
            let canonical = try PortableInk(drawing: previous.pencilDrawing(), height: height, fingerprintOnly: true)
            var available = Dictionary(grouping: Array(zip(canonical.strokes, previous.strokes)), by: { $0.0.id })
            for index in strokes.indices {
                let fingerprint = strokes[index].id
                if var candidates = available[fingerprint], !candidates.isEmpty {
                    strokes[index] = candidates.removeFirst().1
                    available[fingerprint] = candidates
                } else { strokes[index].id = UUID().uuidString.lowercased() }
            }
        } else if !fingerprintOnly {
            for index in strokes.indices { strokes[index].id = UUID().uuidString.lowercased() }
        }
        if !fingerprintOnly { _ = try validated() }
    }
    func pencilDrawing() throws -> PKDrawing {
        _ = try validated()
        return PKDrawing(strokes: strokes.map { stroke in
            let type: PKInk.InkType = stroke.tool == "pencil" ? .pencil : stroke.tool == "marker" ? .marker : .pen
            let color = UIColor(red: CGFloat(stroke.color[0]), green: CGFloat(stroke.color[1]), blue: CGFloat(stroke.color[2]), alpha: CGFloat(stroke.color[3]))
            let points = stroke.points.map { point in
                PKStrokePoint(location: CGPoint(x: CGFloat(point.x), y: CGFloat(point.y)), timeOffset: point.time,
                    size: CGSize(width: CGFloat(stroke.width), height: CGFloat(stroke.width)), opacity: 1,
                    force: CGFloat(point.pressure), azimuth: CGFloat(point.azimuth),
                    altitude: CGFloat(Double.pi / 2 - point.tilt))
            }
            return PKStroke(ink: PKInk(type, color: color), path: PKStrokePath(controlPoints: points, creationDate: Date(timeIntervalSince1970: 0)))
        })
    }
}
#endif
