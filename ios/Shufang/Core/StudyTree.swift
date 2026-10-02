import Foundation

enum StudyTree {
    static func title(_ node: StudyMindNode, cards: [StudyCard]) -> String {
        guard let id = node.sourceHighlightId, let card = cards.first(where: { $0.id == id }) else { return node.text }
        return card.name?.isEmpty == false ? card.name! : card.text
    }
    static func nodes(_ node: StudyMindNode) -> [StudyMindNode] { [node] + node.children.flatMap(nodes) }
    static func update(_ root: StudyMindNode, id: String, apply: (inout StudyMindNode) -> Void) -> StudyMindNode {
        var result = root
        if root.id == id { apply(&result) }
        else { result.children = root.children.map { update($0, id: id, apply: apply) } }
        return result
    }
    static func removing(_ root: StudyMindNode, id: String) -> StudyMindNode {
        var result = root
        result.children = root.children.filter { $0.id != id }.map { removing($0, id: id) }
        return result
    }
    static func moved(_ root: StudyMindNode, id: String, parent: String) -> StudyMindNode? {
        guard id != root.id, let node = nodes(root).first(where: { $0.id == id }),
              !nodes(node).contains(where: { $0.id == parent }), nodes(root).contains(where: { $0.id == parent }) else { return nil }
        return update(removing(root, id: id), id: parent) { $0.children.append(node); $0.collapsed = false }
    }
    static func reorder(_ root: StudyMindNode, id: String, delta: Int) -> StudyMindNode {
        var result = root
        if let index = root.children.firstIndex(where: { $0.id == id }) {
            let target = index + delta
            if root.children.indices.contains(target) { result.children.swapAt(index, target) }
        } else { result.children = root.children.map { reorder($0, id: id, delta: delta) } }
        return result
    }
}


/// Keeps relation identity byte-for-byte compatible with app/src/lib/associations.ts.
/// Display titles and excerpt text are snapshots, so they do not enter the key.
enum StudyAnchors {
    private static let componentCharacters = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
    static func isPrecise(_ source: StudySource) -> Bool {
        guard !source.bookId.isEmpty, !source.chapterId.isEmpty, !source.text.isEmpty else { return false }
        if source.kind == "pdf" {
            guard let pdf = source.pdfAnchor, pdf.page > 0, !pdf.rects.isEmpty, pdf.rects.count <= 256 else { return false }
            return pdf.rects.allSatisfy { rect in
                [rect.x, rect.y, rect.width, rect.height].allSatisfy(\.isFinite) &&
                rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 &&
                rect.x + rect.width <= 1.000001 && rect.y + rect.height <= 1.000001
            }
        }
        guard source.kind == "text", let paragraph = source.paraIndex, let start = source.start, let end = source.end else { return false }
        return paragraph >= 0 && start >= 0 && end > start && end <= 20_000_000
    }
    static func key(_ source: StudySource) -> String? {
        let identity: [Any]
        if source.kind == "pdf", let pdf = source.pdfAnchor {
            let tuples = pdf.rects.map { rect in
                [rect.x, rect.y, rect.width, rect.height].map { floor($0 * 1_000_000 + 0.5) / 1_000_000 }
            }.sorted { left, right in
                for index in left.indices where left[index] != right[index] { return left[index] < right[index] }
                return false
            }
            identity = ["pdf", source.bookId, pdf.page, tuples]
        } else if source.kind == "text", let paragraph = source.paraIndex, let start = source.start, let end = source.end {
            identity = ["text", source.bookId, source.chapterId, paragraph, start, end]
        } else { return nil }
        guard let encoded = encode(identity) else { return nil }
        return source.kind + ":" + encoded
    }
    static func pairKey(_ source: StudySource, _ target: StudySource, bidirectional: Bool) -> String? {
        guard isPrecise(source), isPrecise(target), let first = key(source), let second = key(target), first != second else { return nil }
        let keys = bidirectional ? [first, second].sorted() : [first, second]
        guard let encoded = encode(keys) else { return nil }
        return (bidirectional ? "bidirectional:" : "source-to-target:") + encoded
    }
    private static func encode(_ array: [Any]) -> String? {
        guard JSONSerialization.isValidJSONObject(array),
              let data = try? JSONSerialization.data(withJSONObject: array, options: [.withoutEscapingSlashes]),
              let json = String(data: data, encoding: .utf8) else { return nil }
        return json.addingPercentEncoding(withAllowedCharacters: componentCharacters)
    }
}
