import Foundation
import CoreGraphics

/// Validate the platform drawing interchange format without rebuilding its JSON.
/// Unknown extension fields and existing stroke identifiers remain untouched.
public enum PortableInk {
    public static func empty(pageSize: CGSize, rotation: Int) throws -> [String: Any] {
        let rotated = abs(rotation % 180) == 90
        let width = Double(rotated ? pageSize.height : pageSize.width)
        let height = Double(rotated ? pageSize.width : pageSize.height)
        guard width.isFinite, height.isFinite, width > 0, height > 0 else { throw CoreError.rejected("invalid_portable_ink") }
        let value: [String: Any] = ["format": "ShufangPortableInk", "version": 1, "width": 1000.0, "height": height/width*1000, "strokes": [[String: Any]]()]
        try validate(value)
        return value
    }
    private static func number(_ value: Any?) -> Double? {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
        return value.doubleValue
    }

    public static func decode(_ data: Data) throws -> [String: Any] {
        guard data.count <= 32*1024*1024,
              let ink = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw CoreError.rejected("invalid_portable_ink") }
        try validate(ink)
        return ink
    }
    public static func validate(_ ink: [String: Any]) throws {
        func invalid() -> CoreError { .rejected("invalid_portable_ink") }
        guard ink["format"] as? String == "ShufangPortableInk", ink["version"] as? Int == 1,
              number(ink["width"]) == 1000, let height = number(ink["height"]),
              height.isFinite, height > 0, height <= 100_000,
              let strokes = ink["strokes"] as? [[String: Any]], strokes.count <= 10_000 else { throw invalid() }
        var ids = Set<String>(), total = 0
        for stroke in strokes {
            guard let id = stroke["id"] as? String, !id.isEmpty, id.count <= 128, ids.insert(id).inserted,
                  let tool = stroke["tool"] as? String, ["pen", "pencil", "marker"].contains(tool),
                  let width = number(stroke["width"]), width.isFinite, width > 0, width <= 100,
                  let color = stroke["color"] as? [Double], color.count == 4,
                  color.allSatisfy({ $0.isFinite && (0...1).contains($0) }),
                  let points = stroke["points"] as? [[String: Any]], !points.isEmpty else { throw invalid() }
            total += points.count
            guard total <= 1_000_000 else { throw invalid() }
            var previous = 0.0
            for point in points {
                guard let x = number(point["x"]), let y = number(point["y"]),
                      let pressure = number(point["pressure"]), let tilt = number(point["tilt"]),
                      let azimuth = number(point["azimuth"]), let time = number(point["time"]),
                      [x,y,pressure,tilt,azimuth,time].allSatisfy(\.isFinite),
                      (0...1000).contains(x), (0...height).contains(y), (0...1).contains(pressure),
                      time >= previous else { throw invalid() }
                previous = time
            }
        }
    }
}
