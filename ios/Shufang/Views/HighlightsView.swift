import SwiftUI

struct HighlightsView: View {
    @EnvironmentObject private var state: AppState
    var body: some View {
        Group {
            if let store = state.study { StudyCardList(store: store) }
            else { ProgressView("正在打开卡片盒…") }
        }.navigationTitle("卡片盒")
    }
}

struct StudyCardList: View {
    @ObservedObject var store: StudyStore
    var bookIDs: Set<String>? = nil
    var onSource: ((StudySource) -> Void)? = nil
    @State private var query = ""
    @State private var tag = ""
    @State private var creating = false
    private var scoped: [StudyCard] { store.cards.filter { bookIDs == nil || bookIDs!.contains($0.bookId) } }
    private var tags: [String] { Array(Set(scoped.flatMap { $0.tags ?? [] })).sorted() }
    private var filtered: [StudyCard] {
        scoped.filter { card in
            (tag.isEmpty || (card.tags ?? []).contains(tag)) &&
            (query.isEmpty || [card.name ?? "", card.text, card.note ?? "", (card.tags ?? []).joined(separator: " ")]
                .joined(separator: " ").localizedCaseInsensitiveContains(query))
        }.sorted { $0.createdAt > $1.createdAt }
    }
    var body: some View {
        List {
            StudySyncStatus(store: store)
            if !tags.isEmpty {
                Picker("标签", selection: $tag) {
                    Text("全部标签").tag("")
                    ForEach(tags, id: \.self) { Text($0).tag($0) }
                }
            }
            ForEach(filtered) { card in
                NavigationLink { StudyCardDetail(store: store, cardID: card.id, onSource: onSource) } label: {
                    StudyCardRow(store: store, card: card)
                }.draggable("shufang-card:" + card.id)
            }
            if filtered.isEmpty {
                ContentUnavailableView(query.isEmpty ? "留下值得重读的文字" : "没有匹配的卡片",
                    systemImage: "rectangle.stack", description: Text("阅读时选择文字或 PDF 区域，即可保存卡片。"))
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(ShufangStyle.paper)
        .searchable(text: $query, prompt: "搜索卡片、批注与标签")
        .toolbar { Button { creating = true } label: { Label("新建卡片", systemImage: "plus") } }
        .sheet(isPresented: $creating) { NavigationStack { CardEditor(store: store, card: nil) } }
        .refreshable { await store.sync() }
    }
}

struct StudySyncStatus: View {
    @ObservedObject var store: StudyStore
    var body: some View {
        if store.syncing || store.pendingCount > 0 || store.error != nil {
            Section {
                HStack(spacing: 9) {
                    if store.syncing { ProgressView() }
                    else { Image(systemName: store.error == nil ? "icloud.and.arrow.up" : "icloud.slash") }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(store.syncing ? "正在同步学习资料" : store.pendingCount > 0 ? "\(store.pendingCount) 项修改已保存在本机" : "暂时无法同步")
                            .font(.subheadline)
                        if let error = store.error { Text(error).font(.caption).foregroundStyle(.secondary).lineLimit(3) }
                    }
                    Spacer(minLength: 4)
                    if store.syncing { Button("取消") { store.cancelSync() } }
                    else { Button("重试") { Task { await store.sync() } } }
                }
            }
        }
    }
}

struct StudyCardRow: View {
    @ObservedObject var store: StudyStore
    let card: StudyCard
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            if let name = card.name, !name.isEmpty { Text(name).font(.headline).foregroundStyle(ShufangStyle.ink) }
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 2).fill(studyColor(card.style?.color)).frame(width: 4)
                Text(card.text).font(.system(.body, design: .serif)).lineSpacing(4).lineLimit(5)
            }.fixedSize(horizontal: false, vertical: true)
            if let note = card.note, !note.isEmpty { Text(note).font(.subheadline).foregroundStyle(.secondary).lineLimit(2) }
            HStack {
                Text(store.books.first { $0.id == card.bookId }?.title ?? card.chapterTitle)
                    .lineLimit(1)
                Spacer()
                if card.review != nil { Image(systemName: "rectangle.stack.badge.clock") }
                if card.pdfAnchor != nil { Text("第 \(card.pdfAnchor!.page) 页") }
            }.font(.caption).foregroundStyle(.secondary)
            if let tags = card.tags, !tags.isEmpty {
                Text(tags.map { "#" + $0 }.joined(separator: "  ")).font(.caption).foregroundStyle(ShufangStyle.pine)
            }
        }.padding(.vertical, 8)
    }
}

func studyColor(_ name: String?) -> Color {
    switch name {
    case "yellow": return .yellow
    case "green": return .green
    case "blue": return .blue
    case "purple": return .purple
    default: return .orange
    }
}

struct StudyCardDetail: View {
    @ObservedObject var store: StudyStore
    let cardID: String
    var onSource: ((StudySource) -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var editing = false
    @State private var deleting = false
    @State private var error: String?
    private var card: StudyCard? { store.cards.first { $0.id == cardID } }
    var body: some View {
        Group {
            if let card {
                List {
                    ErrorBanner(message: error)
                    Section {
                        Text(card.text).font(.system(.title3, design: .serif)).lineSpacing(7).textSelection(.enabled)
                        if let note = card.note, !note.isEmpty { Text(note).foregroundStyle(.secondary).textSelection(.enabled) }
                        if let onSource { Button("返回原文", systemImage: "text.book.closed") { onSource(card.source); dismiss() } }
                        else { NavigationLink { StudySourceView(source: card.source) } label: { Label("返回原文", systemImage: "text.book.closed") } }
                    } header: { Text(card.chapterTitle) }
                    if let tags = card.tags, !tags.isEmpty { Section("标签") { Text(tags.joined(separator: " · ")) } }
                    Section("主动回忆") {
                        if let review = card.review {
                            LabeledContent("下次复习", value: Date(timeIntervalSince1970: review.due / 1000).formatted(date: .abbreviated, time: .shortened))
                            NavigationLink { ReviewHistoryView(store: store, cardID: card.id) } label: { Label("复习记录", systemImage: "clock.arrow.circlepath") }
                            Button("暂停复习") { var changed = card; changed.review = nil; save(changed) }
                        } else {
                            Button("加入复习", systemImage: "plus.rectangle.on.rectangle") { var changed = card; changed.review = .new(); save(changed) }
                        }
                        if let cloze = card.cloze, !cloze.isEmpty { Text("挖空：" + cloze.joined(separator: "、")).font(.subheadline) }
                    }
                    if let noteID = card.noteId, let note = store.notes.first(where: { $0.id == noteID }) {
                        Section("关联笔记") { NavigationLink(note.title) { StudyNoteEditor(noteID: note.id) } }
                    }
                    if let qa = card.aiQa, !qa.isEmpty {
                        Section("伴读记录") {
                            ForEach(Array(qa.enumerated()), id: \.offset) { _, item in
                                VStack(alignment: .leading, spacing: 10) {
                                    Text(item.q).font(.headline)
                                    Text(item.a).textSelection(.enabled)
                                    Text(Date(timeIntervalSince1970: item.ts / 1000), style: .date).font(.caption).foregroundStyle(.secondary)
                                }.padding(.vertical, 5)
                            }
                        }
                    }
                    Section {
                        NavigationLink { AssociationEditor(store: store, sourceCard: card) } label: { Label("关联另一张卡片", systemImage: "link") }
                        Button("删除卡片", role: .destructive) { deleting = true }
                    }
                }.scrollContentBackground(.hidden).background(ShufangStyle.paper)
            } else { ContentUnavailableView("卡片已删除", systemImage: "rectangle.slash") }
        }.navigationTitle(card?.name?.isEmpty == false ? card!.name! : "学习卡片")
        .toolbar { if card != nil { Button("编辑") { editing = true } } }
        .sheet(isPresented: $editing) { if let card { NavigationStack { CardEditor(store: store, card: card) } } }
        .confirmationDialog("删除这张卡片？", isPresented: $deleting, titleVisibility: .visible) {
            Button("删除卡片", role: .destructive) {
                do { try store.delete(kind: "highlights", id: cardID); dismiss() } catch { self.error = error.localizedDescription }
            }
        } message: { Text("原文不会删除。脑图中的来源引用将保留为已有文字。") }
    }
    private func save(_ card: StudyCard) {
        do { try store.save(card); error = nil } catch { self.error = error.localizedDescription }
    }
}

struct CardEditor: View {
    @ObservedObject var store: StudyStore
    let card: StudyCard?
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var text = ""
    @State private var note = ""
    @State private var bookID = ""
    @State private var noteID = ""
    @State private var tags = ""
    @State private var cloze = ""
    @State private var color = "orange"
    @State private var kind = "underline"
    @State private var review = false
    @State private var loaded = false
    @State private var error: String?
    @State private var discard = false
    private var clozeItems: [String] { cloze.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
    private var invalidCloze: Bool { clozeItems.contains { !text.contains($0) } }
    private var valid: Bool { !bookID.isEmpty && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !invalidCloze && name.utf16.count <= 255 }
    var body: some View {
        Form {
            ErrorBanner(message: error)
            Section("卡片") {
                TextField("标题（可选）", text: $name)
                if card == nil {
                    Picker("来源书籍", selection: $bookID) {
                        Text("选择书籍").tag("")
                        ForEach(store.books) { Text($0.title).tag($0.id) }
                    }
                    TextEditor(text: $text).frame(minHeight: 100)
                } else { Text(text).font(.system(.body, design: .serif)).textSelection(.enabled) }
            }
            Section("批注") { TextEditor(text: $note).frame(minHeight: 130) }
            Section("整理") {
                TextField("标签，用逗号分隔", text: $tags)
                Picker("关联笔记", selection: $noteID) {
                    Text("无").tag("")
                    ForEach(store.notes) { Text($0.title).tag($0.id) }
                }
                Picker("标记方式", selection: $kind) {
                    Text("下划线").tag("underline"); Text("背景色").tag("background"); Text("文字颜色").tag("color"); Text("仅卡片").tag("none")
                }
                Picker("颜色", selection: $color) {
                    Text("橙色").tag("orange"); Text("黄色").tag("yellow"); Text("绿色").tag("green"); Text("蓝色").tag("blue"); Text("紫色").tag("purple")
                }
            }
            Section {
                Toggle("加入复习", isOn: $review)
                TextEditor(text: $cloze).frame(minHeight: 90).accessibilityLabel("挖空词句，每行一项")
                if invalidCloze { Text("每个挖空词句都需要出现在卡片原文中。请检查拼写和标点。").foregroundStyle(.red) }
                if !clozeItems.isEmpty {
                    Text(clozeItems.reduce(text) { $0.replacingOccurrences(of: $1, with: "［＿＿］") })
                        .font(.subheadline).foregroundStyle(.secondary)
                }
            } header: { Text("挖空与回忆") } footer: { Text("将需要遮挡的原文词句逐行填写。未设置挖空时，复习会遮挡整张卡片。") }
        }.navigationTitle(card == nil ? "新建卡片" : "编辑卡片")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("取消") { discard = true } }
            ToolbarItem(placement: .confirmationAction) { Button("保存", action: save).disabled(!valid) }
        }.interactiveDismissDisabled()
        .confirmationDialog("放弃编辑？", isPresented: $discard, titleVisibility: .visible) { Button("放弃修改", role: .destructive) { dismiss() } }
        .task {
            guard !loaded else { return }; loaded = true
            if let card {
                name = card.name ?? ""; text = card.text; note = card.note ?? ""; bookID = card.bookId
                noteID = card.noteId ?? ""; tags = (card.tags ?? []).joined(separator: ", "); cloze = (card.cloze ?? []).joined(separator: "\n")
                color = card.style?.color ?? "orange"; kind = card.style?.kind ?? "underline"; review = card.review != nil
            } else if let book = store.books.first { bookID = book.id }
        }
    }
    private func save() {
        var value = card.flatMap { old in store.cards.first { $0.id == old.id } } ?? card ?? StudyCard(bookId: bookID, text: text)
        let cleanTags = Array(Set(tags.components(separatedBy: CharacterSet(charactersIn: ",，\n")).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })).sorted()
        let cleanCloze = Array(Set(clozeItems)).sorted { $0.count > $1.count }
        if card == nil || name != (card?.name ?? "") { value.name = name.isEmpty ? nil : name }
        if card == nil || note != (card?.note ?? "") { value.note = note.isEmpty ? nil : note }
        if card == nil || noteID != (card?.noteId ?? "") { value.noteId = noteID.isEmpty ? nil : noteID }
        if card == nil || Set(cleanTags) != Set(card?.tags ?? []) { value.tags = cleanTags }
        if card == nil || Set(cleanCloze) != Set(card?.cloze ?? []) { value.cloze = cleanCloze }
        if card == nil || color != (card?.style?.color ?? "orange") || kind != (card?.style?.kind ?? "underline") { value.style = StudyStyle(kind: kind, color: color) }
        if card == nil || review != (card?.review != nil) { value.review = review ? (value.review ?? .new()) : nil }
        do { try store.save(value); dismiss() } catch { self.error = error.localizedDescription }
    }
}

struct ReviewView: View {
    @EnvironmentObject private var state: AppState
    var studySetID: String? = nil
    var body: some View {
        Group {
            if let store = state.study { StudyReviewSession(store: store, studySetID: studySetID) }
            else { ProgressView() }
        }.navigationTitle("复习")
    }
}
private struct StudyReviewSession: View {
    @ObservedObject var store: StudyStore
    var studySetID: String? = nil
    @State private var revealed = false
    @State private var error: String?
    @State private var sessionTime = Date().timeIntervalSince1970 * 1000
    @State private var graded: Set<String> = []
    private var cards: [StudyCard] {
        let ids = studySetID.flatMap { id in store.sets.first { $0.id == id } }.map { Set($0.bookIds) }
        return store.cards.filter { card in
            guard let review = card.review else { return false }
            return review.due <= sessionTime && !graded.contains(card.id) && (ids == nil || ids!.contains(card.bookId))
        }.sorted { $0.review!.due < $1.review!.due }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                ErrorBanner(message: error)
                Text("温故而知新").font(.system(.largeTitle, design: .serif).bold())
                Text("\(cards.count) 张待复习 · 本次已完成 \(graded.count) 张").foregroundStyle(.secondary)
                if let card = cards.first {
                    VStack(alignment: .leading, spacing: 20) {
                        Text(card.name?.isEmpty == false ? card.name! : "回忆这段文字").font(.headline)
                        Text(displayText(card)).font(.title3).lineSpacing(8).textSelection(.enabled)
                        Text(store.books.first { $0.id == card.bookId }?.title ?? card.chapterTitle).font(.caption).foregroundStyle(.secondary)
                        if revealed {
                            if let note = card.note, !note.isEmpty { Divider(); Text(note) }
                            NavigationLink("查看原文") { StudySourceView(source: card.source) }
                        } else { Button("显示答案与批注") { revealed = true }.buttonStyle(.borderedProminent) }
                    }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
                        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 20))
                    if revealed {
                        HStack {
                            ForEach(Array(["重来", "困难", "掌握", "轻松"].enumerated()), id: \.offset) { offset, label in
                                Button(label) { grade(card, rating: offset + 1) }.buttonStyle(.bordered).frame(maxWidth: .infinity)
                            }
                        }
                    }
                } else {
                    ContentUnavailableView("本次复习已完成", systemImage: "checkmark.seal", description: Text("结果已保存在本机，联网后自动同步。"))
                    Button("检查新的到期卡片") { sessionTime = Date().timeIntervalSince1970 * 1000; graded = []; revealed = false }
                }
                NavigationLink { ReviewHistoryView(store: store) } label: { Label("复习记录", systemImage: "clock.arrow.circlepath") }
            }.padding(24).frame(maxWidth: 760).frame(maxWidth: .infinity)
        }
    }
    private func displayText(_ card: StudyCard) -> String {
        if revealed { return card.text }
        guard let cloze = card.cloze?.filter({ !$0.isEmpty }), !cloze.isEmpty else { return "先回忆卡片内容，再显示答案。" }
        return cloze.sorted { $0.count > $1.count }.reduce(card.text) { $0.replacingOccurrences(of: $1, with: "［＿＿］") }
    }
    private func grade(_ card: StudyCard, rating: Int) {
        do { try store.grade(card, rating: rating); graded.insert(card.id); revealed = false; error = nil }
        catch { self.error = error.localizedDescription }
    }
}

struct ReviewHistoryView: View {
    @ObservedObject var store: StudyStore
    var cardID: String? = nil
    private var events: [StudyReviewEvent] { store.reviewEvents.filter { cardID == nil || $0.highlightId == cardID }.sorted { $0.reviewedAt > $1.reviewedAt } }
    var body: some View {
        List {
            ForEach(events) { event in
                VStack(alignment: .leading, spacing: 5) {
                    Text(store.cards.first { $0.id == event.highlightId }?.name ?? store.cards.first { $0.id == event.highlightId }?.text ?? "已删除的卡片").lineLimit(2)
                    HStack {
                        Text([1: "重来", 2: "困难", 3: "掌握", 4: "轻松"][event.rating] ?? "复习")
                        Spacer()
                        Text(Date(timeIntervalSince1970: event.reviewedAt / 1000), format: .dateTime.month().day().hour().minute())
                    }.font(.caption).foregroundStyle(.secondary)
                }.padding(.vertical, 5)
            }
            if events.isEmpty { ContentUnavailableView("还没有复习记录", systemImage: "clock") }
        }.navigationTitle("复习记录")
    }
}

private struct TranslationRecord: Decodable, Identifiable {
    var id: String { extId }
    let extId: String
    let bookTitle: String
    let chapterTitle: String
    let targetLang: String
    let text: String
    enum CodingKeys: String, CodingKey { case extId, id, bookTitle, chapterTitle, targetLang, text }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        extId = try c.decodeIfPresent(String.self, forKey: .extId)
            ?? c.decode(String.self, forKey: .id)
        bookTitle = try c.decodeIfPresent(String.self, forKey: .bookTitle) ?? ""
        chapterTitle = try c.decodeIfPresent(String.self, forKey: .chapterTitle) ?? ""
        targetLang = try c.decode(String.self, forKey: .targetLang)
        text = try c.decode(String.self, forKey: .text)
    }
}
private struct TranslationsResponse: Decodable { let translations: [TranslationRecord] }
struct TranslationsView: View {
    @EnvironmentObject private var state: AppState
    @State private var items: [TranslationRecord] = []
    @State private var loading = false
    @State private var error: String?
    var body: some View {
        List {
            ErrorBanner(message: error)
            if loading { ProgressView("正在读取译文…") }
            ForEach(items) { item in
                VStack(alignment: .leading, spacing: 9) {
                    Text(item.text).font(.system(.body, design: .serif))
                        .lineSpacing(5).textSelection(.enabled)
                    HStack {
                        Text(item.bookTitle.isEmpty ? item.chapterTitle : item.bookTitle)
                        Spacer()
                        Text(item.targetLang)
                    }.font(.caption).foregroundStyle(.secondary)
                }.padding(.vertical, 8)
            }
            if items.isEmpty && !loading && error == nil {
                ContentUnavailableView("暂无译文", systemImage: "character.book.closed",
                    description: Text("阅读时长按段落，选择翻译本段。"))
            }
        }.scrollContentBackground(.hidden).background(ShufangStyle.paper)
            .navigationTitle("译文").task { await load() }.refreshable { await load() }
    }
    private func load() async {
        guard !loading, let client = state.client else { return }
        loading = true; defer { loading = false }
        do {
            let response: TranslationsResponse = try await client.request(["translations"])
            items = response.translations; error = nil
        } catch { self.error = error.localizedDescription }
    }
}


struct StudyCardDetailView: View {
    let cardID: String
    @EnvironmentObject private var state: AppState
    var body: some View {
        Group { if let store = state.study { StudyCardDetail(store: store, cardID: cardID) } else { ProgressView() } }
    }
}
