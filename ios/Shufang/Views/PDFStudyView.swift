import SwiftUI
import PDFKit
import PencilKit
import Vision

/// Native PDF reading, annotation and handwriting. Original bytes remain immutable;
/// highlights are shared cards and Pencil strokes are separate synced attachments.
struct PDFStudyView: View {
    let book: Book
    var target: StudySource? = nil
    @EnvironmentObject private var state: AppState
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = PDFStudyController()
    @State private var showThumbnails = false
    @State private var showSearch = false
    @State private var showOCR = false
    @State private var showCompare = false
    @State private var compareBook: Book?
    @State private var syncScrolling = false
    @State private var draft: PDFExcerptDraft?
    @State private var selectedCard: StudyCard?
    @State private var aiSelection: PDFExcerptDraft?
    @State private var shareURL: URL?
    @State private var pendingOCR: PDFExcerptDraft?
    @State private var query = ""
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            ErrorBanner(message: error ?? model.error)
            if model.document != nil {
                if showSearch { searchPanel }
                if showThumbnails { PDFThumbnailStrip(pdfView: model.pdfView).frame(height: 112).background(.thinMaterial) }
                GeometryReader { geometry in
                    let wide = geometry.size.width > 720
                    if let compareBook {
                        if wide {
                            HStack(spacing: 1) {
                                PDFStudySurface(model: model)
                                PDFComparePane(book: compareBook, primary: model, synchronized: syncScrolling).id(compareBook.id)
                            }
                        } else {
                            VStack(spacing: 1) {
                                PDFStudySurface(model: model)
                                PDFComparePane(book: compareBook, primary: model, synchronized: syncScrolling).id(compareBook.id)
                            }
                        }
                    } else { PDFStudySurface(model: model) }
                }
                controls
            } else if model.loading { ProgressView("正在打开 PDF…").frame(maxHeight: .infinity) }
            else { ContentUnavailableView { Label("无法打开 PDF", systemImage: "doc.richtext") } actions: {
                Button("重试") { Task { await load() } }
            } }
        }
        .navigationTitle(book.title)
        .onAppear { state.sidebarVisibility = .detailOnly }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { showThumbnails.toggle() } label: { Image(systemName: "square.grid.2x2") }.accessibilityLabel("页面缩略图")
                Button { showSearch.toggle() } label: { Image(systemName: "magnifyingglass") }.accessibilityLabel("搜索 PDF")
                Menu {
                    Picker("阅读方式", selection: Binding(get: { model.readingLayout }, set: { model.setReadingLayout($0) })) {
                        Text("上下滚动").tag("vertical")
                        Text("左右滚动").tag("horizontal")
                        Text("双页阅读").tag("spread")
                    }
                    Button("识别本页文字", systemImage: "text.viewfinder") { showOCR = true; model.recognizePage() }
                    Button("双文档对照", systemImage: "rectangle.split.2x1") { showCompare = true }
                    if compareBook != nil {
                        Toggle("同步滚动", isOn: $syncScrolling)
                        Button("结束对照") { compareBook = nil }
                    }
                    Button("导出带批注 PDF", systemImage: "square.and.arrow.up") { export() }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .sheet(item: $aiSelection) { selected in
            let page = selected.anchor.page
            let source = StudySource(kind: "pdf", bookId: book.id, chapterId: "pdf-page-\(page)",
                chapterTitle: "第 \(page) 页", text: selected.text, pdfAnchor: selected.anchor)
            AskView(book: book, chapter: Chapter(id: source.chapterId, index: page - 1,
                title: source.chapterTitle, paragraphs: [model.document?.page(at: page - 1)?.string ?? selected.text]),
                selectedText: selected.text, source: source)
        }
        .sheet(item: $selectedCard) { card in
            if let store = state.study {
                NavigationStack {
                    StudyCardDetail(store: store, cardID: card.id) { source in
                        selectedCard = nil
                        if let anchor = source.pdfAnchor { model.go(to: anchor) }
                    }.toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { selectedCard = nil } } }
                }
            }
        }
        .sheet(item: $draft) { selected in
            PDFExcerptEditor(draft: selected) { text, note, color in
                guard let study = state.study else { throw PDFStudyError.storeUnavailable }
                var card = StudyCard(bookId: book.id, chapterId: "pdf-page-\(selected.anchor.page)", chapterTitle: "第 \(selected.anchor.page) 页", text: text,
                    pdfAnchor: selected.anchor, style: StudyStyle(kind: "background", color: color), note: note)
                if selected.isRegion { card.name = "区域摘录 · 第 \(selected.anchor.page) 页" }
                try study.save(card)
                for extra in selected.additionalPages {
                    try study.save(StudyCard(bookId: book.id, chapterId: "pdf-page-\(extra.anchor.page)",
                        chapterTitle: "第 \(extra.anchor.page) 页", text: extra.text, pdfAnchor: extra.anchor,
                        style: StudyStyle(kind: "background", color: color), note: note))
                }
                model.render(cards: study.cards.filter { $0.bookId == book.id })
            }
        }
        .sheet(isPresented: $showOCR, onDismiss: { if let selected = pendingOCR { draft = selected; pendingOCR = nil } }) { ocrEditor }
        .sheet(isPresented: $showCompare) { comparePicker }
        .sheet(isPresented: Binding(get: { shareURL != nil }, set: { if !$0 { shareURL = nil } })) {
            if let shareURL { PDFShareSheet(url: shareURL) }
        }
        .task(id: book.id) { await load() }
        .onChange(of: target) { _, source in if let anchor = source?.pdfAnchor { model.go(to: anchor) } }
        .background { if let study = state.study { PDFCardRefreshObserver(study: study, model: model, bookID: book.id) } }
        .onChange(of: scenePhase) { _, phase in if phase != .active { model.persistPosition(); model.flushDrawings() } }
        .onDisappear { model.persistPosition(); model.flushDrawings() }
    }

    private var controls: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 20) {
                Button { model.previousPage() } label: { Image(systemName: "chevron.left") }.disabled(model.currentPage <= 1)
                Text("\(model.currentPage) / \(model.pageCount)").font(.caption.monospacedDigit())
                Button { model.nextPage() } label: { Image(systemName: "chevron.right") }.disabled(model.currentPage >= model.pageCount)
                Divider().frame(height: 24)
                Button { if let selected = model.selectedExcerpt() { draft = selected } }
                    label: { Label("摘录", systemImage: "highlighter") }.disabled(!model.hasSelection)
                Button { aiSelection = model.selectedExcerpt() }
                    label: { Label("伴读", systemImage: "sparkles") }.disabled(!model.hasSelection)
                Button { model.regionMode.toggle(); model.drawingEnabled = false }
                    label: { Label(model.regionMode ? "取消框选" : "框选", systemImage: "viewfinder") }
                Button { model.drawingEnabled.toggle(); model.regionMode = false }
                    label: { Label("手写", systemImage: model.drawingEnabled ? "pencil.tip.crop.circle.fill" : "pencil.tip.crop.circle") }
                if model.drawingEnabled {
                    Button { model.eraser.toggle() } label: { Label(model.eraser ? "画笔" : "橡皮", systemImage: model.eraser ? "pencil.tip" : "eraser") }
                    Button { model.undo() } label: { Image(systemName: "arrow.uturn.backward") }.accessibilityLabel("撤销手写")
                    Button { model.redo() } label: { Image(systemName: "arrow.uturn.forward") }.accessibilityLabel("重做手写")
                    Text("Apple Pencil 书写 · 手指翻页").font(.caption).foregroundStyle(.secondary)
                }
            }.padding(.horizontal).padding(.vertical, 12)
        }.background(.bar)
    }

    private var searchPanel: some View {
        VStack(spacing: 6) {
            HStack {
                TextField("搜索文内文字", text: $query).textFieldStyle(.roundedBorder).onSubmit { model.search(query) }
                Button("搜索") { model.search(query) }
                if model.searching { ProgressView() }
            }.padding(.horizontal)
            if !model.searchResults.isEmpty {
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(Array(model.searchResults.enumerated()), id: \.offset) { index, result in
                            Button { model.selectSearchResult(index) } label: {
                                Text("第 \(model.pageNumber(result)) 页 · \(result.string ?? "")").lineLimit(1).font(.caption)
                            }.buttonStyle(.bordered)
                        }
                    }.padding(.horizontal)
                }.frame(height: 40)
            } else if !query.isEmpty && model.didSearch && !model.searching {
                Text("未找到文字；扫描页面可使用“识别本页文字”。").font(.caption).foregroundStyle(.secondary)
            }
        }.padding(.vertical, 8)
    }

    private var ocrEditor: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text("第 \(model.ocrPage) 页 · 设备端识别").font(.caption).foregroundStyle(.secondary)
                Text("请校正识别内容后保存；摘录会保留原页位置。").font(.callout)
                if model.recognizing { ProgressView("正在识别本页…") }
                TextEditor(text: $model.ocrText).border(.quaternary)
                ErrorBanner(message: model.error)
            }.padding()
                .navigationTitle("识别文字")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("关闭") { showOCR = false } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("保存摘录") {
                            pendingOCR = PDFExcerptDraft(text: model.ocrText, anchor: .init(page: model.ocrPage,
                                rects: [.init(x: 0, y: 0, width: 1, height: 1)]), isRegion: true)
                            showOCR = false
                        }.disabled(model.recognizing || model.ocrText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
        }
    }

    private var comparePicker: some View {
        NavigationStack {
            List((state.study?.books ?? []).filter { $0.format.lowercased() == "pdf" && $0.id != book.id }) { candidate in
                Button(candidate.title) { compareBook = candidate; showCompare = false }
            }
            .overlay {
                if (state.study?.books ?? []).filter({ $0.format.lowercased() == "pdf" && $0.id != book.id }).isEmpty {
                    ContentUnavailableView("没有其他 PDF", systemImage: "doc.on.doc", description: Text("请先导入另一本 PDF，再进行对照。"))
                }
            }
            .navigationTitle("选择对照文档")
            .toolbar { Button("取消") { showCompare = false } }
        }
    }

    private func load() async {
        guard let client = state.client, !model.loading else { return }
        let scopedStore = state.study
        let bookID = book.id
        model.configure(positionKey: state.progressKey(book: bookID) + ".pdf.v1",
            loadDrawing: { page in
                    do {
                        if let ink = try scopedStore?.portablePDFInk(bookID: bookID, page: page) { return try ink.pencilDrawing().dataRepresentation() }
                        if let store=scopedStore, let bytes=store.pdfDrawing(bookID: bookID, page: page), let pdfPage=model.document?.page(at: page-1) {
                            let box=pdfPage.bounds(for: .cropBox)
                            let portable=try PortableInk(drawing: PKDrawing(data: bytes), height: 1000*Double(box.height/max(1,box.width)))
                            try store.savePDFDrawing(bookID: bookID, page: page, drawing: bytes, preview: nil, portableInk: JSONEncoder().encode(portable))
                            return bytes
                        }
                        return scopedStore?.pdfDrawing(bookID: bookID, page: page)
                    } catch { model.error = "手写附件无法加载或转换：" + error.localizedDescription; return nil }
                },
            saveDrawing: { page, drawing, preview in
                guard let scopedStore else { throw PDFStudyError.storeUnavailable }
                guard let pdfPage = model.document?.page(at: page - 1) else { throw PortableInkError.invalid }
                let box = pdfPage.bounds(for: .cropBox)
                let portable = try PortableInk(drawing: PKDrawing(data: drawing), height: 1000 * Double(box.height / max(1, box.width)), previous: try scopedStore.portablePDFInk(bookID: bookID, page: page))
                try scopedStore.savePDFDrawing(bookID: bookID, page: page, drawing: drawing, preview: preview, portableInk: JSONEncoder().encode(portable))
            })
        let draftBinding = $draft, cardBinding = $selectedCard
        model.onRegion = { draftBinding.wrappedValue = $0 }
        model.onCardSelected = { id in cardBinding.wrappedValue = scopedStore?.cards.first { $0.id == id } }
        if model.document == nil {
            var local = state.study?.sourcePDF(bookID: book.id)
            if local == nil { local = await state.offline?.pdf(bookID: book.id) }
            await model.load(bytes: local, client: client, book: book)
        }
        model.render(cards: (state.study?.cards ?? []).filter { $0.bookId == book.id })
        if let anchor = target?.pdfAnchor { model.go(to: anchor) }
    }

    private func export() {
        do { shareURL = try model.export(title: book.title) }
        catch { self.error = error.localizedDescription }
    }
}

private struct PDFComparePane: View {
    let book: Book
    @ObservedObject var primary: PDFStudyController
    let synchronized: Bool
    @EnvironmentObject private var state: AppState
    @StateObject private var model = PDFStudyController()
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(book.title).lineLimit(1)
                Spacer()
                Text("\(model.currentPage) / \(model.pageCount)").monospacedDigit()
            }.font(.caption).padding(8).background(.thinMaterial)
            if model.loading { ProgressView() }
            ErrorBanner(message: model.error)
            PDFStudySurface(model: model)
        }
        .task(id: book.id) {
            guard let client = state.client else { return }
            let scopedStore = state.study, bookID = book.id
            model.configure(positionKey: state.progressKey(book: bookID) + ".pdf.v1", loadDrawing: { page in
                    do {
                        if let ink = try scopedStore?.portablePDFInk(bookID: bookID, page: page) { return try ink.pencilDrawing().dataRepresentation() }
                        if let store=scopedStore, let bytes=store.pdfDrawing(bookID: bookID, page: page), let pdfPage=model.document?.page(at: page-1) {
                            let box=pdfPage.bounds(for: .cropBox)
                            let portable=try PortableInk(drawing: PKDrawing(data: bytes), height: 1000*Double(box.height/max(1,box.width)))
                            try store.savePDFDrawing(bookID: bookID, page: page, drawing: bytes, preview: nil, portableInk: JSONEncoder().encode(portable))
                            return bytes
                        }
                        return scopedStore?.pdfDrawing(bookID: bookID, page: page)
                    } catch { model.error = "手写附件无法加载或转换：" + error.localizedDescription; return nil }
                }, saveDrawing: { _, _, _ in })
            var local = state.study?.sourcePDF(bookID: book.id)
            if local == nil { local = await state.offline?.pdf(bookID: book.id) }
            await model.load(bytes: local, client: client, book: book)
            model.render(cards: (state.study?.cards ?? []).filter { $0.bookId == book.id })
        }
        .onChange(of: primary.scrollPosition) { old, new in
            if synchronized { model.go(scrollPosition: model.scrollPosition + new - old) }
        }
        .background { if let study = state.study { PDFCardRefreshObserver(study: study, model: model, bookID: book.id) } }
        .onDisappear { model.persistPosition() }
    }
}

struct PDFExcerptSegment {
    var text: String
    var anchor: StudyPDFAnchor
}
struct PDFExcerptDraft: Identifiable {
    let id = UUID()
    var text: String
    var anchor: StudyPDFAnchor
    var isRegion = false
    var preview: UIImage? = nil
    var additionalPages: [PDFExcerptSegment] = []
}

private struct PDFExcerptEditor: View {
    let draft: PDFExcerptDraft
    let save: (String, String, String) throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var note = ""
    @State private var color = "orange"
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section("第 \(draft.anchor.page) 页") {
                    if let image = draft.preview { Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 200) }
                    TextEditor(text: $text).frame(minHeight: 100)
                }
                if !draft.additionalPages.isEmpty {
                    Section("跨页选区") {
                        Text("将按来源页分别保存 \(draft.additionalPages.count + 1) 张卡片，共用下方批注。")
                            .font(.caption).foregroundStyle(.secondary)
                        ForEach(Array(draft.additionalPages.enumerated()), id: \.offset) { _, page in
                            VStack(alignment: .leading) {
                                Text("第 \(page.anchor.page) 页").font(.caption).foregroundStyle(.secondary)
                                Text(page.text).textSelection(.enabled)
                            }
                        }
                    }
                }
                Section("批注") { TextEditor(text: $note).frame(minHeight: 100) }
                Picker("颜色", selection: $color) {
                    Text("橙色").tag("orange"); Text("黄色").tag("yellow"); Text("绿色").tag("green"); Text("蓝色").tag("blue"); Text("粉色").tag("pink")
                }
                ErrorBanner(message: error)
            }
            .navigationTitle("保存学习卡片")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("保存") {
                    do { try save(text, note, color); dismiss() } catch { self.error = error.localizedDescription }
                }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
            }.onAppear { text = draft.text }
        }
    }
}

private struct PDFThumbnailStrip: UIViewRepresentable {
    let pdfView: PDFView
    func makeUIView(context: Context) -> PDFThumbnailView {
        let view = PDFThumbnailView(); view.pdfView = pdfView; view.layoutMode = .horizontal
        view.thumbnailSize = CGSize(width: 60, height: 85); return view
    }
    func updateUIView(_ view: PDFThumbnailView, context: Context) { view.pdfView = pdfView }
}
private struct PDFShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [url], applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
enum PDFStudyError: LocalizedError {
    case invalidDocument, storeUnavailable, noPage, exportFailed
    var errorDescription: String? {
        switch self {
        case .invalidDocument: return "PDF 文件无法读取，或文件已损坏。"
        case .storeUnavailable: return "本地学习资料尚未准备好，请重新打开文档。"
        case .noPage: return "请先打开一个 PDF 页面。"
        case .exportFailed: return "导出失败，请检查设备剩余存储空间。"
        }
    }
}

private struct PDFCardRefreshObserver: View {
    @ObservedObject var study: StudyStore
    let model: PDFStudyController
    let bookID: String
    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .onChange(of: study.cards) { _, cards in model.render(cards: cards.filter { $0.bookId == bookID }) }
            .onChange(of: study.records) { _, _ in model.refreshDrawings() }
            .onChange(of: study.syncing) { _, busy in if !busy { model.refreshDrawings() } }
    }
}
