import Foundation

/// Version 2 keeps a stable local storage anchor while network routes can change.
/// Old origin-scoped files are deliberately retained, not merged or moved.
struct AccountRoutes: Codable, Equatable {
    var version = 2
    var anchorAddress: String
    var userID: String
    var workspaceID: String
    var addresses: [String]
    var manualAddress: String?

    func accepts(userID: String, workspaceID: String) -> Bool {
        self.userID == userID && self.workspaceID == workspaceID && !workspaceID.isEmpty
    }
}

struct RouteMeasurement: Equatable {
    var address: String
    var milliseconds: Double?
    var message: String?
}

enum RouteSelection {
    /// A 20% / 30 ms margin avoids switching repeatedly for ordinary jitter.
    static func best(_ measurements: [RouteMeasurement], current: String?, manual: String?) -> String? {
        let available = measurements.filter { ($0.milliseconds ?? -1) >= 0 }
        if let manual { return available.first { $0.address == manual }?.address }
        guard let fastest = available.min(by: { $0.milliseconds! < $1.milliseconds! }) else { return nil }
        if let existing = available.first(where: { $0.address == current }),
           existing.milliseconds! - fastest.milliseconds! < max(30, existing.milliseconds! * 0.2) {
            return existing.address
        }
        return fastest.address
    }
}
