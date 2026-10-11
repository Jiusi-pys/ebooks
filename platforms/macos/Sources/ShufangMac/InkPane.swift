import AppKit
import CryptoKit
import PDFKit
import PencilKit
import SwiftUI
import ShufangMacCore

struct InkPane: View {
    @ObservedObject var model: LibraryModel
    @Environment(\.dismiss) private var dismiss
    @State private var value: [String: Any] = [:]
    @State private var baseline: Record?
    @State private var error = ""
    @State private var background: NSImage?
    @State private var loaded = false
    @State private var savedValue: [String: Any] = [:]
    @State private var current: [[String: Any]] = []
    @State private var startTime = Date()
    private var strokes: [[String: Any]] { value["strokes"] as? [[String: Any]] ?? [] }
    private var height: Double { value["height"] as? Double ?? 1400 }
    private var noteID: String {
        let book = model.record?.id ?? ""
        let hash = SHA256.hash(data: Data(book.utf8)).map { String(format: "%02x", $0) }.joined()
        return "pdfink.\(hash).\(model.chapterIndex + 1)"
    }
    var body: some View {
        VStack {
            HStack {
                Text("第 \(model.chapterIndex + 1) 页手写").font(.headline)
                Spacer()
                Button("撤销笔画") { var items = strokes; if !items.isEmpty { items.removeLast(); value["strokes"] = items } }.disabled(strokes.isEmpty)
                Button("保存") { save() }.disabled(!loaded || model.busy)
                Button("关闭") {
                    if loaded && !NSDictionary(dictionary: value).isEqual(to: savedValue) {
                        let alert = NSAlert(); alert.messageText = "手写修改尚未保存"
                        alert.addButton(withTitle: "继续编辑"); alert.addButton(withTitle: "丢弃修改")
                        guard alert.runModal() == .alertSecondButtonReturn else { return }
                    }
                    dismiss()
                }
            }
            Text(error).font(.caption).foregroundStyle(.red)
            GeometryReader { geometry in
                ZStack {
                    Color.white
                    if let background { Image(nsImage: background).resizable().scaledToFit().opacity(0.5) }
                    Canvas { context, size in
                        for stroke in strokes + (current.isEmpty ? [] : [["points": current, "width": 2.5, "color": [0.1, 0.2, 0.7, 1.0]]]) {
                            guard let points = stroke["points"] as? [[String: Any]], let first = points.first,
                                  let x = first["x"] as? Double, let y = first["y"] as? Double else { continue }
                            var path = Path(); path.move(to: CGPoint(x: x/1000*size.width, y: y/height*size.height))
                            for point in points.dropFirst() {
                                if let x = point["x"] as? Double, let y = point["y"] as? Double { path.addLine(to: CGPoint(x: x/1000*size.width, y: y/height*size.height)) }
                            }
                            let rgba = stroke["color"] as? [Double] ?? [0, 0, 0, 1]
                            guard rgba.count == 4 else { continue }
                            if points.count == 1 { path.addEllipse(in: CGRect(x: x/1000*size.width-1, y: y/height*size.height-1, width: 2, height: 2)) }
                            context.stroke(path, with: .color(Color(red: rgba[0], green: rgba[1], blue: rgba[2], opacity: rgba[3])), lineWidth: (stroke["width"] as? Double ?? 2.5)/1000*size.width)
                        }
                    }
                }.contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0).onChanged { event in
                    guard loaded else { return }
                    if current.isEmpty { startTime = Date() }
                    guard current.count < 100_000 else { return }
                    current.append(["x": Double(min(1000, max(0, event.location.x/geometry.size.width*1000))),
                                    "y": Double(min(height, max(0, event.location.y/geometry.size.height*height))),
                                    "pressure": 0.5, "tilt": 0.0, "azimuth": 0.0, "time": Date().timeIntervalSince(startTime)])
                }.onEnded { _ in
                    guard !current.isEmpty else { return }
                    var items = strokes
                    items.append(["id": UUID().uuidString.lowercased(), "tool": "pen", "color": [0.1, 0.2, 0.7, 1.0], "width": 2.5, "points": current])
                    value["strokes"] = items; current = []
                })
            }.aspectRatio(1000/height, contentMode: .fit)
        }.padding().background(InkWindowTitle()).task { await load() }
    }
    func load() async {
        guard let workspace = model.workspace, let url = model.pdfURL,
              let document = PDFDocument(url: url), let page = document.page(at: model.chapterIndex) else { return }
        let box = page.bounds(for: .cropBox)
        do {
            value = try PortableInk.empty(pageSize: box.size, rotation: page.rotation)
        } catch { self.error = LibraryModel.message(error); return }
        let pageHeight = value["height"] as! Double
        background = page.thumbnail(of: CGSize(width: 1000, height: pageHeight), for: .cropBox)
        do {
            if model.notes.contains(where: { $0.id == noteID }) { baseline = try await workspace.get("notes", noteID) }
            if let reference = baseline?.value["pdfPortableInk"] {
                let resource = try await workspace.call("attachmentResource", ["reference": reference]) as? [String: Any] ?? [:]
                guard let path = resource["path"] as? String else { throw CoreError.rejected("手写附件不可用") }
                let data = try Data(contentsOf: URL(fileURLWithPath: path))
                value = try PortableInk.decode(data)
            } else if let reference = baseline?.value["pdfDrawing"] {
                let resource = try await workspace.call("attachmentResource", ["reference": reference]) as? [String: Any] ?? [:]
                guard let path = resource["path"] as? String else { throw CoreError.rejected("历史手写附件不可用") }
                let drawing = try PKDrawing(data: Data(contentsOf: URL(fileURLWithPath: path)))
                var items: [[String: Any]] = []
                for stroke in drawing.strokes {
                    for range in stroke.maskedPathRanges {
                        let samples = Array(stroke.path.interpolatedPoints(in: range, by: .distance(1)))
                        let points: [[String: Any]] = samples.map { point in
                            let location = point.location.applying(stroke.transform)
                            return ["x": Double(min(1000, max(0, location.x))), "y": Double(min(pageHeight, max(0, location.y))),
                                    "pressure": Double(min(1, max(0, point.force))), "tilt": Double.pi/2-point.altitude,
                                    "azimuth": point.azimuth, "time": point.timeOffset]
                        }
                        let color = stroke.ink.color.usingColorSpace(.deviceRGB) ?? .black
                        items.append(["id": UUID().uuidString.lowercased(), "tool": stroke.ink.inkType == .pencil ? "pencil" : stroke.ink.inkType == .marker ? "marker" : "pen",
                                      "color": [Double(color.redComponent), Double(color.greenComponent), Double(color.blueComponent), Double(color.alphaComponent)],
                                      "width": Double(min(100, max(0.1, samples.first?.size.width ?? 1))), "points": points])
                    }
                }
                value["strokes"] = items
            }
            try PortableInk.validate(value)
            savedValue = value; loaded = true
        } catch { self.error = LibraryModel.message(error) }
    }
    func save() {
        guard let workspace = model.workspace, let root = model.root, let book = model.record else { return }
        let snapshot = value, id = noteID, page = model.chapterIndex+1, expected = baseline?.revision ?? 0
        model.start("保存手写") {
            let temporary = root.appendingPathComponent("ink-\(UUID().uuidString).json")
            defer { try? FileManager.default.removeItem(at: temporary) }
            try PortableInk.validate(snapshot)
            try JSONSerialization.data(withJSONObject: snapshot).write(to: temporary, options: .atomic)
            let reference = try await workspace.call("putAttachment", ["path": temporary.path, "name": "drawing.ink.json", "type": "application/vnd.shufang.ink+json"])
            baseline = try await workspace.save("notes", id: id, revision: expected,
                patch: ["title": "第 \(page) 页手写", "content": "", "bookId": book.id, "pdfPage": page, "pdfPortableInk": reference])
            savedValue = snapshot
            try await model.refresh()
        }
    }
}

// Give the native sheet a title for window navigation and accessibility tools.
private struct InkWindowTitle: NSViewRepresentable {
    final class TitleView: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            window?.title = "PDF 手写"
        }
    }
    func makeNSView(context: Context) -> NSView { TitleView() }
    func updateNSView(_ view: NSView, context: Context) { view.window?.title = "PDF 手写" }
}
