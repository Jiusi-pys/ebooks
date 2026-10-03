import SwiftUI
import UIKit
import FoundationModels

private extension Double {
    func rounded(to step: Double) -> Double { (self / step).rounded() * step }
}

private struct ReaderStyle: Codable, Equatable {
    var fontId = "song"
    var fontSize = 19.0
    var lineHeight = 2.0
    var paragraphSpacing = 0.4
    var letterSpacing = 0.02
    var readingFlow: ReaderFlow? = nil
    var pageEffect: ReaderTurnEffect? = nil
    var flow: ReaderFlow { readingFlow ?? .horizontal }
    var effect: ReaderTurnEffect { pageEffect ?? .slide }
    var pageMargin = 32.0 // Retained to decode earlier saved styles.
    var readingWidthPercent: Double? = nil
    var contentWidthPercent: Double {
        get { min(100, max(50, readingWidthPercent ?? 92)) }
        set { readingWidthPercent = min(100, max(50, newValue)) }
    }
    var fontWeight = 400
    var themeId = "warm"

    static let fonts: [(String, String)] = [
        ("song", "宋体"), ("hei", "黑体"), ("kai", "楷体"),
        ("fangsong", "仿宋"), ("yuan", "圆体"), ("xihei", "细黑"),
        ("latin-serif", "西文衬线"), ("latin-sans", "西文无衬线"),
    ]
    static let themes: [(String, String, Color, Color)] = [
        ("paper", "纸白", Color(red: 1, green: 0.992, blue: 0.969),
         Color(red: 0.239, green: 0.212, blue: 0.161)),
        ("warm", "暖米", Color(red: 0.953, green: 0.925, blue: 0.875),
         Color(red: 0.310, green: 0.282, blue: 0.243)),
        ("green", "豆绿", Color(red: 0.906, green: 0.937, blue: 0.886),
         Color(red: 0.200, green: 0.251, blue: 0.184)),
        ("night", "夜览", Color(red: 0.149, green: 0.125, blue: 0.098),
         Color(red: 0.812, green: 0.761, blue: 0.659)),
    ]
    var background: Color { Self.themes.first { $0.0 == themeId }?.2 ?? Self.themes[1].2 }
    var ink: Color { Self.themes.first { $0.0 == themeId }?.3 ?? Self.themes[1].3 }

    func font(size: CGFloat? = nil, weight: Int? = nil) -> UIFont {
        let size = size ?? CGFloat(fontSize)
        let weight = weight ?? fontWeight
        let name: String
        switch fontId {
        case "hei": name = weight >= 600 ? "PingFangSC-Semibold" :
            weight <= 300 ? "PingFangSC-Light" : "PingFangSC-Regular"
        case "kai": name = "LXGWWenKaiLite-Regular"
        case "fangsong": name = "tkFangSong"
        case "yuan": name = "ZCOOLKuaiLe-Regular"
        case "xihei": name = weight >= 600 ? "PingFangSC-Semibold" : "PingFangSC-Light"
        case "latin-serif": name = weight >= 600 ? "Georgia-Bold" : "Georgia"
        case "latin-sans": name = weight >= 600 ? "HelveticaNeue-Medium" :
            weight <= 300 ? "HelveticaNeue-Light" : "HelveticaNeue"
        default: name = "NotoSerifCJKsc-Regular"
        }
        let systemWeight: UIFont.Weight = weight >= 600 ? .semibold :
            weight <= 300 ? .light : .regular
        return UIFont(name: name, size: size) ?? UIFont.systemFont(ofSize: size, weight: systemWeight)
    }
    var strokeWidth: CGFloat {
        switch fontWeight {
        case ..<400: return 1
        case 600...: return -2
        default: return 0
        }
    }
    func lineSpacing(for font: UIFont) -> CGFloat {
        max(0, CGFloat(lineHeight) * font.pointSize - font.lineHeight)
    }
    func inset(for width: CGFloat) -> CGFloat {
        max(0, width) * CGFloat((100 - contentWidthPercent) / 200)
    }
    static func loadGeneral() -> Self {
        let defaults = UserDefaults.standard
        if let data = defaults.data(forKey: "reader.style.general"),
           let style = try? JSONDecoder().decode(Self.self, from: data) { return style }
        var style = Self()
        if defaults.object(forKey: "reader.fontSize") != nil {
            style.fontSize = min(26, max(14, defaults.double(forKey: "reader.fontSize")))
        }
        if let oldTheme = defaults.string(forKey: "reader.theme") {
            style.themeId = oldTheme == "white" ? "paper" : oldTheme
        }
        return style
    }
    static func loadBook(_ id: String) -> Self? {
        guard let data = UserDefaults.standard.data(forKey: "reader.style.book.\(id)") else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }
    func save(_ key: String) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }
}

private enum ReaderTextAction { case highlight, translate, ask }
private struct ReaderMark { let id: String; let range: NSRange; let style: StudyStyle }

private struct SelectableReaderText: UIViewRepresentable {
    let text: String
    let style: ReaderStyle
    let color: UIColor
    var marks: [ReaderMark] = []
    var footnotes: [ReaderFootnote] = []
    var onFootnote: (ReaderFootnote, CGRect) -> Void = { _, _ in }
    var recall = false
    var onMark: (String) -> Void = { _ in }
    let onSelectionChange: (Bool) -> Void
    let onAction: (ReaderTextAction, NSRange) -> Void
    let onTap: (CGPoint) -> Void
    let onPageTurn: (Int) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = false
        let doubleTap = UITapGestureRecognizer(target: context.coordinator,
                                               action: #selector(Coordinator.ignoreDoubleTap))
        doubleTap.numberOfTapsRequired = 2
        doubleTap.cancelsTouchesInView = false
        doubleTap.delegate = context.coordinator
        view.addGestureRecognizer(doubleTap)
        let tap = UITapGestureRecognizer(target: context.coordinator,
                                        action: #selector(Coordinator.handleTap(_:)))
        tap.cancelsTouchesInView = false
        tap.delegate = context.coordinator
        tap.require(toFail: doubleTap)
        view.addGestureRecognizer(tap)
        for direction in [UISwipeGestureRecognizer.Direction.left, .right, .up, .down] {
            let swipe = UISwipeGestureRecognizer(target: context.coordinator,
                                                 action: #selector(Coordinator.handleSwipe(_:)))
            swipe.direction = direction
            swipe.cancelsTouchesInView = false
            swipe.delegate = context.coordinator
            view.addGestureRecognizer(swipe)
        }
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        let font = style.font()
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = style.lineSpacing(for: font)
        paragraph.paragraphSpacingBefore = CGFloat(style.paragraphSpacing) * font.pointSize
        let styled = NSMutableAttributedString(string: text, attributes: [
            .font: font, .foregroundColor: color, .paragraphStyle: paragraph,
            .kern: CGFloat(style.letterSpacing) * font.pointSize,
            .strokeWidth: style.strokeWidth,
        ])
        let colors: [String: UIColor] = ["orange": .systemOrange, "yellow": .systemYellow, "green": .systemGreen, "blue": .systemBlue, "purple": .systemPurple]
        for mark in marks where NSMaxRange(mark.range) <= styled.length && mark.range.length > 0 {
            let tint = colors[mark.style.color] ?? .systemOrange
            if recall {
                styled.addAttributes([.foregroundColor: UIColor.clear, .backgroundColor: color.withAlphaComponent(0.16)], range: mark.range)
            } else if mark.style.kind == "background" {
                styled.addAttribute(.backgroundColor, value: tint.withAlphaComponent(0.28), range: mark.range)
            } else if mark.style.kind == "color" {
                styled.addAttribute(.foregroundColor, value: tint, range: mark.range)
            } else if mark.style.kind != "none" {
                styled.addAttributes([.underlineStyle: NSUnderlineStyle.single.rawValue, .underlineColor: tint], range: mark.range)
            }
        }
        // Keep original characters and offsets; style only the note marker.
        for (index, note) in footnotes.enumerated() {
            styled.addAttributes([.link: URL(string: "shufang-footnote://note/\(index)")!,
                .font: style.font(size: font.pointSize * 0.62),
                .baselineOffset: font.pointSize * 0.38, .kern: 0,
                .foregroundColor: UIColor.systemTeal, .underlineStyle: 0], range: note.range)
        }
        view.linkTextAttributes = [.foregroundColor: UIColor.systemTeal]
        if !view.attributedText.isEqual(to: styled) { view.attributedText = styled }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView,
                      context: Context) -> CGSize? {
        let width = proposal.width ?? 300
        return uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    }

    final class Coordinator: NSObject, UITextViewDelegate, UIGestureRecognizerDelegate {
        var parent: SelectableReaderText
        private var hadSelection = false
        init(_ parent: SelectableReaderText) { self.parent = parent }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
            true
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let swipe = gestureRecognizer as? UISwipeGestureRecognizer else { return true }
            switch parent.style.flow {
            case .horizontal: return swipe.direction == .left || swipe.direction == .right
            case .vertical: return swipe.direction == .up || swipe.direction == .down
            case .scroll: return false
            }
        }
        @objc func ignoreDoubleTap() {}

        @objc func handleTap(_ gesture: UITapGestureRecognizer) {
            guard gesture.state == .ended,
                  let view = gesture.view as? UITextView,
                  view.selectedRange.length == 0 else { return }
            let location = gesture.location(in: view)
            for note in parent.footnotes where rects(note.range, in: view).contains(where: { $0.insetBy(dx: -4, dy: -4).contains(location) }) {
                showFootnote(note, in: view); return
            }
            if let position = view.closestPosition(to: location) {
                let offset = view.offset(from: view.beginningOfDocument, to: position)
                if let mark = parent.marks.first(where: { NSLocationInRange(offset, $0.range) }) {
                    parent.onMark(mark.id); return
                }
            }
            parent.onTap(CGPoint(x: location.x / max(view.bounds.width, 1), y: location.y / max(view.bounds.height, 1)))
        }

        private func rects(_ range: NSRange, in view: UITextView) -> [CGRect] {
            guard let start = view.position(from: view.beginningOfDocument, offset: range.location),
                  let end = view.position(from: start, offset: range.length),
                  let textRange = view.textRange(from: start, to: end) else { return [] }
            return view.selectionRects(for: textRange).map(\.rect)
                .filter { $0.width > 0 && $0.height > 0 }
        }
        private func showFootnote(_ note: ReaderFootnote, in view: UITextView) {
            parent.onFootnote(note, rects(note.range, in: view).first ?? view.bounds)
        }
        func textView(_ textView: UITextView, shouldInteractWith URL: URL,
                      in characterRange: NSRange, interaction: UITextItemInteraction) -> Bool {
            guard URL.scheme == "shufang-footnote", let index = Int(URL.lastPathComponent),
                  parent.footnotes.indices.contains(index) else { return false }
            showFootnote(parent.footnotes[index], in: textView)
            return false
        }

        @objc func handleSwipe(_ gesture: UISwipeGestureRecognizer) {
            guard gesture.state == .ended,
                  let view = gesture.view as? UITextView,
                  view.selectedRange.length == 0 else { return }
            parent.onPageTurn(gesture.direction == .left || gesture.direction == .up ? 1 : -1)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            let active = textView.selectedRange.length > 0
            guard active != hadSelection else { return }
            hadSelection = active
            DispatchQueue.main.async { [parent] in parent.onSelectionChange(active) }
        }

        func textView(_ textView: UITextView, editMenuForTextIn range: NSRange,
                      suggestedActions: [UIMenuElement]) -> UIMenu? {
            guard range.length > 0,
                  NSMaxRange(range) <= (textView.text as NSString).length else { return nil }
            let capture = parent.onAction
            let selectionChanged = parent.onSelectionChange
            let actions: [UIMenuElement] = [
                UIAction(title: "摘录并批注", image: UIImage(systemName: "highlighter")) { _ in
                    selectionChanged(false); capture(.highlight, range)
                },
                UIAction(title: "翻译所选", image: UIImage(systemName: "character.book.closed")) { _ in
                    selectionChanged(false); capture(.translate, range)
                },
                UIAction(title: "询问 AI", image: UIImage(systemName: "sparkles")) { _ in
                    selectionChanged(false); capture(.ask, range)
                },
            ]
            return UIMenu(children: actions + suggestedActions)
        }
    }
}

private struct ReaderSegment: Identifiable {
    let id = UUID()
    let paragraph: Int
    let text: String
    let continues: Bool
    let start: Int
}

private struct ReaderPage: Identifiable {
    let id: Int
    let segments: [ReaderSegment]
}

private enum ReaderPaginator {
    static func pages(_ paragraphs: [String], width: CGFloat, height: CGFloat,
                      style: ReaderStyle, title: String) -> [ReaderPage] {
        let font = style.font()
        let fontSize = font.pointSize
        // SwiftUI's Text layout can be taller than NSString's bounding box.
        // Keep a reserve so no line is compressed into an ellipsis.
        let usableHeight = max(120, height - 72)
        let usableWidth = max(120, width - style.inset(for: width) * 2)
        var result: [ReaderPage] = []
        var current: [ReaderSegment] = []
        var used: CGFloat = 0

        func measured(_ text: String, size: CGFloat = fontSize) -> CGFloat {
            let measuredFont = size == fontSize ? font : style.font(size: size, weight: 600)
            let paragraphStyle = NSMutableParagraphStyle()
            paragraphStyle.lineSpacing = style.lineSpacing(for: measuredFont)
            let attributes: [NSAttributedString.Key: Any] = [
                .font: measuredFont,
                .paragraphStyle: paragraphStyle,
                .kern: CGFloat(style.letterSpacing) * size,
                .strokeWidth: style.strokeWidth,
            ]
            return ceil((text as NSString).boundingRect(
                with: CGSize(width: usableWidth, height: .greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                attributes: attributes, context: nil).height * 1.10) + 4
        }
        func finishPage() {
            result.append(ReaderPage(id: result.count, segments: current))
            current = []
            used = 0
        }
        // The first page reserves room for the book name and chapter heading.
        used = 22 + measured(title, size: 29) + 34
        for (paragraphIndex, paragraph) in paragraphs.enumerated() where !paragraph.isEmpty {
            var characters = Array(paragraph)
            var continues = false
            var consumedUTF16 = 0
            while !characters.isEmpty {
                let gap: CGFloat = continues ? 5 : CGFloat(style.paragraphSpacing) * fontSize
                if used + gap + font.lineHeight + 12 > usableHeight && !current.isEmpty {
                    finishPage()
                    continue
                }
                let available = max(font.lineHeight + 12, usableHeight - used - gap)
                var low = 1
                var high = characters.count
                var count = 1
                while low <= high {
                    let middle = (low + high) / 2
                    let part = String(characters.prefix(middle))
                    if measured(part) <= available {
                        count = middle
                        low = middle + 1
                    } else { high = middle - 1 }
                }
                // Prefer a word boundary when possible; a long word can still split.
                if count < characters.count, count > 20,
                   let boundary = characters.prefix(count).lastIndex(where: { $0.isWhitespace }),
                   boundary > 0 { count = characters.distance(from: characters.startIndex, to: boundary) + 1 }
                let part = String(characters.prefix(count))
                current.append(ReaderSegment(paragraph: paragraphIndex, text: part,
                                             continues: continues, start: consumedUTF16))
                used += gap + measured(part)
                consumedUTF16 += part.utf16.count
                characters.removeFirst(count)
                continues = true
                if !characters.isEmpty { finishPage() }
            }
        }
        if !current.isEmpty || result.isEmpty { finishPage() }
        return result
    }
}

struct SelectedParagraph: Identifiable {
    let id = UUID()
    let chapter: Chapter
    let index: Int
    let text: String
    let start: Int
    var sources: [StudySource] = []
    var end: Int { sources.first?.end ?? start + text.utf16.count }
}
struct ReaderView: View {
    let book: Book
    let chapters: [ChapterSummary]
    let initialIndex: Int
    var target: StudySource? = nil
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var generalStyle: ReaderStyle
    @State private var bookStyle: ReaderStyle?
    @State private var index: Int
    @State private var chapter: Chapter?
    @State private var error: String?
    @State private var loading = false
    @State private var selection: SelectedParagraph?
    @State private var translationSelection: SelectedParagraph?
    @State private var askingSelection: SelectedParagraph?
    @State private var selectingText = false
    @State private var asking = false
    @State private var showingContents = false
    @State private var showingAppearance = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var scrollPage: Int?
    @State private var forward = true
    @State private var footnotePage: Int?
    @State private var pageIndex = 0
    @State private var pageCount = 1
    @State private var openPreviousAtEnd = false
    @State private var controlsVisible = true
    @State private var hideTask: Task<Void, Never>?
    @State private var activeReading: ReadingSession?
    @State private var footnote: ReaderFootnote?
    @State private var footnoteAnchor = CGRect.zero
    @State private var editingCard: StudyCard?
    @State private var recalling = false
    @State private var pendingSource: StudySource?
    init(book: Book, chapters: [ChapterSummary], initialIndex: Int, target: StudySource? = nil) {
        self.book = book; self.chapters = chapters; self.initialIndex = initialIndex
        self.target = target
        _pendingSource = State(initialValue: target)
        _index = State(initialValue: initialIndex)
        _generalStyle = State(initialValue: ReaderStyle.loadGeneral())
        _bookStyle = State(initialValue: ReaderStyle.loadBook(book.id))
    }
    private var style: ReaderStyle {
        var result = bookStyle ?? generalStyle
        result.fontSize = Double(UIFontMetrics(forTextStyle: .body)
            .scaledValue(for: CGFloat(result.fontSize)))
        return result
    }
    private var paper: Color { style.background }
    private var ink: Color { style.ink }
    var body: some View {
        VStack(spacing: 0) {
            if controlsVisible { ErrorBanner(message: error) }
            if loading { ProgressView("加载章节…").padding() }
            if let chapter {
                GeometryReader { geometry in
                    let pages = ReaderPaginator.pages(chapter.paragraphs,
                        width: geometry.size.width, height: geometry.size.height,
                        style: style, title: chapter.title)
                    let page = pages[min(max(pageIndex, 0), pages.count - 1)]
                    Group {
                        if style.flow == .scroll {
                            ScrollViewReader { proxy in
                                ScrollView(.vertical) {
                                    LazyVStack(spacing: 0) {
                                        ForEach(pages) { item in
                                            pageBody(item, chapter: chapter, size: geometry.size)
                                                .frame(height: geometry.size.height).id(item.id)
                                        }
                                    }.scrollTargetLayout()
                                }
                                .scrollPosition(id: $scrollPage, anchor: .top)
                                .onAppear { scrollPage = pageIndex; proxy.scrollTo(pageIndex, anchor: .top) }
                                .onChange(of: scrollPage) { _, value in
                                    if let value, pages.indices.contains(value) { pageIndex = value }
                                }
                                .onChange(of: pageIndex) { _, value in
                                    if scrollPage != value { proxy.scrollTo(value, anchor: .top) }
                                }
                            }
                        } else {
                            ZStack {
                                pageBody(page, chapter: chapter, size: geometry.size)
                                    .background(paper)
                                    .id("\(chapter.id)-\(page.id)")
                                    .transition(pageTransition)
                            }.clipped()
                        }
                    }
                    .onAppear {
                        pageCount = pages.count
                        if let source = pendingSource {
                            pageIndex = pages.firstIndex { page in page.segments.contains {
                                $0.paragraph == source.paraIndex && $0.start <= (source.start ?? 0) && $0.start + $0.text.utf16.count > (source.start ?? 0)
                            }} ?? 0
                            pendingSource = nil
                        } else if openPreviousAtEnd {
                            pageIndex = pages.count - 1
                            openPreviousAtEnd = false
                        }
                    }
                    .onChange(of: pages.count) { _, count in
                        let fraction = Double(pageIndex) / Double(max(pageCount, 1))
                        pageIndex = min(max(0, Int(fraction * Double(count))), max(0, count - 1))
                        pageCount = count
                    }
                }
                .background(paper)
            } else if !loading {
                ContentUnavailableView {
                    Label("章节暂不可用", systemImage: "wifi.exclamationmark")
                } actions: { Button("重试") { Task { await load() } } }
            }
        }
        .background(paper.ignoresSafeArea())
        .navigationTitle(controlsVisible ? book.title : "")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar(.visible, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        .statusBarHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                if controlsVisible {
                    Button { dismiss() } label: { Image(systemName: "chevron.left") }
                        .accessibilityLabel("返回书籍")
                }
            }
            if controlsVisible {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { showingContents = true } label: { Image(systemName: "list.bullet") }
                        .accessibilityLabel("目录")
                    Button { showingAppearance = true } label: { Image(systemName: "textformat.size") }
                        .accessibilityLabel("阅读设置")
                    Button { recalling.toggle() } label: { Image(systemName: recalling ? "eye.slash" : "eye") }
                        .accessibilityLabel("遮挡或显示摘录")
                    Button { asking = true } label: { Image(systemName: "sparkles") }
                        .disabled(chapter == nil).accessibilityLabel("伴读问答")
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 8) {
                ProgressView(value: Double(index + 1), total: Double(max(chapters.count, 1)))
                    .tint(ShufangStyle.pine)
                HStack {
                    Button {
                        turnPage(-1)
                    } label: { Label("上一页", systemImage: "chevron.left") }
                        .disabled((index <= 0 && pageIndex <= 0) || loading)
                    Spacer()
                    Text("\(index + 1) / \(chapters.count) 章 · \(pageIndex + 1) / \(pageCount) 页")
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    Spacer()
                    Button {
                        turnPage(1)
                    } label: { Label("下一页", systemImage: "chevron.right") }
                        .disabled((index >= chapters.count - 1 && pageIndex >= pageCount - 1) || loading)
                }.font(.subheadline.weight(.medium))
            }
            .padding(.horizontal, 22).padding(.top, 12).padding(.bottom, 8)
            .background(.regularMaterial)
            .frame(height: 66)
            .opacity(controlsVisible ? 1 : 0)
            .allowsHitTesting(controlsVisible)
            .accessibilityHidden(!controlsVisible)
        }
        .task(id: index) { pageIndex = 0; await load() }
        .onChange(of: target) { _, source in
            guard let source else { return }
            pendingSource = source
            if let destination = chapters.firstIndex(where: { $0.id == source.chapterId }) {
                if destination == index { Task { chapter = nil; await load() } }
                else { index = destination }
            }
        }
        .sheet(item: $editingCard) { card in
            if let store = state.study { NavigationStack { CardEditor(store: store, card: card) } }
        }
        .task { scheduleHide(); beginReading() }
        .onDisappear { hideTask?.cancel(); finishReading() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { beginReading() }
            else { finishReading() }
        }
        .onReceive(Timer.publish(every: 15, on: .main, in: .common).autoconnect()) { _ in
            checkpointReading()
        }
        .onChange(of: pageIndex) { _, _ in
            footnote = nil
            if controlsVisible { scheduleHide() }
        }
        .onChange(of: generalStyle) { _, value in
            value.save("reader.style.general")
        }
        .onChange(of: bookStyle) { _, value in
            if let value { value.save("reader.style.book.\(book.id)") }
            else { UserDefaults.standard.removeObject(forKey: "reader.style.book.\(book.id)") }
        }
        .onChange(of: showingContents) { _, visible in
            if !visible && controlsVisible { scheduleHide() }
        }
        .onChange(of: showingAppearance) { _, visible in
            if !visible && controlsVisible { scheduleHide() }
        }
        .onChange(of: asking) { _, visible in
            if !visible && controlsVisible { scheduleHide() }
        }
        .sheet(item: $selection) { selected in HighlightComposer(book: book, selected: selected) }
        .sheet(item: $translationSelection) { selected in
            TranslateView(book: book, selected: selected)
        }
        .sheet(item: $askingSelection) { selected in
            AskView(book: book, chapter: selected.chapter, selectedText: selected.text, source: selected.sources.first)
        }
        .sheet(isPresented: $asking) {
            if let chapter { AskView(book: book, chapter: chapter) }
        }
        .sheet(isPresented: $showingContents) {
            NavigationStack {
                List {
                    ForEach(Array(chapters.enumerated()), id: \.element.id) { offset, item in
                        Button {
                            index = offset
                            showingContents = false
                        } label: {
                            HStack {
                                Text(item.title).foregroundStyle(ShufangStyle.ink)
                                Spacer()
                                if offset == index { Image(systemName: "checkmark").foregroundStyle(ShufangStyle.pine) }
                            }
                        }
                    }
                }
                .navigationTitle("目录")
                .toolbar { Button("完成") { showingContents = false } }
            }
        }
        .sheet(isPresented: $showingAppearance) {
            ReaderAppearanceView(general: $generalStyle, book: $bookStyle,
                                 bookTitle: self.book.title)
        }
    }
    private func beginReading() {
        guard scenePhase == .active, activeReading == nil,
              let history = state.readingHistory else { return }
        let now = Date().timeIntervalSince1970 * 1000
        activeReading = ReadingSession(id: history.replicaID + "." + UUID().uuidString.lowercased(),
            bookId: book.id, startedAt: now, endedAt: now)
    }
    private func checkpointReading() {
        guard var item = activeReading else { return }
        item.endedAt = max(item.startedAt, Date().timeIntervalSince1970 * 1000)
        activeReading = item
        state.readingHistory?.record(item)
    }
    private func finishReading() {
        checkpointReading()
        activeReading = nil
    }
    private var pageTransition: AnyTransition {
        guard !reduceMotion else { return .identity }
        switch style.effect {
        case .none: return .identity
        case .fade: return .opacity
        case .slide:
            let incoming: Edge = style.flow == .vertical ? (forward ? .bottom : .top) : (forward ? .trailing : .leading)
            let outgoing: Edge = style.flow == .vertical ? (forward ? .top : .bottom) : (forward ? .leading : .trailing)
            return .asymmetric(insertion: .move(edge: incoming), removal: .move(edge: outgoing))
        }
    }
    private func pageBody(_ page: ReaderPage, chapter: Chapter, size: CGSize) -> some View {
                    VStack(alignment: .leading, spacing: 0) {
                        if page.id == 0 {
                            Text(book.title.uppercased())
                                .font(.caption2.weight(.medium)).tracking(2)
                                .foregroundStyle(ink.opacity(0.55)).padding(.bottom, 18)
                            Text(chapter.title)
                                .font(Font(style.font(size: 29, weight: 600)))
                                .foregroundStyle(ink).padding(.bottom, 34)
                        }
                        let segments = page.segments.map { StudyTextSegment(paragraph: $0.paragraph, start: $0.start, text: $0.text) }
                        let pageText = page.segments.map(\.text).joined(separator: "\n")
                        let marks = (state.study?.cards ?? []).filter { $0.bookId == book.id && $0.chapterId == chapter.id }.flatMap { card in
                            (card.sourceRanges ?? [card.source]).compactMap { source -> ReaderMark? in
                                guard let range = StudyTextSelection.range(source: source, segments: segments) else { return nil }
                                return ReaderMark(id: card.id, range: range, style: card.style ?? StudyStyle())
                            }
                        }
                        SelectableReaderText(text: pageText, style: style, color: UIColor(ink),
                            marks: marks,
                            footnotes: ReaderFootnote.visible(chapter.footnotes ?? [], segments: segments),
                            onFootnote: { note, rect in footnotePage = page.id; footnoteAnchor = rect; footnote = note },
                            recall: recalling,
                            onMark: { id in editingCard = state.study?.cards.first { $0.id == id } },
                            onSelectionChange: { selectingText = $0 },
                            onAction: { action, range in
                                let sources = StudyTextSelection.sources(segments: segments, range: range,
                                    bookId: book.id, chapterId: chapter.id, chapterTitle: chapter.title)
                                guard let first = sources.first else { return }
                                let selected = SelectedParagraph(chapter: chapter, index: first.paraIndex ?? 0,
                                    text: (pageText as NSString).substring(with: range), start: first.start ?? 0, sources: sources)
                                switch action {
                                case .highlight: selection = selected
                                case .translate: translationSelection = selected
                                case .ask: askingSelection = selected
                                }
                            }, onTap: { location in
                                if style.flow == .scroll { toggleControls(); return }
                                let position = style.flow == .vertical ? location.y : location.x
                                if position < 0.28 { turnPage(-1) }
                                else if position > 0.72 { turnPage(1) }
                                else { toggleControls() }
                            }, onPageTurn: { turnPage($0) })
                            .popover(item: Binding(get: { footnotePage == page.id ? footnote : nil }, set: { footnote = $0 }), attachmentAnchor: .rect(.rect(footnoteAnchor))) { note in
                                VStack(alignment: .leading, spacing: 12) {
                                    HStack {
                                        Text("注释 \(note.label)").font(.headline)
                                        Spacer()
                                        Button { footnote = nil } label: { Image(systemName: "xmark.circle.fill") }
                                            .accessibilityLabel("关闭注释")
                                    }
                                    ScrollView {
                                        Text(verbatim: note.content).frame(maxWidth: .infinity, alignment: .leading)
                                            .textSelection(.enabled)
                                    }
                                }.padding().frame(width: min(320, size.width - 40), height: 280)
                                    .presentationCompactAdaptation(.popover)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityHint("长按并拖动选取文字，可跨段摘录、翻译或询问 AI")
                        if chapter.paragraphs.isEmpty {
                            ContentUnavailableView("本章没有可重排的文字", systemImage: "text.book.closed")
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, style.inset(for: size.width))
                    .padding(.top, page.id == 0 ? 28 : 8)
                    .padding(.bottom, 24)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background {
                        Color.clear.contentShape(Rectangle())
                            .onTapGesture { toggleControls() }
                            .gesture(DragGesture(minimumDistance: 35).onEnded { value in
                                guard !selectingText else { return }
                                if let direction = style.flow.turn(horizontal: value.translation.width, vertical: value.translation.height) {
                                    turnPage(direction)
                                }
                            }, including: style.flow == .scroll ? .none : .all)
                    }
                    .accessibilityAction(named: "下一页") { turnPage(1) }
                    .accessibilityAction(named: "上一页") { turnPage(-1) }
                    .accessibilityAction(named: "阅读设置") { showingAppearance = true }
                    .accessibilityAction(named: "显示或隐藏菜单") { toggleControls() }
    }
    private func turnPage(_ direction: Int) {
        guard chapter != nil, !loading else { return }
        forward = direction > 0
        let animation: Animation? = reduceMotion || style.effect == .none || style.flow == .scroll ? nil : .easeInOut(duration: 0.24)
        withAnimation(animation) {
        if direction > 0 {
            if pageIndex + 1 < pageCount { pageIndex += 1 }
            else if index + 1 < chapters.count { index += 1 }
        } else if pageIndex > 0 {
            pageIndex -= 1
        } else if index > 0 {
            openPreviousAtEnd = true
            index -= 1
        }
        }
    }
    private func toggleControls() {
        withAnimation(.easeInOut(duration: 0.2)) { controlsVisible.toggle() }
        if controlsVisible { scheduleHide() }
        else { hideTask?.cancel() }
    }
    private func scheduleHide() {
        hideTask?.cancel()
        hideTask = Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled, !showingContents,
                  !showingAppearance, !asking, askingSelection == nil else { return }
            withAnimation(.easeInOut(duration: 0.2)) { controlsVisible = false }
        }
    }
    private func load() async {
        guard let client = state.client else { return }
        let requestedIndex = index, session = state.sessionID
        let offline = state.offline
        footnote = nil
        loading = true; chapter = nil; error = nil
        defer { loading = false }
        if let cached = await offline?.chapter(bookID: book.id, index: requestedIndex) {
            guard index == requestedIndex else { return }
            chapter = cached
            UserDefaults.standard.set(index, forKey: state.progressKey(book: book.id))
            Task { try? await client.saveProgress(book: book.id, chapter: cached.id) }
            // Earlier versions discarded footnotes when saving offline books.
            // Display cached text immediately and fill metadata when online.
            if cached.footnotes == nil {
                loading = false
                do {
                    let fresh: Chapter = try await client.request(["books", book.id, "chapters", String(requestedIndex)])
                    try Task.checkCancellation()
                    guard state.sessionID == session, index == requestedIndex else { return }
                    if let refreshed = try await offline?.refreshFootnotes(bookID: book.id, chapter: fresh),
                       state.sessionID == session, index == requestedIndex { chapter = refreshed }
                } catch { /* A failed metadata refresh must not interrupt offline reading. */ }
            }
            return
        }
        do {
            let result: Chapter = try await client.request(["books", book.id, "chapters", String(requestedIndex)])
            try Task.checkCancellation()
            guard index == requestedIndex else { return }
            chapter = result
            UserDefaults.standard.set(index, forKey: state.progressKey(book: book.id))
            do { try await client.saveProgress(book: book.id, chapter: result.id) }
            catch { self.error = "章节已加载，但阅读进度未同步：" + error.localizedDescription }
        } catch is CancellationError { } catch { self.error = error.localizedDescription }
    }
}

private struct ReaderAppearanceView: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var general: ReaderStyle
    @Binding var book: ReaderStyle?
    let bookTitle: String
    @State private var scope: Scope

    private enum Scope: String, CaseIterable { case general = "通用排版", book = "本书专用" }

    init(general: Binding<ReaderStyle>, book: Binding<ReaderStyle?>, bookTitle: String) {
        _general = general
        _book = book
        self.bookTitle = bookTitle
        _scope = State(initialValue: book.wrappedValue == nil ? .general : .book)
    }
    private var value: ReaderStyle { scope == .book ? (book ?? general) : general }
    private func update(_ change: (inout ReaderStyle) -> Void) {
        var next = value
        change(&next)
        if scope == .book { book = next } else { general = next }
    }
    private func binding(_ field: WritableKeyPath<ReaderStyle, Double>) -> Binding<Double> {
        Binding(get: { value[keyPath: field] },
                set: { newValue in update { $0[keyPath: field] = newValue } })
    }
    private func slider(_ label: String, field: WritableKeyPath<ReaderStyle, Double>,
                        range: ClosedRange<Double>, step: Double,
                        format: @escaping (Double) -> String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(label)
                Spacer()
                Text(format(value[keyPath: field])).monospacedDigit().foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                Button {
                    update { $0[keyPath: field] = max(range.lowerBound,
                        ($0[keyPath: field] - step).rounded(to: step)) }
                } label: { Image(systemName: "minus.circle") }
                    .accessibilityLabel("\(label)减少")
                Slider(value: binding(field), in: range, step: step)
                    .accessibilityLabel(label)
                Button {
                    update { $0[keyPath: field] = min(range.upperBound,
                        ($0[keyPath: field] + step).rounded(to: step)) }
                } label: { Image(systemName: "plus.circle") }
                    .accessibilityLabel("\(label)增加")
            }
        }
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("设置范围", selection: $scope) {
                        ForEach(Scope.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }.pickerStyle(.segmented)
                    if scope == .book {
                        if book != nil {
                            Button("恢复通用排版") { book = nil }
                        } else {
                            Text("首次调整后，《\(bookTitle)》将使用专用排版。")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                Section("预览") {
                    Text("学而时习之，不亦说乎。\n温故而知新，可以为师矣。")
                        .font(Font(value.font()))
                        .fontWeight(value.fontWeight >= 600 ? .semibold :
                                    value.fontWeight <= 300 ? .light : .regular)
                        .lineSpacing(value.lineSpacing(for: value.font()))
                        .tracking(value.letterSpacing * value.fontSize)
                        .foregroundStyle(value.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(18)
                        .background(value.background, in: RoundedRectangle(cornerRadius: 12))
                }
                Section("字体") {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 8) {
                        ForEach(ReaderStyle.fonts.indices, id: \.self) { index in
                            let item = ReaderStyle.fonts[index]
                            Button(item.1) { update { $0.fontId = item.0 } }
                                .font(.subheadline)
                                .frame(maxWidth: .infinity, minHeight: 38)
                                .background(value.fontId == item.0 ? Color.accentColor.opacity(0.15) :
                                            Color.secondary.opacity(0.08),
                                            in: RoundedRectangle(cornerRadius: 9))
                                .overlay(RoundedRectangle(cornerRadius: 9)
                                    .stroke(value.fontId == item.0 ? Color.accentColor : .clear))
                        }
                    }.buttonStyle(.plain)
                }
                Section("文字") {
                    slider("字号", field: \.fontSize, range: 14...26, step: 1) { "\(Int($0)) 点" }
                    HStack {
                        Text("粗细")
                        Spacer()
                        Picker("粗细", selection: Binding(get: { value.fontWeight },
                                                       set: { weight in update { $0.fontWeight = weight } })) {
                            Text("细").tag(300)
                            Text("常").tag(400)
                            Text("粗").tag(600)
                        }.pickerStyle(.segmented).frame(width: 180)
                    }
                    slider("行间距", field: \.lineHeight, range: 1.4...2.6, step: 0.1) {
                        String(format: "%.1f", $0)
                    }
                    slider("段间距", field: \.paragraphSpacing, range: 0...3, step: 0.1) {
                        String(format: "%.1f em", $0)
                    }
                    slider("字间距", field: \.letterSpacing, range: 0...0.12, step: 0.01) {
                        "\(Int(($0 * 100).rounded()))%"
                    }
                }
                Section("翻页") {
                    Picker("阅读方式", selection: Binding(get: { value.flow }, set: { flow in update { $0.readingFlow = flow } })) {
                        ForEach(ReaderFlow.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                    if value.flow != .scroll {
                        Picker("翻页效果", selection: Binding(get: { value.effect }, set: { effect in update { $0.pageEffect = effect } })) {
                            ForEach(ReaderTurnEffect.allCases, id: \.self) { Text($0.title).tag($0) }
                        }
                        Text(value.flow == .vertical ? "上下滑动，或轻点正文上部／下部翻页。" : "左右滑动，或轻点正文两侧翻页。")
                            .font(.footnote).foregroundStyle(.secondary)
                    } else {
                        Text("上下连续滚动本章；使用上一页／下一页按钮可跨章。轻点正文显示菜单。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section("页面") {
                    slider("正文宽度", field: \.contentWidthPercent, range: 50...100, step: 2) {
                        "\(Int($0))%"
                    }
                    Text("按当前阅读区域的宽度自动调整，适应横竖屏和分屏；100% 使用全部可用宽度。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("背景") {
                    HStack(spacing: 8) {
                        ForEach(ReaderStyle.themes.indices, id: \.self) { index in
                            let item = ReaderStyle.themes[index]
                            Button {
                                update { $0.themeId = item.0 }
                            } label: {
                                VStack(spacing: 3) {
                                    Text("文").font(.title3)
                                    Text(item.1).font(.caption)
                                }
                                .foregroundStyle(item.3)
                                .frame(maxWidth: .infinity, minHeight: 62)
                                .background(item.2, in: RoundedRectangle(cornerRadius: 10))
                                .overlay(RoundedRectangle(cornerRadius: 10)
                                    .stroke(value.themeId == item.0 ? Color.accentColor : .clear,
                                            lineWidth: 2))
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }
            .navigationTitle("阅读排版")
            .toolbar { Button("完成") { dismiss() } }
        }
    }
}

private struct TranslationRequest: Encodable {
    let text: String
    let targetLang: String
    let mode = "passage"
    let bookExtId: String
    let bookTitle: String
    let chapterTitle: String
}
private struct TranslationResult: Decodable { let translation: String }

struct TranslateView: View {
    let book: Book
    let selected: SelectedParagraph
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var targetLang = "中文"
    @State private var translated = ""
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section("原文") { Text(selected.text).textSelection(.enabled) }
                Section("译入语言") {
                    Picker("语言", selection: $targetLang) {
                        ForEach(["中文", "English", "日本語", "Français", "Deutsch"], id: \.self) {
                            Text($0)
                        }
                    }
                }
                Button(busy ? "正在翻译…" : "翻译并保存") {
                    Task { await translate() }
                }.disabled(busy || selected.text.utf16.count > 120_000)
                ErrorBanner(message: error)
                if !translated.isEmpty {
                    Section("译文") { Text(translated).textSelection(.enabled) }
                }
            }
            .navigationTitle("段落翻译")
            .toolbar { Button("完成") { dismiss() }.disabled(busy) }
            .interactiveDismissDisabled(busy)
        }
    }
    private func translate() async {
        guard !busy, let client = state.client else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            let body = TranslationRequest(text: selected.text, targetLang: targetLang,
                bookExtId: book.id, bookTitle: book.title,
                chapterTitle: selected.chapter.title)
            let result: TranslationResult = try await client.request(["translate"],
                method: "POST", body: JSONEncoder().encode(body), timeout: 240)
            translated = result.translation
        } catch { self.error = error.localizedDescription }
    }
}
struct HighlightComposer: View {
    let book: Book
    let selected: SelectedParagraph
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @State private var review = false
    @State private var busy = false
    @State private var error: String?
    @State private var extId = UUID().uuidString
    var body: some View {
        NavigationStack {
            Form {
                Section("原文 · \(selected.chapter.title)") { Text(selected.text).textSelection(.enabled) }
                Section("批注") { TextEditor(text: $note).frame(minHeight: 120) }
                Toggle("加入复习", isOn: $review)
                Button(busy ? "保存中…" : "保存到书房") { Task { await save() } }
                    .disabled(busy || note.utf16.count > 20_000)
                    .accessibilityIdentifier("saveHighlight")
                ErrorBanner(message: error)
            }
            .navigationTitle("保存摘录")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "保存中…" : "保存") { Task { await save() } }
                        .disabled(busy || note.utf16.count > 20_000)
                }
            }.interactiveDismissDisabled(busy)
        }
    }
    private func save() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        do {
            guard let store = state.study else { throw StudyError.unavailable }
            var card = StudyCard(id: extId, bookId: book.id, chapterId: selected.chapter.id,
                chapterTitle: selected.chapter.title, text: selected.text,
                paraIndex: selected.index, start: selected.start, end: selected.end,
                style: StudyStyle(), note: note, review: review ? .new() : nil)
            card.sourceRanges = selected.sources.isEmpty ? nil : selected.sources
            try store.save(card)
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
struct AskView: View {
    let book: Book
    let chapter: Chapter
    var selectedText: String? = nil
    var source: StudySource? = nil
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var question = ""
    @State private var answer = ""
    @State private var busy = false
    @State private var error: String?
    @State private var answeringWith = ""
    @State private var saved = false
    @State private var cardDraft: StudyCard?
    private var localModelReady: Bool {
        if #available(iOS 26.0, *) { return SystemLanguageModel.default.isAvailable }
        return false
    }
    var body: some View {
        NavigationStack {
            Form {
                if let selectedText, !selectedText.isEmpty {
                    Section("所选原文") { Text(selectedText).textSelection(.enabled) }
                }
                Section("向伴读提问") {
                    TextField("想理解哪一处？", text: $question, axis: .vertical).lineLimit(3...8)
                    Button(busy ? "正在思考…" : "提问") { Task { await ask() } }
                        .disabled(busy || question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || question.utf16.count > 20_000)
                }
                Section {
                    Text(answeringWith.isEmpty
                         ? (localModelReady ? "优先使用设备端模型；不可用时使用当前服务器的 AI 服务。" : "使用当前服务器的 AI 服务。")
                         : answeringWith)
                }.font(.caption)
                ErrorBanner(message: error)
                if !answer.isEmpty {
                    Section("回答") { Text(answer).textSelection(.enabled) }
                    Section("保留学习成果") {
                        Button("编辑并保存为学习卡片") { cardDraft = draftCard() }
                        Button(saved ? "已保存笔记" : "保存为来源笔记") { saveAnswer(asMap: false) }.disabled(saved)
                        Button("生成脑图草稿并保存") { saveAnswer(asMap: true) }
                        Text("草稿保留所选原文和问题；可在学习页继续编辑。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }.navigationTitle("伴读")
                .toolbar { Button("完成") { dismiss() }.disabled(busy) }
                .interactiveDismissDisabled(busy)
                .sheet(item: $cardDraft) { card in
                    if let store = state.study { NavigationStack { CardEditor(store: store, card: card) } }
                }
        }
    }
    private func draftCard() -> StudyCard {
        let text = selectedText ?? String(chapter.paragraphs.first?.prefix(500) ?? "")
        return StudyCard(bookId: book.id, chapterId: chapter.id, chapterTitle: chapter.title,
            text: text.isEmpty ? question : text, paraIndex: source?.paraIndex,
            start: source?.start, end: source?.end, pdfAnchor: source?.pdfAnchor,
            style: StudyStyle(), name: question, note: answer,
            aiQa: [StudyQA(q: question, a: answer, ts: Date().timeIntervalSince1970 * 1000)])
    }
    private func saveAnswer(asMap: Bool) {
        guard let store = state.study else { return }
        do {
            var card = draftCard()
            if asMap {
                try store.save(card)
                let lines = answer.split(separator: "\n").map(String.init).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
                let children = lines.prefix(12).map { StudyMindNode(text: $0, sourceHighlightId: card.id) }
                try store.save(StudyMindMap(title: question, bookId: book.id,
                    root: StudyMindNode(text: question, children: children, sourceHighlightId: card.id)))
            } else {
                let note = StudyNote(title: question, content: "《\(book.title)》 · \(chapter.title)\n\n> \(card.text)\n\n\(answer)")
                card.noteId = note.id
                try store.save(note); try store.save(card)
            }
            saved = true; error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func ask() async {
        guard let client = state.client else { return }
        busy = true; error = nil; saved = false; defer { busy = false }
        var localFailure: Error?
        do {
            if #available(iOS 26.0, *), localModelReady {
                do {
                    answeringWith = "设备端模型 · 本次请求不发送到服务器"
                    let context = String(chapter.paragraphs.joined(separator: "\n").prefix(1_800))
                    let excerpt = String((selectedText ?? "").prefix(600))
                    let session = LanguageModelSession {
                        "你是中文阅读伴读助手。依据给出的原文回答，简洁准确；没有依据时明确说明。"
                    }
                    let prompt = """
                    书名：《\(book.title)》；章节：\(chapter.title)
                    \(excerpt.isEmpty ? "" : "所选原文：\n\(excerpt)\n")
                    章节节选：
                    \(context)

                    问题：\(question)
                    """
                    answer = try await session.respond(to: prompt).content
                    return
                } catch {
                    localFailure = error
                }
            }
            let joined = chapter.paragraphs.joined(separator: "\n")
            answeringWith = "服务器模型 · 使用当前书房服务器的 AI 服务"
            var context = String(joined.prefix(30_000))
            while context.utf16.count > 30_000 { context.removeLast() }
            let body = AskWrite(question: question, title: book.title,
                chapterTitle: chapter.title, chapterContext: context,
                selection: selectedText ?? "")
            let result: AskResponse = try await client.request(["ask"], method: "POST", body: JSONEncoder().encode(body), timeout: 240)
            answer = result.answer
        } catch APIError.http(500) {
            self.error = localFailure.map {
                "设备端 AI 未能回答：\($0.localizedDescription)。服务器 AI 也未配置好。"
            } ?? "设备端模型不可用，服务器 AI 也未配置好。请启用 Apple Intelligence 或配置服务器 AI。"
        } catch { self.error = error.localizedDescription }
    }
}

// PDF bytes use the same authenticated, redirect-refusing session as JSON calls.
// Keep the document in memory; disconnecting destroys the session's view tree.
import PDFKit

struct PDFSourceView: View {
    let book: Book
    @EnvironmentObject private var state: AppState
    @State private var document: PDFDocument?
    @State private var loading = false
    @State private var error: String?
    var body: some View {
        VStack {
            ErrorBanner(message: error)
            if let document { NativePDFView(document: document) }
            else if loading { ProgressView("下载 PDF 原文…") }
            else { Button("重新下载") { Task { await load() } } }
        }
        .navigationTitle(book.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }
    private func load() async {
        guard !loading, let client = state.client else { return }
        loading = true; error = nil
        defer { loading = false }
        if let bytes = await state.offline?.pdf(bookID: book.id),
           let pdf = PDFDocument(data: bytes) {
            document = pdf
            return
        }
        do {
            let bytes = try await client.data(["books", book.id, "source"], timeout: 120)
            try Task.checkCancellation()
            guard let pdf = PDFDocument(data: bytes) else { throw APIError.invalidResponse }
            document = pdf
        } catch is CancellationError { }
        catch { self.error = "无法打开原文，请确认网页端已上传 PDF。" + error.localizedDescription }
    }
}
private struct NativePDFView: UIViewRepresentable {
    let document: PDFDocument
    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.document = document
        return view
    }
    func updateUIView(_ view: PDFView, context: Context) {
        if view.document !== document { view.document = document }
    }
}
