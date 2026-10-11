import AppKit
import SwiftUI
import ShufangMacCore

struct RecordEditor: View {
    @ObservedObject var model: LibraryModel
    @State private var markdown = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            switch model.section {
            case .books: BookPane(model: model)
            case .notes:
                TextField("笔记标题", text: $model.title).font(.title2)
                Toggle("预览 Markdown", isOn: $markdown)
                if markdown { ScrollView { Text(LocalizedStringKey(model.content.replacingOccurrences(of: "(?s)<!--.*?-->", with: "", options: .regularExpression))).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) } }
                else { TextEditor(text: $model.content).accessibilityLabel("笔记正文") }
                ForEach(model.noteHighlights) { highlight in
                    if let book = model.books.first(where: { $0.id == highlight.value["bookId"] as? String }) {
                        Button("引用原文：\(book.title) — \(String((highlight.value["text"] as? String ?? "").prefix(40)))") {
                            model.openHit(["kind": "books", "record": ["revision": book.revision, "value": book.value], "anchor": highlight.value])
                        }
                    }
                }
            case .folders: TextField("文件夹名称", text: $model.title).font(.title2); Spacer()
            case .studySets:
                TextField("学习集名称", text: $model.title).font(.title2)
                Text("收录书籍")
                List(model.books) { book in
                    Toggle(book.title, isOn: Binding(get: { model.selectedBooks.contains(book.id) }, set: { enabled in
                        if enabled { model.selectedBooks.insert(book.id) } else { model.selectedBooks.remove(book.id) }
                    }))
                }
                Button("复习此学习集") {
                    let id = model.record?.id
                    guard model.confirmDiscard() else { return }
                    model.section = .review
                    model.start("载入复习") { try await model.loadReview(id) }
                }.disabled(model.record == nil)
            case .mindMaps:
                TextField("脑图标题", text: $model.title).font(.title2)
                ScrollView { MindNodeEditor(node: $model.mapRoot, depth: 0) }
            case .translations:
                Text("已保存译文").font(.title2)
                Text(model.record?.value["targetLang"] as? String ?? "")
                TextEditor(text: $model.content)
                if let record = model.record, let book = model.books.first(where: { $0.id == record.value["bookId"] as? String }) {
                    Button("跳转到原文") { model.openHit(["kind": "books", "record": ["revision": book.revision, "value": book.value], "anchor": record.value]) }
                }
            case .highlights: HighlightPane(model: model)
            case .associations: AssociationPane(model: model)
            default: EmptyView()
            }
        }.padding().disabled(!model.ready || model.busy)
    }
}

struct MindNodeEditor: View {
    @Binding var node: [String: Any]
    let depth: Int
    private var children: [[String: Any]] { node["children"] as? [[String: Any]] ?? [] }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                TextField("主题", text: Binding(get: { node["text"] as? String ?? "" }, set: { node["text"] = $0 }))
                Button { var items = children; items.append(["id": UUID().uuidString, "text": "新主题", "children": [[String: Any]]()]); node["children"] = items } label: { Image(systemName: "plus") }
                    .help("添加子主题").disabled(depth >= 64)
            }
            ForEach(children.indices, id: \.self) { index in
                HStack(alignment: .top) {
                    MindNodeEditor(node: Binding(get: { children.indices.contains(index) ? children[index] : [:] }, set: { value in
                        var items = children; guard items.indices.contains(index) else { return }; items[index] = value; node["children"] = items
                    }), depth: depth+1)
                    Button { var items = children; items.remove(at: index); node["children"] = items } label: { Image(systemName: "minus.circle") }.help("移除主题")
                }.padding(.leading, 22)
            }
        }.padding(.vertical, 3)
    }
}

struct BookPane: View {
    @ObservedObject var model: LibraryModel
    @State private var showAI = false
    @State private var showInk = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("书名", text: $model.title).font(.title2)
            HStack {
                TextField("作者", text: $model.author)
                Picker("文件夹", selection: $model.folderID) {
                    Text("未分类").tag("")
                    ForEach(model.folders) { folder in Text(folder.title).tag(folder.id) }
                }.frame(width: 220)
            }
            if let book = model.record {
                HStack {
                    Picker("章节", selection: Binding(get: { model.chapterIndex }, set: { model.checkpoint($0) })) {
                        ForEach(model.chapters.indices, id: \.self) { index in Text(model.chapters[index]["title"] as? String ?? "章节").tag(index) }
                    }
                    Button("批注所选内容") { model.annotate() }.disabled(model.passage == nil)
                    Button("关联所选内容") { model.associatePassage() }.disabled(model.passage == nil)
                    if model.pdfURL != nil { Button("手写") { showInk = true } }
                    Button("AI") { model.start("载入 AI 设置") { try await model.loadAI(); showAI = true } }
                }
                if let url = model.pdfURL {
                    PDFReader(url: url, index: model.chapterIndex, book: book.id,
                              chapterIDs: model.chapters.compactMap { $0["id"] as? String }, highlights: model.bookHighlights,
                              selection: { model.passage = $0 }, page: { index in if index != model.chapterIndex { model.checkpoint(index) } })
                } else if model.chapters.indices.contains(model.chapterIndex) {
                    let chapter = model.chapters[model.chapterIndex]
                    let paragraphs = chapter["paragraphs"] as? [String] ?? []
                    TextReader(paragraphs: paragraphs, paragraph: model.paragraphPosition, source: model.passage, position: { model.visibleParagraph($0) }) { range in
                        model.passage = TextSelection.anchor(book: book.id, chapter: chapter["id"] as? String ?? "", paragraphs: paragraphs, range: range)
                    }
                } else { Text("暂无正文，请先导入书籍。").foregroundStyle(.secondary) }
            } else { Text("选择书籍开始阅读，或使用工具栏导入。").foregroundStyle(.secondary); Spacer() }
        }
        .sheet(isPresented: $showAI) { AIPane(model: model).frame(width: 720, height: 600) }
        .sheet(isPresented: $showInk) { InkPane(model: model).frame(width: 850, height: 750) }
    }
}

struct HighlightPane: View {
    @ObservedObject var model: LibraryModel
    var body: some View {
        if let record = model.record {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(record.value["text"] as? String ?? "").textSelection(.enabled)
                    TextField("卡片名称", text: $model.title)
                    TextEditor(text: $model.content).frame(minHeight: 120).accessibilityLabel("批注说明")
                    Button("跳转到原文") {
                        let book = record.value["bookId"] as? String ?? ""
                        guard let row = model.books.first(where: { $0.id == book }) else { return }
                        model.openHit(["kind": "books", "record": ["revision": row.revision, "value": row.value], "anchor": record.value])
                    }
                    Picker("关联笔记", selection: $model.targetNote) {
                        Text("请选择").tag("")
                        ForEach(model.notes.filter { !$0.id.hasPrefix("pdfink.") }) { note in Text(note.title).tag(note.id) }
                    }
                    if record.value["noteId"] as? String != nil { Button("解除笔记引用") { model.unlinkCitation() } }
                    Button("将引用加入笔记") { model.linkCitation() }.disabled(model.targetNote.isEmpty)
                    Button(record.value["review"] == nil ? "加入复习" : "退出复习") { model.setReview(record.value["review"] == nil) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        } else { Text("选择批注查看原文与引用。").foregroundStyle(.secondary); Spacer() }
    }
}

struct AssociationPane: View {
    @ObservedObject var model: LibraryModel
    var body: some View {
        if let record = model.record {
            VStack(alignment: .leading, spacing: 20) {
                Text("内容关联").font(.title2)
                Picker("方向", selection: $model.associationDirection) { Text("双向").tag("bidirectional"); Text("起点到终点").tag("source-to-target") }
                Button("保存关联方向") { model.save() }
                ForEach(["source", "target"], id: \.self) { side in
                    let anchor = record.value[side] as? [String: Any] ?? [:]
                    Text(side == "source" ? "起点" : "终点").font(.headline)
                    Text(anchor["text"] as? String ?? "").textSelection(.enabled)
                    Button("跳转到原文") {
                        if let book = model.books.first(where: { $0.id == anchor["bookId"] as? String }) {
                            model.openHit(["kind": "books", "record": ["revision": book.revision, "value": book.value], "anchor": anchor])
                        }
                    }
                }
                Spacer()
            }
        } else { Text("阅读时选择两段内容，分别点击关联即可建立联系。").foregroundStyle(.secondary); Spacer() }
    }
}
