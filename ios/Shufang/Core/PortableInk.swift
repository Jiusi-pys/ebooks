import Foundation

struct PortableInk: Codable, Equatable {
    var format = "ShufangPortableInk"
    var version = 1
    var width = 1000.0
    var height: Double
    var strokes: [Stroke]
    struct Point: Codable, Equatable {
        var x: Double; var y: Double; var pressure: Double; var tilt: Double
        var azimuth: Double; var time: Double
    }
    struct Stroke: Codable, Equatable {
        var id: String; var tool: String; var color: [Double]; var width: Double
        var points: [Point]
    }
    func validated() throws -> Self {
        guard format == "ShufangPortableInk", version == 1, width == 1000,
            height.isFinite, height > 0, height <= 100_000, strokes.count <= 10_000,
            Set(strokes.map(\.id)).count == strokes.count else { throw PortableInkError.invalid }
        var total = 0
        for stroke in strokes {
            guard !stroke.id.isEmpty, stroke.id.count <= 128,
                ["pen", "pencil", "marker"].contains(stroke.tool), stroke.color.count == 4,
                stroke.color.allSatisfy({ $0.isFinite && (0...1).contains($0) }),
                stroke.width.isFinite, stroke.width > 0, stroke.width <= 100,
                !stroke.points.isEmpty else { throw PortableInkError.invalid }
            total += stroke.points.count
            guard total <= 1_000_000 else { throw PortableInkError.invalid }
            var previous = -1.0
            for point in stroke.points {
                guard [point.x, point.y, point.pressure, point.tilt, point.azimuth, point.time].allSatisfy(\.isFinite),
                    (0...width).contains(point.x), (0...height).contains(point.y),
                    (0...1).contains(point.pressure), point.time >= 0, point.time >= previous else { throw PortableInkError.invalid }
                previous = point.time
            }
        }
        return self
    }
}
enum PortableInkError: Error { case invalid, unsupportedMask }
