import SwiftUI

struct StudySourceView: View {
    let source: StudySource
    var showStudyCards = true
    @EnvironmentObject private var state: AppState
    @State private var book: Book?
    @State private var chapters: [ChapterSummary] = []
    @State private var error: String?
    @State private var loading = false
    @State private var requestID = UUID()
    var body: some View {
        Group {
            if let book {
                if source.kind == "pdf" || (book.format.lowercased() == "pdf" && source.chapterId.isEmpty) {
                    PDFStudyView(book: book, target: source)
                } else if !chapters.isEmpty {
                    ReaderStudyWorkspace(book: book, chapters: chapters,
                        initialIndex: chapters.firstIndex(where: { $0.id == source.chapterId }) ?? 0, target: source, showStudyCards: showStudyCards)
                } else { ContentUnavailableView("暂无文本章节", systemImage: "doc.text") }
            } else if loading { ProgressView("打开来源…") }
            else { ContentUnavailableView { Label("无法打开来源", systemImage: "book.closed") } description: { Text(error ?? "书籍尚未下载或已删除") } actions: { Button("重试") { Task { await load() } } } }
        }
        .task(id: source.id) { await load() }
    }
    private func load() async {
        let request = UUID(), session = state.sessionID
        let client = state.client, offline = state.offline
        let localBook = state.study?.books.first { $0.id == source.bookId }
        requestID = request; loading = true; book = nil; chapters = []; error = nil
        defer { if requestID == request { loading = false } }
        do {
            let cached = await offline?.package(for: source.bookId)
            try Task.checkCancellation()
            var candidate = localBook ?? cached?.book
            if candidate == nil, let client { candidate = try await client.request(["books", source.bookId]) }
            guard let candidate else { throw StudyError.unavailable }
            let opensPDF = source.kind == "pdf" || (candidate.format.lowercased() == "pdf" && source.chapterId.isEmpty)
            var loadedChapters: [ChapterSummary] = []
            // PDF books can also contain reflowable text chapters. Their text
            // highlights need the same online chapter lookup as TXT books.
            if !opensPDF {
                if let cached { loadedChapters = cached.chapters }
                else if let client {
                    let response: ChaptersResponse = try await client.request(["books", source.bookId, "chapters"])
                    loadedChapters = response.chapters
                }
            }
            try Task.checkCancellation()
            guard state.sessionID == session, requestID == request else { return }
            chapters = loadedChapters; book = candidate; error = nil
        } catch is CancellationError { }
        catch { if state.sessionID == session, requestID == request { self.error = error.localizedDescription } }
    }
}

struct ReaderStudyWorkspace: View {
    let book: Book
    let chapters: [ChapterSummary]
    let initialIndex: Int
    var target: StudySource? = nil
    var showStudyCards = true
    @EnvironmentObject private var state: AppState
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var showCards = false
    @State private var activeSource: StudySource?
    var body: some View {
        GeometryReader { geometry in
            ReaderView(book: book, chapters: chapters, initialIndex: initialIndex, target: activeSource ?? target)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay(alignment: .topTrailing) {
                    if showStudyCards, let store = state.study {
                        Color.clear.frame(width: 1, height: 1)
                            .popover(isPresented: $showCards, arrowEdge: .top) {
                        FloatingStudyPanel(title: "学习卡片", size: geometry.size, onClose: { showCards = false }) {
                            StudyCardList(store: store, bookIDs: Set([book.id]), onSource: {
                                activeSource = $0
                                showCards = false
                            })
                        }.presentationCompactAdaptation(.popover)
                            }
                        .padding(12)
                    }
                }
        }
        .onAppear { state.sidebarVisibility = .detailOnly }
        .toolbar {
            if showStudyCards, sizeClass == .regular { Button { showCards.toggle() } label: { Image(systemName: "rectangle.on.rectangle") }.accessibilityLabel("打开学习悬浮窗") }
        }
    }
}

/// An overlay never participates in the reader's width or pagination proposal.
struct FloatingStudyPanel<Content: View>: View {
    @EnvironmentObject private var state: AppState
    let title: String
    let size: CGSize
    let onClose: () -> Void
    @ViewBuilder let content: () -> Content
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label(title, systemImage: "rectangle.on.rectangle").font(.headline)
                Spacer()
                Button(action: onClose) { Image(systemName: "xmark.circle.fill").font(.title3).foregroundStyle(.secondary) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("关闭学习悬浮窗")
                    .frame(minWidth: 44, minHeight: 44)
            }.padding(.leading, 16).padding(.trailing, 6)
            Divider()
            NavigationStack { content().navigationBarTitleDisplayMode(.inline) }.environmentObject(state)
        }
        .frame(width: min(380, max(0, size.width - 24)), height: min(640, max(0, size.height - 24)))
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(.primary.opacity(0.08)))
        .shadow(color: .black.opacity(0.18), radius: 18, x: 0, y: 8)
        .accessibilityIdentifier("floatingStudyPanel")
    }
}

