import SwiftUI
import PDFKit
import PencilKit
import Vision

@MainActor final class PDFStudyController: NSObject, ObservableObject, @preconcurrency PDFDocumentDelegate, @preconcurrency PDFPageOverlayViewProvider, PKCanvasViewDelegate {
    let pdfView = PDFView()
    @Published var document: PDFDocument?
    @Published var loading = false
    @Published var error: String?
    @Published var currentPage = 1
    @Published var scrollPosition = 0.0
    private var scrollObservation: NSKeyValueObservation?
    @Published var pageCount = 0
    @Published var hasSelection = false
    @Published var searching = false
    @Published var didSearch = false
    @Published var searchResults: [PDFSelection] = []
    @Published var drawingEnabled = false { didSet { updateTools() } }
    @Published var eraser = false { didSet { updateTools() } }
    @Published var regionMode = false
    @Published var recognizing = false
    @Published var ocrText = ""
    @Published var ocrPage = 1
    var onRegion: ((PDFExcerptDraft) -> Void)?
    var onCardSelected: ((String) -> Void)?
    private var observations: [NSObjectProtocol] = []
    private var positionKey = ""
    private var loadDrawing: (Int) -> Data? = { _ in nil }
    private var saveDrawing: (Int, Data, Data?) throws -> Void = { _, _, _ in }
    private var overlays: [Int: PDFInkOverlay] = [:]
    private var dirtyPages = Set<Int>()
    private var saveTasks: [Int: Task<Void, Never>] = [:]
    private var originalBytes: Data?
    private var restoring = false
    private var lastCards: [StudyCard] = []

    @Published var readingLayout = UserDefaults.standard.string(forKey: "pdf.readingLayout") ?? "vertical"
    func setReadingLayout(_ value: String) {
        guard ["vertical", "horizontal", "spread"].contains(value) else { return }
        let destination = pdfView.currentDestination
        flushDrawings()
        readingLayout = value
        UserDefaults.standard.set(value, forKey: "pdf.readingLayout")
        pdfView.displayMode = value == "spread" ? .twoUpContinuous : .singlePageContinuous
        pdfView.displayDirection = value == "horizontal" ? .horizontal : .vertical
        if let destination { pdfView.go(to: destination) }
    }
    override init() {
        super.init()
        pdfView.autoScales = true
        pdfView.displayMode = .singlePageContinuous
        pdfView.displayDirection = .vertical
        setReadingLayout(readingLayout)
        pdfView.displayBox = .cropBox
        pdfView.backgroundColor = .secondarySystemBackground
        pdfView.pageOverlayViewProvider = self
        observations.append(NotificationCenter.default.addObserver(forName: .PDFViewAnnotationHit,
            object: pdfView, queue: .main) { [weak self] note in
                MainActor.assumeIsolated {
                    guard let annotation = note.userInfo?.values.compactMap({ $0 as? PDFAnnotation }).first,
                          annotation.userName == "ShufangCard",
                          let id = annotation.value(forAnnotationKey: .name) as? String else { return }
                    self?.onCardSelected?(id)
                }
            })
        observe(.PDFViewPageChanged) { [weak self] in self?.pageChanged() }
        observe(.PDFViewSelectionChanged) { [weak self] in self?.hasSelection = !(self?.pdfView.currentSelection?.string?.isEmpty ?? true) }
        observations.append(NotificationCenter.default.addObserver(forName: .PDFDocumentDidEndFind,
            object: nil, queue: .main) { [weak self] note in
                MainActor.assumeIsolated {
                    guard let self, note.object as? PDFDocument === self.document else { return }
                    self.searching = false
                }
            })
    }
    deinit { observations.forEach(NotificationCenter.default.removeObserver) }

    private func observe(_ name: Notification.Name, action: @escaping @MainActor () -> Void) {
        observations.append(NotificationCenter.default.addObserver(forName: name, object: pdfView, queue: .main) { _ in
            MainActor.assumeIsolated { action() }
        })
    }
    func configure(positionKey: String, loadDrawing: @escaping (Int) -> Data?,
                   saveDrawing: @escaping (Int, Data, Data?) throws -> Void) {
        if self.positionKey != positionKey {
            persistPosition(); flushDrawings()
            overlays = [:]; dirtyPages = []; lastCards = []
            document = nil; pdfView.document = nil; originalBytes = nil
            searchResults = []; currentPage = 1; pageCount = 0
        }
        self.positionKey = positionKey
        self.loadDrawing = loadDrawing
        self.saveDrawing = saveDrawing
    }
    func load(bytes: Data?, client: APIClient, book: Book) async {
        guard !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do {
            let data: Data
            if let bytes { data = bytes }
            else { data = try await client.data(["books", book.id, "source"], timeout: 120) }
            try Task.checkCancellation()
            guard let pdf = PDFDocument(data: data), pdf.pageCount > 0, !pdf.isLocked else { throw PDFStudyError.invalidDocument }
            originalBytes = data
            document = pdf; pageCount = pdf.pageCount
            pdf.delegate = self; pdfView.document = pdf
            let saved = UserDefaults.standard.dictionary(forKey: positionKey)
            let page = saved?["page"] as? Int ?? 1
            go(page: page)
            if let x = saved?["x"] as? Double, let y = saved?["y"] as? Double,
               let target = pdf.page(at: max(0, min(pdf.pageCount - 1, page - 1))) {
                pdfView.go(to: PDFDestination(page: target, at: CGPoint(x: x, y: y)))
            }
            pageChanged()
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
    private func pageChanged() {
        guard let document, let page = pdfView.currentPage else { return }
        currentPage = document.index(for: page) + 1
        persistPosition()
    }
    func persistPosition() {
        guard !positionKey.isEmpty, let document, let page = pdfView.currentPage else { return }
        let visibleTop = CGPoint(x: pdfView.bounds.midX, y: pdfView.bounds.minY + 16)
        let point = pdfView.convert(visibleTop, to: page)
        UserDefaults.standard.set(["page": document.index(for: page) + 1, "x": point.x, "y": point.y], forKey: positionKey)
    }
    func trackScrollView() {
        guard scrollObservation == nil else { return }
        func locate(_ view: UIView) -> UIScrollView? {
            if let scroll = view as? UIScrollView { return scroll }
            return view.subviews.lazy.compactMap(locate).first
        }
        guard let scroll = locate(pdfView) else { return }
        scrollObservation = scroll.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.scrolled() }
        }
    }
    private func scrolled() {
        guard let document, let page = pdfView.page(for: CGPoint(x: pdfView.bounds.midX, y: 1), nearest: true) else { return }
        let rect = pdfView.convert(page.bounds(for: .cropBox), from: page)
        guard rect.height > 0 else { return }
        let fraction = max(0, min(0.9999, -rect.minY / rect.height))
        let position = Double(document.index(for: page)) + fraction
        if abs(position - scrollPosition) > 0.002 { scrollPosition = position }
    }
    func go(scrollPosition position: Double) {
        guard let document else { return }
        let safe = max(0, min(Double(document.pageCount) - 0.0001, position))
        let index = Int(safe), fraction = safe - Double(index)
        guard let page = document.page(at: index),
              let rect = PDFGeometry.pageRect(.init(x: 0, y: fraction, width: 0.001, height: 0.0001),
                cropBox: page.bounds(for: .cropBox), rotation: page.rotation) else { return }
        pdfView.go(to: PDFDestination(page: page, at: CGPoint(x: rect.minX, y: rect.maxY)))
    }
    func previousPage() { go(page: currentPage - 1) }
    func nextPage() { go(page: currentPage + 1) }
    func go(page number: Int) {
        guard let document, let page = document.page(at: max(0, min(document.pageCount - 1, number - 1))) else { return }
        pdfView.go(to: page)
        currentPage = document.index(for: page) + 1
    }
    func go(to anchor: StudyPDFAnchor) {
        guard let page = document?.page(at: anchor.page - 1) else { return }
        pdfView.go(to: page)
        if let first = anchor.rects.first,
           let rect = PDFGeometry.pageRect(first, cropBox: page.bounds(for: .cropBox), rotation: page.rotation) {
            pdfView.go(to: rect.insetBy(dx: -24, dy: -24), on: page)
        }
        currentPage = anchor.page
    }
    func search(_ text: String) {
        document?.cancelFindString()
        searchResults = []; didSearch = true
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { searching = false; return }
        searching = true
        document?.beginFindString(clean, withOptions: [.caseInsensitive, .diacriticInsensitive])
    }
    func didMatchString(_ instance: PDFSelection) {
        // Avoid unbounded UI work for a common character in a very large document.
        if searchResults.count < 300 { searchResults.append(instance) }
    }
    func selectSearchResult(_ index: Int) {
        guard searchResults.indices.contains(index) else { return }
        let selection = searchResults[index]
        pdfView.setCurrentSelection(selection, animate: true)
        pdfView.go(to: selection)
    }
    func pageNumber(_ selection: PDFSelection) -> Int {
        guard let page = selection.pages.first, let document else { return 1 }
        return document.index(for: page) + 1
    }
    func selectedExcerpt() -> PDFExcerptDraft? {
        guard let selection = pdfView.currentSelection, let document else { return nil }
        let allLines = selection.selectionsByLine()
        let segments = selection.pages.compactMap { page -> PDFExcerptSegment? in
            let lines = allLines.filter { $0.pages.contains(page) }
            let rects = lines.prefix(256).compactMap { PDFGeometry.normalize($0.bounds(for: page), cropBox: page.bounds(for: .cropBox), rotation: page.rotation) }
            guard !rects.isEmpty else { return nil }
            let text = lines.prefix(256).compactMap(\.string).joined(separator: "\n")
            return PDFExcerptSegment(text: text, anchor: .init(page: document.index(for: page) + 1, rects: rects))
        }
        guard let first = segments.first else { return nil }
        return PDFExcerptDraft(text: first.text, anchor: first.anchor, additionalPages: Array(segments.dropFirst()))
    }
    func captureRegion(viewRect: CGRect) {
        guard let document, let page = pdfView.page(for: CGPoint(x: viewRect.midX, y: viewRect.midY), nearest: false) else {
            error = "请在同一张 PDF 页面内框选，避免跨越页间空白。"; return
        }
        let pageRect = pdfView.convert(viewRect, to: page).intersection(page.bounds(for: .cropBox))
        guard let rect = PDFGeometry.normalize(pageRect, cropBox: page.bounds(for: .cropBox), rotation: page.rotation) else {
            error = "框选区域不在当前页面内，请重新选择。"; return
        }
        error = nil
        let selected = page.selection(for: pageRect)?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = selected?.isEmpty == false ? selected! : "区域摘录 · 第 \(document.index(for: page) + 1) 页"
        let pageImage = page.thumbnail(of: CGSize(width: 1400, height: 1800), for: .cropBox)
        var preview: UIImage?
        if let cg = pageImage.cgImage {
            let imageRect = CGRect(x: rect.x * Double(cg.width), y: rect.y * Double(cg.height),
                width: rect.width * Double(cg.width), height: rect.height * Double(cg.height)).integral
            if let cropped = cg.cropping(to: imageRect) { preview = UIImage(cgImage: cropped) }
        }
        regionMode = false
        onRegion?(PDFExcerptDraft(text: text, anchor: .init(page: document.index(for: page) + 1, rects: [rect]), isRegion: true, preview: preview))
    }
    func render(cards: [StudyCard]) {
        guard cards != lastCards, let document else { return }
        lastCards = cards
        for i in 0..<document.pageCount {
            guard let page = document.page(at: i) else { continue }
            for annotation in page.annotations where annotation.userName == "ShufangCard" { page.removeAnnotation(annotation) }
        }
        for card in cards {
            guard let anchor = card.pdfAnchor, let page = document.page(at: anchor.page - 1) else { continue }
            for stored in anchor.rects.prefix(256) {
                guard let bounds = PDFGeometry.pageRect(stored, cropBox: page.bounds(for: .cropBox), rotation: page.rotation) else { continue }
                let annotation = PDFAnnotation(bounds: bounds, forType: .highlight, withProperties: nil)
                annotation.color = Self.color(card.style?.color).withAlphaComponent(0.28)
                annotation.contents = [card.text, card.note ?? ""].filter { !$0.isEmpty }.joined(separator: "\n\n")
                annotation.userName = "ShufangCard"
                annotation.setValue(card.id, forAnnotationKey: .name)
                page.addAnnotation(annotation)
            }
        }
    }
    static func color(_ name: String?) -> UIColor {
        switch name { case "green": return .systemGreen; case "blue": return .systemBlue; case "pink", "red": return .systemPink; case "orange": return .systemOrange; default: return .systemYellow }
    }
    func recognizePage() {
        guard !recognizing, let page = pdfView.currentPage else { return }
        ocrPage = currentPage; ocrText = ""; recognizing = true; error = nil
        // Rasterize only this page. Vision sees the same rotation as the reader.
        let image = page.thumbnail(of: CGSize(width: 2000, height: 2600), for: .cropBox)
        guard let cgImage = image.cgImage else { recognizing = false; return }
        Task {
            do {
                let text = try await Task.detached(priority: .userInitiated) {
                    let request = VNRecognizeTextRequest()
                    request.recognitionLevel = .accurate
                    request.recognitionLanguages = ["zh-Hans", "en-US"]
                    request.usesLanguageCorrection = true
                    try VNImageRequestHandler(cgImage: cgImage).perform([request])
                    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
                }.value
                ocrText = text
                if text.isEmpty { error = "本页未识别到文字，可以手动输入。" }
            } catch { self.error = error.localizedDescription }
            recognizing = false
        }
    }

    func pdfView(_ view: PDFView, overlayViewFor page: PDFPage) -> UIView? {
        guard let document else { return nil }
        let number = document.index(for: page) + 1
        if let existing = overlays[number] { return existing }
        let box = page.bounds(for: .cropBox)
        let overlay = PDFInkOverlay(pageSize: box.size)
        overlay.canvas.delegate = self
        if let bytes = loadDrawing(number), let drawing = try? PKDrawing(data: bytes) {
            overlay.canvas.drawing = drawing
        }
        overlays[number] = overlay
        applyTools(to: overlay)
        return overlay
    }
    func pdfView(_ pdfView: PDFView, willEndDisplayingOverlayView overlayView: UIView, for page: PDFPage) {
        guard let document else { return }
        let number = document.index(for: page) + 1
        persistDrawing(page: number)
        if !dirtyPages.contains(number) { overlays.removeValue(forKey: number) }
    }
    private func updateTools() { overlays.values.forEach(applyTools) }
    private func applyTools(to overlay: PDFInkOverlay) {
        overlay.enabled = drawingEnabled
        overlay.canvas.tool = eraser ? PKEraserTool(.vector) : PKInkingTool(.pen, color: .systemRed, width: 3)
        overlay.canvas.drawingPolicy = .pencilOnly
    }
    func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        guard !restoring, let number = overlays.first(where: { $0.value.canvas === canvasView })?.key else { return }
        dirtyPages.insert(number)
        // Save at the end of each stroke; debounce long sequences while keeping
        // page changes/background close as explicit flush points.
        saveTasks[number]?.cancel()
        saveTasks[number] = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            self?.persistDrawing(page: number)
        }
    }
    private func persistDrawing(page number: Int) {
        guard dirtyPages.contains(number), let overlay = overlays[number] else { return }
        do {
            let drawing = overlay.canvas.drawing
            let preview = drawing.image(from: CGRect(origin: .zero, size: overlay.canonicalSize), scale: 1).pngData()
            try saveDrawing(number, drawing.dataRepresentation(), preview)
            dirtyPages.remove(number)
        } catch { self.error = "手写尚未保存：" + error.localizedDescription }
    }
    func refreshDrawings() {
        restoring = true
        defer { restoring = false }
        for (page, overlay) in overlays where !dirtyPages.contains(page) {
            guard let data = loadDrawing(page), data != overlay.canvas.drawing.dataRepresentation(),
                  let drawing = try? PKDrawing(data: data) else { continue }
            overlay.canvas.drawing = drawing
        }
    }
    func flushDrawings() {
        for task in saveTasks.values { task.cancel() }
        for page in Array(dirtyPages) { persistDrawing(page: page) }
    }
    func undo() { overlays[currentPage]?.canvas.undoManager?.undo() }
    func redo() { overlays[currentPage]?.canvas.undoManager?.redo() }

    func export(title: String) throws -> URL {
        flushDrawings()
        guard let document else { throw PDFStudyError.invalidDocument }
        // Draw from the live document (cards included), then flatten a separate ink
        // overlay. Never write back to source bytes or modify the original file.
        let output = NSMutableData()
        UIGraphicsBeginPDFContextToData(output, .zero, nil)
        for number in 1...document.pageCount {
            guard let page = document.page(at: number - 1) else { continue }
            let crop = page.bounds(for: .cropBox)
            let rotated = [90, 270].contains(((page.rotation % 360) + 360) % 360)
            let size = rotated ? CGSize(width: crop.height, height: crop.width) : crop.size
            let bounds = CGRect(origin: .zero, size: size)
            UIGraphicsBeginPDFPageWithInfo(bounds, nil)
            guard let context = UIGraphicsGetCurrentContext() else { continue }
            context.saveGState()
            context.translateBy(x: 0, y: size.height)
            context.scaleBy(x: 1, y: -1)
            if let ref = page.pageRef {
                context.concatenate(ref.getDrawingTransform(.cropBox, rect: bounds, rotate: 0, preserveAspectRatio: true))
                page.draw(with: .cropBox, to: context)
            }
            context.restoreGState()
            let drawing = overlays[number]?.canvas.drawing ?? loadDrawing(number).flatMap { try? PKDrawing(data: $0) }
            if let drawing {
                let canonical = CGSize(width: 1000, height: 1000 * crop.height / max(1, crop.width))
                let image = drawing.image(from: CGRect(origin: .zero, size: canonical), scale: 2)
                context.saveGState()
                // The ink overlay is stored in unrotated page coordinates.
                switch ((page.rotation % 360) + 360) % 360 {
                case 90: context.translateBy(x: size.width, y: 0); context.rotate(by: .pi / 2)
                case 180: context.translateBy(x: size.width, y: size.height); context.rotate(by: .pi)
                case 270: context.translateBy(x: 0, y: size.height); context.rotate(by: -.pi / 2)
                default: break
                }
                image.draw(in: CGRect(origin: .zero, size: crop.size))
                context.restoreGState()
            }
        }
        UIGraphicsEndPDFContext()
        let safeTitle = title.components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }.joined(separator: "_").prefix(80)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ShufangExports", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent("\(safeTitle.isEmpty ? "学习文档" : String(safeTitle))-\(UUID().uuidString.prefix(8)).pdf")
        try (output as Data).write(to: url, options: .atomic)
        guard PDFDocument(url: url)?.pageCount == document.pageCount else { throw PDFStudyError.exportFailed }
        return url
    }
}

private final class PDFInkOverlay: UIView {
    let canvas = PKCanvasView()
    let canonicalSize: CGSize
    var enabled = false
    init(pageSize: CGSize) {
        canonicalSize = CGSize(width: 1000, height: 1000 * pageSize.height / max(1, pageSize.width))
        super.init(frame: .zero)
        backgroundColor = .clear
        canvas.backgroundColor = .clear; canvas.isOpaque = false
        canvas.isScrollEnabled = false
        canvas.contentSize = canonicalSize
        addSubview(canvas)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func layoutSubviews() {
        super.layoutSubviews()
        canvas.transform = .identity
        canvas.bounds = CGRect(origin: .zero, size: canonicalSize)
        canvas.center = CGPoint(x: bounds.midX, y: bounds.midY)
        canvas.transform = CGAffineTransform(scaleX: bounds.width / canonicalSize.width, y: bounds.height / canonicalSize.height)
    }
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard enabled, event?.allTouches?.contains(where: { $0.type == .pencil }) == true else { return nil }
        return super.hitTest(point, with: event)
    }
}

struct PDFStudySurface: UIViewRepresentable {
    @ObservedObject var model: PDFStudyController
    func makeUIView(context: Context) -> PDFRegionContainer {
        let container = PDFRegionContainer(pdfView: model.pdfView)
        container.onSelection = { [weak model] in model?.captureRegion(viewRect: $0) }
        container.onLayout = { [weak model] in model?.trackScrollView() }
        return container
    }
    func updateUIView(_ view: PDFRegionContainer, context: Context) { view.regionMode = model.regionMode }
}
final class PDFRegionContainer: UIView {
    let pdfView: PDFView
    var onSelection: ((CGRect) -> Void)?
    var onLayout: (() -> Void)?
    private let regionView = UIView()
    private let outline = CAShapeLayer()
    private var start = CGPoint.zero
    var regionMode = false { didSet {
        guard oldValue != regionMode else { return }
        regionView.isHidden = !regionMode; outline.path = nil
    } }
    init(pdfView: PDFView) {
        self.pdfView = pdfView
        super.init(frame: .zero)
        addSubview(pdfView); addSubview(regionView)
        regionView.backgroundColor = .clear; regionView.isHidden = true
        outline.strokeColor = UIColor.systemOrange.cgColor; outline.fillColor = UIColor.systemOrange.withAlphaComponent(0.15).cgColor
        outline.lineWidth = 2; outline.lineDashPattern = [6, 4]; regionView.layer.addSublayer(outline)
        regionView.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(regionPan(_:))))
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func layoutSubviews() { super.layoutSubviews(); pdfView.frame = bounds; regionView.frame = bounds; outline.frame = bounds; onLayout?() }
    @objc private func regionPan(_ gesture: UIPanGestureRecognizer) {
        let point = gesture.location(in: regionView)
        if gesture.state == .began { start = point }
        let rect = CGRect(x: min(start.x, point.x), y: min(start.y, point.y), width: abs(point.x - start.x), height: abs(point.y - start.y))
        outline.path = UIBezierPath(rect: rect).cgPath
        if gesture.state == .ended {
            outline.path = nil
            if rect.width > 10, rect.height > 10 { onSelection?(rect) }
        }
        if gesture.state == .cancelled { outline.path = nil }
    }
}
