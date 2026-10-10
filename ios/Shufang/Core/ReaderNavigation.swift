import Foundation

enum ReaderFlow: String, Codable, CaseIterable {
    case horizontal, vertical, scroll
    var title: String {
        switch self { case .horizontal: return "左右分页"; case .vertical: return "上下分页"; case .scroll: return "上下滚动" }
    }
    func turn(horizontal: Double, vertical: Double) -> Int? {
        guard self != .scroll else { return nil }
        let primary = self == .horizontal ? horizontal : vertical
        let secondary = self == .horizontal ? vertical : horizontal
        guard abs(primary) > 65, abs(primary) > abs(secondary) * 1.2 else { return nil }
        return primary < 0 ? 1 : -1
    }
}
enum ReaderTurnEffect: String, Codable, CaseIterable {
    case slide, fade, none
    var title: String {
        switch self { case .slide: return "平移"; case .fade: return "淡入淡出"; case .none: return "无动画" }
    }
}
