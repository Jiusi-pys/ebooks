import AppKit
import PDFKit
import SwiftUI
import ShufangMacCore

struct TextReader: NSViewRepresentable {
    let paragraphs: [String]
    let paragraph: Int
    let source: [String: Any]?
    let position: (Int) -> Void
    let selection: (NSRange) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        let text = scroll.documentView as! NSTextView
        text.isEditable = false; text.isSelectable = true
        text.font = NSFont.systemFont(ofSize: 18)
        text.textContainerInset = NSSize(width: 24, height: 24)
        text.delegate = context.coordinator
        text.autoresizingMask = [.width]
        text.textContainer?.widthTracksTextView = true
        scroll.contentView.postsBoundsChangedNotifications = true
        context.coordinator.observer = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: .main) { [weak coordinator = context.coordinator, weak text] _ in
            guard let coordinator, let text, !coordinator.updating, let layout = text.layoutManager, let container = text.textContainer else { return }
            let point = CGPoint(x: text.visibleRect.minX, y: text.visibleRect.minY + text.textContainerInset.height)
            let glyph = layout.glyphIndex(for: point, in: container)
            guard glyph < layout.numberOfGlyphs else { return }
            let offset = layout.characterIndexForGlyph(at: glyph)
            var start = 0, index = 0
            for (i, value) in coordinator.parent.paragraphs.enumerated() {
                if offset < start + (value as NSString).length + 1 { index = i; break }
                start += (value as NSString).length + 1; index = i
            }
            coordinator.lastParagraph = index
            coordinator.parent.position(index)
        }
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        let text = scroll.documentView as! NSTextView
        let value = paragraphs.joined(separator: "\n")
        let changed = text.string != value
        coordinator.updating = true
        defer { coordinator.updating = false }
        if changed {
            text.string = value
            let style = NSMutableParagraphStyle(); style.paragraphSpacing = 16; style.lineSpacing = 5
            text.textStorage?.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: (value as NSString).length))
        }
        if changed || coordinator.lastParagraph != paragraph {
            let index = min(max(0, paragraph), max(0, paragraphs.count-1))
            let offset = paragraphs.prefix(index).reduce(0) { $0 + ($1 as NSString).length + 1 }
            text.scrollRangeToVisible(NSRange(location: min(offset, (value as NSString).length), length: 0))
            coordinator.lastParagraph = paragraph
        }
        if let range = TextSelection.range(paragraphs: paragraphs, anchor: source), text.selectedRange() != range {
            text.setSelectedRange(range); text.scrollRangeToVisible(range)
        }
    }
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: TextReader
        var observer: NSObjectProtocol?
        var updating = false
        var lastParagraph = -1
        init(_ parent: TextReader) { self.parent = parent }
        deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
        func textViewDidChangeSelection(_ notification: Notification) {
            if !updating, let text = notification.object as? NSTextView { parent.selection(text.selectedRange()) }
        }
    }
}

struct PDFReader: NSViewRepresentable {
    let url: URL
    let index: Int
    let book: String
    let chapterIDs: [String]
    let highlights: [Record]
    let selection: ([String: Any]?) -> Void
    let page: (Int) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> PDFView {
        let view = PDFView(); view.autoScales = true; view.displayMode = .singlePageContinuous
        view.displayBox = .cropBox
        context.coordinator.attach(view)
        return view
    }
    func updateNSView(_ view: PDFView, context: Context) {
        context.coordinator.parent = self
        if view.document?.documentURL != url { view.document = PDFDocument(url: url) }
        if let document = view.document, let target = document.page(at: index), view.currentPage != target { view.go(to: target) }
        context.coordinator.annotations(view)
    }
    final class Coordinator: NSObject {
        var parent: PDFReader
        var observers: [NSObjectProtocol] = []
        private var rendered = ""
        init(_ parent: PDFReader) { self.parent = parent }
        deinit { observers.forEach(NotificationCenter.default.removeObserver) }
        func attach(_ view: PDFView) {
            observers.append(NotificationCenter.default.addObserver(forName: .PDFViewPageChanged, object: view, queue: .main) { [weak self, weak view] _ in
                guard let self, let view, let current = view.currentPage, let document = view.document else { return }
                self.parent.page(document.index(for: current))
            })
            observers.append(NotificationCenter.default.addObserver(forName: .PDFViewSelectionChanged, object: view, queue: .main) { [weak self, weak view] _ in
                guard let self, let view, let selected = view.currentSelection, !selected.pages.isEmpty, let document = view.document else { self?.parent.selection(nil); return }
                var ranges: [[String: Any]] = []
                for selectedPage in selected.pages {
                    let index = document.index(for: selectedPage), crop = selectedPage.bounds(for: .cropBox)
                    let lines = selected.selectionsByLine().filter { $0.pages.contains(selectedPage) }
                    let rects = lines.compactMap { PDFCoordinates.normalize($0.bounds(for: selectedPage), crop: crop, rotation: selectedPage.rotation) }
                    guard !rects.isEmpty, self.parent.chapterIDs.indices.contains(index) else { continue }
                    ranges.append(["kind": "pdf", "bookId": self.parent.book, "chapterId": self.parent.chapterIDs[index],
                                   "text": lines.compactMap(\.string).joined(separator: "\n"), "pdfAnchor": ["page": index+1, "rects": rects]])
                }
                guard var anchor = ranges.first else { self.parent.selection(nil); return }
                if ranges.count > 1 { anchor["sourceRanges"] = ranges; anchor["text"] = selected.string ?? "" }
                self.parent.selection(anchor)
            })
        }
        func annotations(_ view: PDFView) {
            guard let document = view.document else { return }
            let signature = parent.url.path + parent.highlights.map { "\($0.id):\($0.revision)" }.joined()
            guard signature != rendered else { return }; rendered = signature
            for i in 0..<document.pageCount {
                guard let page = document.page(at: i) else { continue }
                for annotation in page.annotations where annotation.userName == "Shufang" { page.removeAnnotation(annotation) }
            }
            for record in parent.highlights {
                guard let anchor = record.value["pdfAnchor"] as? [String: Any], let pageNumber = anchor["page"] as? Int,
                      let page = document.page(at: pageNumber-1), let rects = anchor["rects"] as? [[String: Double]] else { continue }
                for value in rects {
                    guard let rect = PDFCoordinates.pageRect(value, crop: page.bounds(for: .cropBox), rotation: page.rotation) else { continue }
                    let annotation = PDFAnnotation(bounds: rect, forType: .highlight, withProperties: nil)
                    annotation.userName = "Shufang"; annotation.color = .systemYellow.withAlphaComponent(0.35)
                    page.addAnnotation(annotation)
                }
            }
        }
    }
}
