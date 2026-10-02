import SwiftUI
import UniformTypeIdentifiers

struct StudyView: View {
    @EnvironmentObject private var state: AppState
    @State private var creatingSet = false
    var body: some View {
        Group {
            if let store = state.study {
                List {
                    StudySyncStatus(store: store)
                    Section("学习工作台") {
                        NavigationLink { StudyWorkspaceView() } label: { Label("全部资料", systemImage: "rectangle.split.2x1") }
                        ForEach(store.sets) { set in
                            NavigationLink { StudyWorkspaceView(studySetID: set.id) } label: {
                                VStack(alignment: .leading, spacing: 5) {
                                    Label(set.name, systemImage: "square.stack.3d.up")
                                    Text("\(set.bookIds.count) 本书 · \(store.cards.filter { set.bookIds.contains($0.bookId) }.count) 张卡片")
                                        .font(.caption).foregroundStyle(.secondary)
                                }.padding(.vertical, 4)
                            }
                        }
                        Button("新建学习集", systemImage: "plus") { creatingSet = true }
                    }
                    Section("回忆与整理") {
                        NavigationLink { ReviewView() } label: { Label("今日复习", systemImage: "rectangle.stack.badge.clock") }
                        NavigationLink { HighlightsView() } label: { Label("卡片盒", systemImage: "rectangle.stack") }
                        NavigationLink { MindMapsView() } label: { Label("脑图", systemImage: "point.3.connected.trianglepath.dotted") }
                        NavigationLink { AssociationsView() } label: { Label("观点关联", systemImage: "link") }
                        NavigationLink { TranslationsView() } label: { Label("译文", systemImage: "character.book.closed") }
                        NavigationLink { StudyTransferView() } label: { Label("导出与恢复", systemImage: "square.and.arrow.up") }
                    }
                    if !store.conflicts.isEmpty {
                        Section { NavigationLink { StudyConflictsView(store: store) } label: { Label("\(store.conflicts.count) 项修改需要合并", systemImage: "arrow.triangle.branch") } }
                    }
                }.scrollContentBackground(.hidden).background(ShufangStyle.paper)
                .refreshable { await store.sync() }
                .sheet(isPresented: $creatingSet) { NavigationStack { StudySetEditor(store: store, existing: nil) } }
            } else { ProgressView("正在打开学习资料…") }
        }.navigationTitle("学习")
    }
}

struct StudyWorkspaceView: View {
    var studySetID: String? = nil
    @EnvironmentObject private var state: AppState
    var body: some View {
        Group {
            if let store = state.study { StudyWorkspaceContent(store: store, studySetID: studySetID) }
            else { ProgressView() }
        }
    }
}
private struct StudyWorkspaceContent: View {
    @ObservedObject var store: StudyStore
    let studySetID: String?
    @State private var source: StudySource?
    @State private var secondSource: StudySource?
    @State private var pane = 0
    @State private var showCards = false
    @State private var editSet = false
    @State private var chooseDocument = false
    @State private var chooseComparison = false
    private var studySet: StudySet? { store.sets.first { $0.id == studySetID } }
    private var books: [Book] { store.books.filter { studySet == nil || studySet!.bookIds.contains($0.id) } }
    private var bookIDs: Set<String>? { studySet.map { Set($0.bookIds) } }
    private var activeSource: StudySource? { source ?? books.first.map { StudySource(bookId: $0.id) } }
    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                workspaceBar
                Divider()
                if geometry.size.width >= 850 {
                    HStack(spacing: 0) {
                        document.frame(maxWidth: .infinity)
                        if let secondSource {
                            Divider()
                            comparisonDocument(secondSource).frame(maxWidth: .infinity)
                        }
                    }
                    .overlay(alignment: .topTrailing) {
                        Color.clear.frame(width: 1, height: 1)
                            .popover(isPresented: $showCards, arrowEdge: .top) {
                            FloatingStudyPanel(title: pane == 2 ? "学习脑图" : "学习卡片", size: CGSize(width: geometry.size.width, height: max(0, geometry.size.height - 64)), onClose: { showCards = false }) {
                                knowledge
                            }.presentationCompactAdaptation(.popover)
                        }.padding(12)
                    }
                } else {
                    if pane == 0 {
                        VStack(spacing: 0) {
                            document.frame(maxWidth: .infinity, maxHeight: .infinity)
                            if let secondSource {
                                Divider()
                                comparisonDocument(secondSource).frame(maxWidth: .infinity, maxHeight: .infinity)
                            }
                        }
                    }
                    else { knowledge }
                }
            }
        }.navigationTitle(studySet?.name ?? "学习工作台").navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $editSet) { if let studySet { NavigationStack { StudySetEditor(store: store, existing: studySet) } } }
        .sheet(isPresented: $chooseDocument) { documentPicker(comparison: false) }
        .sheet(isPresented: $chooseComparison) { documentPicker(comparison: true) }
    }
    private var workspaceBar: some View {
        HStack {
            Button { chooseDocument = true } label: { Label("文档", systemImage: "doc.text") }
            Picker("工作区域", selection: $pane) { Text("阅读").tag(0); Text("卡片").tag(1); Text("脑图").tag(2) }.pickerStyle(.segmented).frame(maxWidth: 280)
            Spacer(minLength: 0)
            Menu {
                Button(showCards ? "关闭学习悬浮窗" : "打开学习悬浮窗", systemImage: "rectangle.on.rectangle") { showCards.toggle() }
                Button("双文档对照", systemImage: "rectangle.split.2x1") { chooseComparison = true }
                NavigationLink("复习本学习集") { ReviewView(studySetID: studySetID) }
                NavigationLink("导出与恢复") { StudyTransferView(studySetID: studySetID) }
                if studySet != nil { Button("编辑学习集", systemImage: "pencil") { editSet = true } }
            } label: { Image(systemName: "ellipsis.circle").font(.title3) }
        }.padding(.horizontal).padding(.vertical, 10)
    }
    @ViewBuilder private var document: some View {
        if let activeSource { StudySourceView(source: activeSource, showStudyCards: false).id(activeSource.id) }
        else {
            ContentUnavailableView {
                Label("选择学习资料", systemImage: "books.vertical")
            } description: { Text("把书籍加入学习集，然后在这里阅读、摘录和整理。") } actions: {
                if studySet != nil { Button("添加书籍") { editSet = true } }
            }
        }
    }
    private func comparisonDocument(_ selected: StudySource) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text("对照：" + (store.books.first { $0.id == selected.bookId }?.title ?? "文档"))
                    .font(.caption).lineLimit(1)
                Spacer()
                Button("关闭") { secondSource = nil }
                    .accessibilityLabel("关闭对照文档")
            }.padding(10)
            StudySourceView(source: selected, showStudyCards: false).id("compare:" + selected.id)
        }
    }
    @ViewBuilder private var knowledge: some View {
        if pane == 2 { StudyMapList(store: store, bookIDs: bookIDs) }
        else { StudyCardList(store: store, bookIDs: bookIDs, onSource: { source = $0; pane = 0; showCards = false }) }
    }
    private func documentPicker(comparison: Bool) -> some View {
        NavigationStack {
            List(comparison ? store.books : books) { book in
                Button {
                    let selected = StudySource(bookId: book.id)
                    if comparison { secondSource = selected; chooseComparison = false; pane = 0 }
                    else { source = selected; chooseDocument = false; pane = 0 }
                } label: { Label(book.title, systemImage: book.format == "pdf" ? "doc.richtext" : "book") }
            }.navigationTitle(comparison ? "选择对照文档" : "选择文档")
            .toolbar { Button("取消") { chooseDocument = false; chooseComparison = false } }
        }
    }
}

struct StudySetEditor: View {
    @ObservedObject var store: StudyStore
    let existing: StudySet?
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var summary = ""
    @State private var selected: Set<String> = []
    @State private var loaded = false
    @State private var error: String?
    @State private var deleting = false
    var body: some View {
        Form {
            ErrorBanner(message: error)
            Section("学习集") { TextField("名称", text: $name); TextField("学习目标", text: $summary, axis: .vertical) }
            if existing == nil {
                Section("从模板开始") {
                    Button("申论素材", systemImage: "pencil.and.list.clipboard") { name = "申论素材"; summary = "积累论点、案例和规范表达；用挖空复习关键词。" }
                    Button("论文研究", systemImage: "graduationcap") { name = "论文研究"; summary = "记录问题、方法和结论；关联支持观点、反例与待验证内容。" }
                }
            }
            Section {
                ForEach(store.books) { book in
                    Toggle(book.title, isOn: Binding(get: { selected.contains(book.id) }, set: { enabled in
                        if enabled { selected.insert(book.id) } else { selected.remove(book.id) }
                    }))
                }
            } header: { Text("包含的书籍") } footer: { Text("同一本书可以加入多个学习集，卡片保持同一份。") }
            if existing != nil { Button("删除学习集", role: .destructive) { deleting = true } }
        }.navigationTitle(existing == nil ? "新建学习集" : "编辑学习集")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) { Button("保存", action: save).disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
        }.interactiveDismissDisabled()
        .task { guard !loaded else { return }; loaded = true; if let existing { name = existing.name; summary = existing.description ?? ""; selected = Set(existing.bookIds) } }
        .confirmationDialog("删除学习集？书籍和卡片会保留。", isPresented: $deleting, titleVisibility: .visible) {
            Button("删除学习集", role: .destructive) {
                guard let existing else { return }
                do { try store.delete(kind: "studySets", id: existing.id); dismiss() } catch { self.error = error.localizedDescription }
            }
        }
    }
    private func save() {
        var set = existing.flatMap { old in store.sets.first { $0.id == old.id } } ?? existing ?? StudySet(name: name)
        if existing == nil || name != existing?.name { set.name = name.trimmingCharacters(in: .whitespacesAndNewlines) }
        if existing == nil || summary != (existing?.description ?? "") { set.description = summary }
        if existing == nil || selected != Set(existing?.bookIds ?? []) {
            let added = selected.subtracting(Set(existing?.bookIds ?? []))
            let removed = Set(existing?.bookIds ?? []).subtracting(selected)
            set.bookIds = Set(set.bookIds).union(added).subtracting(removed).sorted()
        }
        set.updatedAt = Date().timeIntervalSince1970 * 1000
        do { try store.save(set); dismiss() } catch { self.error = error.localizedDescription }
    }
}

struct MindMapsView: View {
    @EnvironmentObject private var state: AppState
    var body: some View { Group { if let store = state.study { StudyMapList(store: store) } else { ProgressView() } }.navigationTitle("脑图") }
}
struct StudyMapList: View {
    @ObservedObject var store: StudyStore
    var bookIDs: Set<String>? = nil
    @State private var creating = false
    @State private var title = ""
    @State private var error: String?
    private var maps: [StudyMindMap] { store.maps.filter { bookIDs == nil || $0.bookId == nil || $0.bookId == "" || bookIDs!.contains($0.bookId!) } }
    var body: some View {
        List {
            ErrorBanner(message: error)
            ForEach(maps) { map in
                NavigationLink { MindMapEditor(store: store, mapID: map.id) } label: {
                    VStack(alignment: .leading, spacing: 5) { Label(map.title, systemImage: "point.3.connected.trianglepath.dotted"); Text("\(StudyTree.nodes(map.root).count) 个节点").font(.caption).foregroundStyle(.secondary) }
                }
            }
            Button("新建脑图", systemImage: "plus") { title = ""; creating = true }
            if maps.isEmpty { Text("把卡片拖入脑图，建立知识之间的关系。来源卡片更新后，这里的内容会同步显示。").font(.subheadline).foregroundStyle(.secondary) }
        }.scrollContentBackground(.hidden).background(ShufangStyle.paper)
        .alert("新建脑图", isPresented: $creating) {
            TextField("主题", text: $title)
            Button("取消", role: .cancel) {}
            Button("创建") {
                let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty else { return }
                do { try store.save(StudyMindMap(title: name, bookId: bookIDs?.sorted().first ?? "", root: StudyMindNode(text: name))) }
                catch { self.error = error.localizedDescription }
            }
        }
    }
}


struct MindMapEditor: View {
    @ObservedObject var store: StudyStore
    let mapID: String
    @Environment(\.dismiss) private var dismiss
    @State private var mode = 0
    @State private var selectedID: String?
    @State private var editingNode: StudyMindNode?
    @State private var addingParent: String?
    @State private var choosingCard = false
    @State private var choosingParent = false
    @State private var error: String?
    @State private var deletingMap = false
    @State private var undo: [StudyMindNode] = []
    @State private var redo: [StudyMindNode] = []
    private var map: StudyMindMap? { store.maps.first { $0.id == mapID } }
    private var selected: StudyMindNode? { guard let map else { return nil }; return StudyTree.nodes(map.root).first { $0.id == selectedID } ?? map.root }
    var body: some View {
        Group {
            if let map {
                VStack(spacing: 0) {
                    ErrorBanner(message: error)
                    Picker("显示方式", selection: $mode) { Text("脑图").tag(0); Text("大纲").tag(1) }.pickerStyle(.segmented).padding()
                    if mode == 0 { canvas(map) }
                    else { List { outline(map.root, depth: 0) } }
                    Divider()
                    nodeActions(map)
                }
            } else { ContentUnavailableView("脑图已删除", systemImage: "point.3.connected.trianglepath.dotted") }
        }.navigationTitle(map?.title ?? "脑图").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button { history(backward: true) } label: { Image(systemName: "arrow.uturn.backward") }.disabled(undo.isEmpty)
            Button { history(backward: false) } label: { Image(systemName: "arrow.uturn.forward") }.disabled(redo.isEmpty)
            Menu {
                Button("添加子节点", systemImage: "plus") { addingParent = selected?.id; editingNode = StudyMindNode(text: "") }
                Button("从卡片添加", systemImage: "rectangle.stack.badge.plus") { choosingCard = true }
                Button("删除脑图", role: .destructive) { deletingMap = true }
            } label: { Image(systemName: "ellipsis.circle") }
        }
        .sheet(item: $editingNode) { node in nodeEditor(node) }
        .sheet(isPresented: $choosingCard) { cardPicker }
        .sheet(isPresented: $choosingParent) { parentPicker }
        .confirmationDialog("删除整张脑图？", isPresented: $deletingMap, titleVisibility: .visible) {
            Button("删除脑图", role: .destructive) { do { try store.delete(kind: "mindMaps", id: mapID); dismiss() } catch { self.error = error.localizedDescription } }
        }
    }
    private func displayText(_ node: StudyMindNode) -> String { StudyTree.title(node, cards: store.cards) }
    private func nodeActions(_ map: StudyMindMap) -> some View {
        HStack {
            if let selected {
                Text(displayText(selected)).lineLimit(1).font(.caption)
                Spacer()
                if let card = store.cards.first(where: { $0.id == selected.sourceHighlightId }) {
                    NavigationLink { StudyCardDetail(store: store, cardID: card.id) } label: { Label("卡片", systemImage: "rectangle.stack") }
                } else { Button("编辑") { addingParent = nil; editingNode = selected } }
                Menu {
                    Button(selected.collapsed == true ? "展开" : "折叠") { change(StudyTree.update(map.root, id: selected.id) { $0.collapsed = !($0.collapsed ?? false) }) }
                    Button("添加子节点") { addingParent = selected.id; editingNode = StudyMindNode(text: "") }
                    Button("添加来源卡片") { choosingCard = true }
                    if selected.id != map.root.id {
                        Button("移动到…") { choosingParent = true }
                        Button("上移") { change(StudyTree.reorder(map.root, id: selected.id, delta: -1)) }
                        Button("下移") { change(StudyTree.reorder(map.root, id: selected.id, delta: 1)) }
                        Button("删除节点及子节点", role: .destructive) { change(StudyTree.removing(map.root, id: selected.id)); selectedID = map.root.id }
                    }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }.padding().buttonStyle(.bordered)
    }
    private func outline(_ node: StudyMindNode, depth: Int) -> AnyView {
        AnyView(Group {
            Button { selectedID = node.id } label: {
                HStack {
                    if !node.children.isEmpty {
                        Button { if let map { change(StudyTree.update(map.root, id: node.id) { $0.collapsed = !($0.collapsed ?? false) }) } } label: { Image(systemName: node.collapsed == true ? "chevron.right" : "chevron.down") }
                            .buttonStyle(.borderless)
                    }
                    Text(displayText(node)).lineLimit(3).foregroundStyle(.primary)
                    Spacer()
                    if node.id == selected?.id { Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint) }
                    if node.sourceHighlightId != nil { Image(systemName: "link").foregroundStyle(.secondary) }
                }.padding(.leading, CGFloat(depth) * 18)
            }.draggable("shufang-node:" + node.id)
                .dropDestination(for: String.self) { strings, _ in drop(strings, parent: node.id) }
            if node.collapsed != true { ForEach(node.children) { child in outline(child, depth: depth + 1) } }
        })
    }
    private func canvas(_ map: StudyMindMap) -> some View {
        let layout = MindTreeLayout(root: map.root)
        return ScrollView([.horizontal, .vertical]) {
            ZStack(alignment: .topLeading) {
                Canvas { context, _ in
                    for item in layout.items {
                        guard let parentID = item.parent, let parent = layout.items.first(where: { $0.node.id == parentID }) else { continue }
                        var path = Path()
                        let start = CGPoint(x: parent.x + 210, y: parent.y + 37)
                        let end = CGPoint(x: item.x, y: item.y + 37)
                        path.move(to: start); path.addCurve(to: end, control1: CGPoint(x: start.x + 22, y: start.y), control2: CGPoint(x: end.x - 22, y: end.y))
                        context.stroke(path, with: .color(.secondary.opacity(0.35)), lineWidth: 1.5)
                    }
                }.frame(width: layout.width, height: layout.height)
                ForEach(layout.items) { item in
                    Button { selectedID = item.node.id } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(displayText(item.node)).font(.subheadline).lineLimit(3).multilineTextAlignment(.leading)
                            if item.node.collapsed == true { Text("\(item.node.children.count) 个子节点").font(.caption2).foregroundStyle(.secondary) }
                        }.padding(12).frame(width: 210, height: 74, alignment: .leading)
                            .background(item.node.id == selected?.id ? ShufangStyle.pine.opacity(0.14) : Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(item.node.id == selected?.id ? ShufangStyle.pine : Color.secondary.opacity(0.18), lineWidth: 1))
                    }.buttonStyle(.plain).position(x: item.x + 105, y: item.y + 37)
                        .draggable("shufang-node:" + item.node.id)
                        .dropDestination(for: String.self) { strings, _ in drop(strings, parent: item.node.id) }
                }
            }.frame(width: layout.width, height: layout.height).padding(24)
        }.background(ShufangStyle.paper)
    }
    private func nodeEditor(_ node: StudyMindNode) -> some View {
        NavigationStack { MindNodeTextEditor(node: node) { changed in
            guard let map else { return }
            if let parent = addingParent { change(StudyTree.update(map.root, id: parent) { $0.children.append(changed); $0.collapsed = false }) }
            else { change(StudyTree.update(map.root, id: node.id) { $0.text = changed.text }) }
            editingNode = nil; addingParent = nil
        } }
    }
    private var cardPicker: some View {
        NavigationStack {
            List(store.cards) { card in
                Button { attach(card, parent: selected?.id); choosingCard = false } label: { StudyCardRow(store: store, card: card) }
            }.navigationTitle("添加来源卡片").toolbar { Button("取消") { choosingCard = false } }
        }
    }
    private var parentPicker: some View {
        NavigationStack {
            List {
                if let map, let selected {
                    let invalid = Set(StudyTree.nodes(selected).map(\.id))
                    ForEach(StudyTree.nodes(map.root).filter { !invalid.contains($0.id) }) { node in
                        Button(displayText(node)) { if let changed = StudyTree.moved(map.root, id: selected.id, parent: node.id) { change(changed) }; choosingParent = false }
                    }
                }
            }.navigationTitle("选择新的父节点").toolbar { Button("取消") { choosingParent = false } }
        }
    }
    private func attach(_ card: StudyCard, parent: String?) {
        guard let map else { return }
        let node = StudyMindNode(text: card.name?.isEmpty == false ? card.name! : card.text, chapterId: card.chapterId, sourceHighlightId: card.id)
        change(StudyTree.update(map.root, id: parent ?? map.root.id) { $0.children.append(node); $0.collapsed = false })
    }
    private func drop(_ strings: [String], parent: String) -> Bool {
        guard let value = strings.first, let map else { return false }
        if value.hasPrefix("shufang-card:"), let card = store.cards.first(where: { $0.id == String(value.dropFirst(13)) }) { attach(card, parent: parent); return true }
        if value.hasPrefix("shufang-node:"), let changed = StudyTree.moved(map.root, id: String(value.dropFirst(13)), parent: parent) { change(changed); return true }
        return false
    }
    private func change(_ root: StudyMindNode) {
        guard var map, map.root != root else { return }
        let previous = map.root
        if map.root.text != root.text { map.title = root.text }
        map.root = root; map.updatedAt = Date().timeIntervalSince1970 * 1000
        do { try store.save(map); undo.append(previous); redo = []; error = nil } catch { self.error = error.localizedDescription }
    }
    private func history(backward: Bool) {
        guard var map, let root = backward ? undo.last : redo.last else { return }
        let previous = map.root
        if map.root.text != root.text { map.title = root.text }
        map.root = root; map.updatedAt = Date().timeIntervalSince1970 * 1000
        do {
            try store.save(map)
            if backward { _ = undo.popLast(); redo.append(previous) } else { _ = redo.popLast(); undo.append(previous) }
        } catch { self.error = error.localizedDescription }
    }
}

private struct MindTreeLayout {
    struct Item: Identifiable { var id: String { node.id }; let node: StudyMindNode; let parent: String?; let x: CGFloat; let y: CGFloat }
    var items: [Item] = []
    var width: CGFloat = 0
    var height: CGFloat = 0
    init(root: StudyMindNode) {
        var row: CGFloat = 0
        mutatingWalk(root, parent: nil, depth: 0, row: &row)
        width = max(260, (items.map(\.x).max() ?? 0) + 220)
        height = max(300, row * 98)
    }
    private mutating func mutatingWalk(_ node: StudyMindNode, parent: String?, depth: Int, row: inout CGFloat) {
        let start = row
        if node.collapsed != true && !node.children.isEmpty {
            for child in node.children { mutatingWalk(child, parent: node.id, depth: depth + 1, row: &row) }
        } else { row += 1 }
        let center = (start + row - 1) / 2
        items.append(Item(node: node, parent: parent, x: CGFloat(depth) * 260, y: center * 98))
    }
}
private struct MindNodeTextEditor: View {
    let node: StudyMindNode
    var save: (StudyMindNode) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    var body: some View {
        Form { TextEditor(text: $text).frame(minHeight: 180) }.navigationTitle("节点内容")
            .task { text = node.text }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("保存") { var changed = node; changed.text = text; save(changed) }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
            }
    }
}

struct AssociationsView: View {
    @EnvironmentObject private var state: AppState
    var body: some View {
        Group { if let store = state.study { StudyAssociationList(store: store) } else { ProgressView() } }.navigationTitle("观点关联")
    }
}
private struct StudyAssociationList: View {
    @ObservedObject var store: StudyStore
    @State private var query = ""
    @State private var error: String?
    var body: some View {
        List {
            ErrorBanner(message: error)
            ForEach(store.associations.filter { query.isEmpty || [$0.label ?? "", $0.source.text, $0.target.text].joined().localizedCaseInsensitiveContains(query) }) { item in
                Section {
                    NavigationLink { StudySourceView(source: item.source) } label: { Text(item.source.text).lineLimit(5) }
                    Label(item.label ?? "相互关联", systemImage: item.direction == "bidirectional" ? "arrow.up.arrow.down" : "arrow.down").font(.caption).foregroundStyle(ShufangStyle.pine)
                    NavigationLink { StudySourceView(source: item.target) } label: { Text(item.target.text).lineLimit(5) }
                    Button("删除关联", role: .destructive) { do { try store.delete(kind: "associations", id: item.id) } catch { self.error = error.localizedDescription } }
                }
            }
            if store.associations.isEmpty { ContentUnavailableView("建立观点之间的联系", systemImage: "link", description: Text("打开卡片，选择“关联另一张卡片”。")) }
        }.searchable(text: $query, prompt: "搜索观点与关系").scrollContentBackground(.hidden).background(ShufangStyle.paper)
    }
}
struct AssociationEditor: View {
    @ObservedObject var store: StudyStore
    let sourceCard: StudyCard
    @Environment(\.dismiss) private var dismiss
    @State private var targetID = ""
    @State private var label = "支持观点"
    @State private var bidirectional = true
    @State private var query = ""
    @State private var error: String?
    var body: some View {
        Form {
            ErrorBanner(message: error)
            Section("来源") { Text(sourceCard.text).lineLimit(5) }
            Section("关系") {
                Picker("关系名称", selection: $label) { ForEach(["支持观点", "反例", "待验证", "相似观点"], id: \.self) { Text($0).tag($0) } }
                Toggle("双向关联", isOn: $bidirectional)
            }
            Section("目标卡片") {
                TextField("搜索卡片", text: $query)
                ForEach(store.cards.filter { $0.id != sourceCard.id && (query.isEmpty || ($0.text + ($0.name ?? "")).localizedCaseInsensitiveContains(query)) }) { card in
                    Button { targetID = card.id } label: { HStack { StudyCardRow(store: store, card: card); if targetID == card.id { Image(systemName: "checkmark.circle.fill") } } }
                }
            }
        }.navigationTitle("关联卡片")
        .toolbar { Button("保存") {
            guard let target = store.cards.first(where: { $0.id == targetID }) else { return }
            guard let pairKey = StudyAnchors.pairKey(sourceCard.source, target.source, bidirectional: bidirectional) else {
                error = "这张卡片缺少精确的原文位置。请在阅读器重新选择文字或 PDF 区域后建立关联。"
                return
            }
            let relation = StudyAssociation(source: sourceCard.source, target: target.source,
                direction: bidirectional ? "bidirectional" : "source-to-target", label: label, pairKey: pairKey)
            if store.associations.contains(where: { $0.pairKey == pairKey }) { error = "这两段内容已经有关联。"; return }
            do { try store.save(relation); dismiss() } catch { self.error = error.localizedDescription }
        }.disabled(targetID.isEmpty) }
    }
}

struct StudyConflictsView: View {
    @ObservedObject var store: StudyStore
    @State private var error: String?
    var body: some View {
        List {
            ErrorBanner(message: error)
            ForEach(store.conflicts) { conflict in
                Section {
                    Text(conflict.localDeleted == true ? "本机请求删除" : "本机版本").font(.headline)
                    Text(preview(conflict.local)).font(.subheadline).textSelection(.enabled)
                    Text("服务器版本").font(.headline)
                    Text(preview(conflict.remote)).font(.subheadline).textSelection(.enabled)
                    Button(conflict.localDeleted == true ? "确认删除" : "保留本机版本") { resolve(conflict, .local) }
                    Button("采用服务器版本") { resolve(conflict, .remote) }
                    Button("保留双方，另存本机副本") { resolve(conflict, .copy) }
                } header: { Text(conflict.kind == "mindMaps" ? "脑图" : conflict.kind == "notes" ? "笔记" : "学习资料") }
            }
            if store.conflicts.isEmpty { ContentUnavailableView("所有修改已合并", systemImage: "checkmark.circle") }
        }.navigationTitle("处理同时修改")
    }
    private func preview(_ fields: [String: JSONValue]) -> String {
        var lines = [String]()
        for key in ["title", "name", "text", "content", "note"] { if let value = fields[key]?.string, !value.isEmpty { lines.append(value) } }
        if let root = fields["root"], let node = try? root.decoded(StudyMindNode.self) { lines.append(StudyTree.nodes(node).map(\.text).joined(separator: "\n")) }
        return lines.isEmpty ? "\(fields.count) 项内容" : lines.joined(separator: "\n\n")
    }
    private func resolve(_ conflict: StudyConflict, _ choice: StudyConflictChoice) { do { try store.resolve(conflict, choice: choice) } catch { self.error = error.localizedDescription } }
}
