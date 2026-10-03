import SwiftUI
import CryptoKit

/// Double links stay plain text on disk and resolve against stable note IDs or titles.
enum StudyNoteLinks {
    struct Link: Hashable, Identifiable {
        let target: String
        let label: String
        var id: String { target + "|" + label }
    }
    static func links(in content: String) -> [Link] {
        guard let regex = try? NSRegularExpression(pattern: #"\[\[([^\[\]\n]+)\]\]"#) else { return [] }
        let source = content as NSString
        var seen = Set<String>()
        return regex.matches(in: content, range: NSRange(location: 0, length: source.length)).compactMap { match in
            let parts = source.substring(with: match.range(at: 1)).split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
            let target = String(parts[0]).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !target.isEmpty, seen.insert(target.lowercased()).inserted else { return nil }
            let label = parts.count > 1 ? String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines) : target
            return Link(target: target, label: label.isEmpty ? target : label)
        }
    }
    static func matches(_ link: Link, note: StudyNote) -> Bool {
        note.id.caseInsensitiveCompare(link.target) == .orderedSame || note.title.caseInsensitiveCompare(link.target) == .orderedSame
    }
}

struct NotesView: View {
    @EnvironmentObject private var state: AppState
    var body: some View {
        Group {
            if let store = state.study { StudyNotesContent(store: store) }
            else { ContentUnavailableView("请先登录书房", systemImage: "person.crop.circle") }
        }.navigationTitle("笔记")
    }
}

private struct StudyNotesContent: View {
    @ObservedObject var store: StudyStore
    @State private var creating = false
    @State private var query = ""
    @State private var deleting: StudyNote?
    @State private var error: String?
    private var notes: [StudyNote] {
        store.notes.filter { query.isEmpty || ($0.title + $0.content).localizedCaseInsensitiveContains(query) }
            .sorted { $0.updatedAt > $1.updatedAt }
    }
    var body: some View {
        List {
            ErrorBanner(message: error)
            if store.pendingCount > 0 { Label("\(store.pendingCount) 项修改已保存在本机，联网后同步", systemImage: "arrow.triangle.2.circlepath").font(.caption).foregroundStyle(.secondary) }
            ForEach(notes) { note in
                NavigationLink { StudyNoteEditor(noteID: note.id) } label: {
                    HStack(alignment: .top, spacing: 14) {
                        Image(systemName: "text.book.closed.fill").foregroundStyle(ShufangStyle.pine)
                            .frame(width: 38, height: 38).background(ShufangStyle.pine.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
                        VStack(alignment: .leading, spacing: 5) {
                            Text(note.title).font(.headline).foregroundStyle(ShufangStyle.ink)
                            Text(note.content.isEmpty ? "轻点查看与编辑" : note.content)
                                .font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }.padding(.vertical, 7)
                }.swipeActions { Button("删除", role: .destructive) { deleting = note } }
            }
            if notes.isEmpty {
                ContentUnavailableView(query.isEmpty ? "记录你的思考" : "没有匹配的笔记", systemImage: "square.and.pencil",
                    description: Text(query.isEmpty ? "写下思考，用 [[笔记标题]] 连接另一篇笔记。离线也能保存。" : "试试其他关键词。"))
            }
        }
        .scrollContentBackground(.hidden).background(ShufangStyle.paper)
        .searchable(text: $query, prompt: "笔记标题与正文")
        .refreshable { await store.sync() }
        .task { await store.sync() }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { NavigationLink { StudyTransferView() } label: { Image(systemName: "square.and.arrow.up") }.accessibilityLabel("导出与备份") }
            ToolbarItem(placement: .topBarTrailing) { Button { creating = true } label: { Image(systemName: "plus") }.accessibilityLabel("新建笔记") }
        }
        .sheet(isPresented: $creating) { NavigationStack { StudyNoteEditor(noteID: nil) } }
        .confirmationDialog("删除这篇笔记？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("删除笔记", role: .destructive) {
                guard let note = deleting else { return }
                do { try store.delete(kind: "notes", id: note.id); deleting = nil; Task { await store.sync() } }
                catch { self.error = error.localizedDescription }
            }
        } message: { Text("删除会同步到当前服务器。其他笔记中的文字链接仍会保留。") }
    }
}

// Compatibility entry point for existing search/book navigation.
struct NoteEditor: View {
    let existing: Note?
    var body: some View { StudyNoteEditor(noteID: existing?.id) }
}

struct StudyNoteEditor: View {
    let noteID: String?
    var initialTitle = ""
    @EnvironmentObject private var state: AppState
    var body: some View {
        Group {
            if let store = state.study { StudyNoteEditorContent(store: store, noteID: noteID, initialTitle: initialTitle) }
            else { ContentUnavailableView("请先登录书房", systemImage: "person.crop.circle") }
        }
    }
}

private struct StudyNoteEditorContent: View {
    @ObservedObject var store: StudyStore
    let noteID: String?
    let initialTitle: String
    @Environment(\.dismiss) private var dismiss
    @State private var note = StudyNote(title: "", content: "")
    @State private var original = StudyNote(title: "", content: "")
    @State private var loaded = false
    @State private var preview = false
    @State private var discard = false
    @State private var concurrentEdit = false
    @State private var missing = false
    @State private var error: String?
    @State private var exportURL: URL?
    private var dirty: Bool { loaded && (note.title != original.title || note.content != original.content) }
    private var valid: Bool { !note.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && note.title.utf16.count <= 255 && note.content.utf16.count <= 200_000 }
    private var links: [StudyNoteLinks.Link] { StudyNoteLinks.links(in: note.content) }
    private var backlinks: [StudyNote] {
        store.notes.filter { $0.id != note.id && StudyNoteLinks.links(in: $0.content).contains { StudyNoteLinks.matches($0, note: note) } }
    }
    var body: some View {
        Form {
            ErrorBanner(message: error)
            if missing {
                ContentUnavailableView("笔记暂不可用", systemImage: "doc.questionmark", description: Text("该笔记可能尚未同步，或已在其他设备删除。"))
                Button("重新同步") { Task { await store.sync(); load() } }
            } else {
                Section("标题") { TextField("笔记标题", text: $note.title).accessibilityIdentifier("noteTitle") }
                Section {
                    Picker("正文显示", selection: $preview) { Text("编辑").tag(false); Text("预览").tag(true) }.pickerStyle(.segmented)
                    if preview { Text(.init(note.content.isEmpty ? "暂无正文" : note.content)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                    else { TextEditor(text: $note.content).frame(minHeight: 300).accessibilityIdentifier("noteContent") }
                } header: { Text("正文") } footer: { Text("用 [[标题]] 或 [[笔记ID|显示文字]] 创建双链。保存先写入本机，联网后自动同步。") }
                if !links.isEmpty {
                    Section("链接到") {
                        ForEach(links) { link in
                            let matches = store.notes.filter { StudyNoteLinks.matches(link, note: $0) }
                            if matches.isEmpty {
                                NavigationLink { StudyNoteEditor(noteID: nil, initialTitle: link.target) } label: { Label("新建：\(link.label)", systemImage: "plus.square") }
                            } else {
                                ForEach(matches) { target in
                                    if target.id != note.id {
                                        NavigationLink { StudyNoteEditor(noteID: target.id) } label: { Label(link.label, systemImage: "link") }
                                    } else { Label("\(link.label)（当前笔记）", systemImage: "link").foregroundStyle(.secondary) }
                                }
                            }
                        }
                    }
                }
                if !backlinks.isEmpty {
                    Section("被这些笔记引用") {
                        ForEach(backlinks) { source in NavigationLink { StudyNoteEditor(noteID: source.id) } label: { Label(source.title, systemImage: "arrow.turn.up.left") } }
                    }
                }
                let cards = store.cards.filter { $0.noteId == note.id }
                if !cards.isEmpty {
                    Section("关联的原文") {
                        ForEach(cards) { card in NavigationLink { StudySourceView(source: card.source) } label: { Text(card.text).lineLimit(3) } }
                    }
                }
                Button("保存笔记") { save() }.disabled(!loaded || !valid).accessibilityIdentifier("saveNote")
                Button("导出 Markdown") { exportMarkdown() }.disabled(!loaded || !valid)
                if let exportURL { ShareLink(item: exportURL) { Label("分享 Markdown 文件", systemImage: "square.and.arrow.up") } }
            }
        }
        .navigationTitle(noteID == nil ? "新建笔记" : "编辑笔记").navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(dirty)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("关闭") { if dirty { discard = true } else { dismiss() } } }
            ToolbarItem(placement: .confirmationAction) { Button("保存") { save() }.disabled(!loaded || !valid || missing) }
        }
        .task { if !loaded { load() } }
        .interactiveDismissDisabled(dirty)
        .confirmationDialog("放弃未保存的修改？", isPresented: $discard, titleVisibility: .visible) { Button("放弃修改", role: .destructive) { dismiss() } }
        .confirmationDialog("这篇笔记已在其他位置更新", isPresented: $concurrentEdit, titleVisibility: .visible) {
            Button("另存我的副本") { persist(copy: true) }
            Button("载入最新版本") { load() }
            Button("使用我的修改", role: .destructive) { persist(copy: false) }
        } message: { Text("你编辑的字段已有新内容。可以保留双方，或选择要使用的版本。") }
    }
    private func load() {
        if let noteID {
            guard let saved = store.notes.first(where: { $0.id == noteID }) else { missing = true; return }
            note = saved
        } else { note.title = initialTitle }
        original = note; loaded = true; missing = false
    }
    private func save() {
        if let latest = store.notes.first(where: { $0.id == note.id }) {
            let titleConflict = note.title != original.title && latest.title != original.title && latest.title != note.title
            let contentConflict = note.content != original.content && latest.content != original.content && latest.content != note.content
            if titleConflict || contentConflict { concurrentEdit = true; return }
        } else if noteID != nil {
            error = "这篇笔记已在其他位置删除。请另存副本以保留修改。"
            concurrentEdit = true; return
        }
        persist(copy: false)
    }
    private func persist(copy: Bool) {
        do {
            var changed = store.notes.first(where: { $0.id == note.id }) ?? note
            if copy {
                changed = note
                changed.id = UUID().uuidString.lowercased()
                changed.createdAt = Date().timeIntervalSince1970 * 1000
                changed.title += "（副本）"
            } else {
                if note.title != original.title { changed.title = note.title }
                if note.content != original.content { changed.content = note.content }
            }
            changed.title = changed.title.trimmingCharacters(in: .whitespacesAndNewlines)
            changed.updatedAt = Date().timeIntervalSince1970 * 1000
            try store.save(changed); original = changed
            Task { await store.sync() }
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
    private func exportMarkdown() {
        do {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("笔记-\(UUID().uuidString).md")
            try Data(("# \(note.title)\n\n\(note.content)\n").utf8).write(to: url, options: .atomic)
            exportURL = url
        } catch { self.error = error.localizedDescription }
    }
}
