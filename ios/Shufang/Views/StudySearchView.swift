import SwiftUI

private struct StudyTextMatch: Identifiable {
    let book: Book
    let source: StudySource
    let excerpt: String
    var id: String { source.id }
}

struct StudySearchView: View {
    @EnvironmentObject private var state: AppState
    var body: some View {
        Group {
            if let store = state.study { StudySearchContent(store: store, offline: state.offline) }
            else { ContentUnavailableView("请先登录书房", systemImage: "person.crop.circle") }
        }.navigationTitle("搜索")
    }
}

private struct StudySearchContent: View {
    @ObservedObject var store: StudyStore
    let offline: OfflineLibrary?
    @State private var query = ""
    @State private var matches: [StudyTextMatch] = []
    @State private var searching = false
    @State private var searchedBooks = 0
    @State private var truncated = false
    private var needle: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var books: [Book] { store.books.filter { ($0.title + " " + $0.author).localizedCaseInsensitiveContains(needle) } }
    private var notes: [StudyNote] { store.notes.filter { ($0.title + " " + $0.content).localizedCaseInsensitiveContains(needle) } }
    private var cards: [StudyCard] { store.cards.filter { ($0.text + " " + ($0.note ?? "") + " " + ($0.name ?? "") + " " + ($0.tags ?? []).joined(separator: " ")).localizedCaseInsensitiveContains(needle) } }
    var body: some View {
        List {
            Section {
                Label("全文检索已下载到本机的书籍；卡片与笔记可离线搜索。", systemImage: "internaldrive").font(.caption).foregroundStyle(.secondary)
                if searching { ProgressView("正在搜索正文…") }
            }
            if needle.isEmpty {
                ContentUnavailableView("连接书籍与思考", systemImage: "magnifyingglass", description: Text("搜索书名、原文、卡片、标签与笔记。"))
            } else {
                if !books.isEmpty {
                    Section("书籍 · \(books.count)") { ForEach(books) { book in NavigationLink { BookView(book: book) } label: { Label(book.title, systemImage: "books.vertical") } } }
                }
                if !matches.isEmpty {
                    Section("正文 · \(matches.count)\(truncated ? "+" : "")") {
                        ForEach(matches) { match in
                            NavigationLink { StudySourceView(source: match.source) } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(match.excerpt).lineLimit(4)
                                    Text("《\(match.book.title)》 · \(match.source.chapterTitle)").font(.caption).foregroundStyle(.secondary)
                                }.padding(.vertical, 3)
                            }
                        }
                        if truncated { Text("显示前 200 处匹配，请增加关键词缩小范围。").font(.caption).foregroundStyle(.secondary) }
                    }
                }
                if !cards.isEmpty {
                    Section("卡片 · \(cards.count)") {
                        ForEach(cards.prefix(200)) { card in
                            NavigationLink { StudyCardDetailView(cardID: card.id) } label: {
                                VStack(alignment: .leading, spacing: 5) {
                                    if let name = card.name, !name.isEmpty { Text(name).font(.headline) }
                                    Text(card.text).lineLimit(3)
                                    if let tags = card.tags, !tags.isEmpty { Text(tags.map { "#" + $0 }.joined(separator: " ")).font(.caption).foregroundStyle(.secondary) }
                                }
                            }
                        }
                    }
                }
                if !notes.isEmpty {
                    Section("笔记 · \(notes.count)") { ForEach(notes.prefix(200)) { note in NavigationLink { StudyNoteEditor(noteID: note.id) } label: {
                        VStack(alignment: .leading, spacing: 5) { Text(note.title).font(.headline); Text(note.content).lineLimit(2).foregroundStyle(.secondary) }
                    } } }
                }
                if !searching && matches.isEmpty && books.isEmpty && cards.isEmpty && notes.isEmpty {
                    ContentUnavailableView("没有找到内容", systemImage: "magnifyingglass", description: Text("已检索 \(searchedBooks) 本离线书籍。请先下载需要全文搜索的书籍，或换一个关键词。"))
                }
            }
        }
        .scrollContentBackground(.hidden).background(ShufangStyle.paper)
        .searchable(text: $query, prompt: "搜索原文、卡片、笔记与标签")
        .task { await store.sync() }
        .refreshable { await store.sync(); await searchText() }
        .task(id: needle) { await searchText() }
    }
    private func searchText() async {
        matches = []; searchedBooks = 0; truncated = false
        guard !needle.isEmpty, let offline else { searching = false; return }
        searching = true
        let searchTerm = needle
        do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
        let task = Task.detached(priority: .userInitiated) { () -> ([StudyTextMatch], Int, Bool) in
            var results: [StudyTextMatch] = []
            let downloaded = await offline.savedBooks()
            for book in downloaded {
                if Task.isCancelled { return ([], 0, false) }
                guard let package = await offline.package(for: book.id) else { continue }
                for chapter in package.contents {
                    for (index, paragraph) in chapter.paragraphs.enumerated() {
                        let text = paragraph as NSString
                        let match = text.range(of: searchTerm, options: [.caseInsensitive, .diacriticInsensitive])
                        guard match.location != NSNotFound else { continue }
                        let start = max(0, match.location - 45)
                        let length = min(text.length - start, match.length + 120)
                        let safeRange = text.rangeOfComposedCharacterSequences(for: NSRange(location: start, length: length))
                        let excerpt = (start > 0 ? "…" : "") + text.substring(with: safeRange) + (NSMaxRange(safeRange) < text.length ? "…" : "")
                        let source = StudySource(bookId: book.id, chapterId: chapter.id, chapterTitle: chapter.title, text: text.substring(with: match), paraIndex: index, start: match.location, end: NSMaxRange(match))
                        results.append(StudyTextMatch(book: book, source: source, excerpt: excerpt))
                        if results.count >= 200 { return (results, downloaded.count, true) }
                    }
                }
            }
            return (results, downloaded.count, false)
        }
        let result = await withTaskCancellationHandler(operation: { await task.value }, onCancel: { task.cancel() })
        guard !Task.isCancelled, needle == searchTerm else { return }
        matches = result.0; searchedBooks = result.1; truncated = result.2; searching = false
    }
}
