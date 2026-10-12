import AppKit
import SwiftUI
import UniformTypeIdentifiers
import ShufangMacCore

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    var model: LibraryModel?
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard model?.confirmDiscard() != false else { return .terminateCancel }
        Task {
            do { try await model?.shutdown(); sender.reply(toApplicationShouldTerminate: true) }
            catch { model?.status = LibraryModel.message(error); sender.reply(toApplicationShouldTerminate: false) }
        }
        return .terminateLater
    }
}

enum Panels {
    @MainActor static func files() -> [URL] {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [UTType(filenameExtension: "epub")!, .pdf, .plainText,
            UTType(filenameExtension: "fb2") ?? .data, UTType(filenameExtension: "mobi") ?? .data,
            UTType(filenameExtension: "azw3") ?? .data]
        return panel.runModal() == .OK ? panel.urls : []
    }
    @MainActor static func openArchive() -> URL? {
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.zip]; panel.canChooseDirectories = false
        return panel.runModal() == .OK ? panel.url : nil
    }
    @MainActor static func save(_ filename: String) -> URL? {
        let panel = NSSavePanel(); panel.nameFieldStringValue = filename; panel.allowedContentTypes = [.zip]
        return panel.runModal() == .OK ? panel.url : nil
    }
    @MainActor static func directory() -> URL? {
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false
        return panel.runModal() == .OK ? panel.url : nil
    }
}

struct LibraryView: View {
    @ObservedObject var model: LibraryModel
    var body: some View {
        VStack(spacing: 0) {
            NavigationSplitView {
                List(Section.allCases) { section in
                    Button { model.changeSection(section) } label: {
                        Label(section.title, systemImage: section.icon).foregroundStyle(model.section == section ? Color.accentColor : Color.primary)
                            .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                    }.buttonStyle(.plain).padding(.vertical, 4)
                }.navigationTitle("书房").frame(minWidth: 160).disabled(model.busy)
            } detail: { detail }
            Divider()
            HStack {
                if model.busy { ProgressView(value: model.progress).frame(width: 90); Button("取消任务") { model.cancel() } }
                if !model.ready && !model.busy { Button("重试打开书库") { Task { await model.open() } } }
                Text(model.status).font(.caption).lineLimit(2).textSelection(.enabled)
                Spacer()
                Text(model.currentConnection?.userID ?? "本机离线书库").font(.caption).foregroundStyle(.secondary)
            }.padding(8)
        }
        .toolbar {
            if model.section.hasRecords {
                Button { model.newRecord() } label: { Label("新建", systemImage: "plus") }
                    .disabled(!model.ready || model.busy || ![.notes, .folders, .studySets, .mindMaps].contains(model.section))
                Button { model.save() } label: { Label("保存", systemImage: "square.and.arrow.down") }
                    .disabled(!model.ready || model.busy || model.section == .associations)
                Button { model.deleteSelected() } label: { Label("删除", systemImage: "trash") }
                    .disabled(model.record == nil || model.busy)
            }
            Button { model.importFiles(Panels.files()) } label: { Label("导入书籍", systemImage: "square.and.arrow.down.on.square") }
                .disabled(!model.ready || model.busy)
            Button { model.start("刷新") { try await model.refresh() } } label: { Label("刷新", systemImage: "arrow.clockwise") }
                .disabled(!model.ready || model.busy)
        }
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            guard !model.busy, model.ready else { return false }
            Task { @MainActor in
                var urls: [URL] = []
                for provider in providers {
                    let url: URL? = await withCheckedContinuation { continuation in
                        _ = provider.loadObject(ofClass: URL.self) { url, _ in continuation.resume(returning: url) }
                    }
                    if let url { urls.append(url) }
                }
                model.importFiles(urls)
            }
            return true
        }
    }
    @ViewBuilder var detail: some View {
        if model.section.hasRecords {
            HSplitView {
                List(model.records, selection: Binding(get: { model.selected }, set: { model.select($0) })) { row in
                    VStack(alignment: .leading) {
                        Text(row.title).lineLimit(2)
                        if !row.pending.isEmpty { Text("内容等待下载").font(.caption).foregroundStyle(.secondary) }
                    }.tag(row.id)
                }.frame(minWidth: 200, idealWidth: 240, maxWidth: 340).disabled(model.busy)
                RecordEditor(model: model).frame(minWidth: 420)
            }
        } else {
            switch model.section {
            case .review: ReviewPane(model: model)
            case .search: SearchPane(model: model)
            case .connection: ConnectionPane(model: model)
            case .backup: BackupPane(model: model)
            case .assistant: AIPane(model: model)
            default: EmptyView()
            }
        }
    }
}

@main
struct ShufangMacApp: App {
    @StateObject private var model = LibraryModel()
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    var body: some Scene {
        Window("书房", id: "library") {
            LibraryView(model: model).task { delegate.model = model; if !model.ready { await model.open() } }
        }.defaultSize(width: 1200, height: 800)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("新建笔记") { model.newNote() }.keyboardShortcut("n")
                    .disabled(model.busy || !model.ready)
                Button("导入书籍…") { model.importFiles(Panels.files()) }.keyboardShortcut("o")
                    .disabled(model.busy || !model.ready)
            }
            CommandGroup(after: .saveItem) {
                Button("保存") { model.save() }.keyboardShortcut("s").disabled(model.busy || !model.ready || !model.section.hasRecords)
            }
            CommandMenu("书房") {
                Button("书库") { model.changeSection(.books) }.keyboardShortcut("1")
                Button("笔记") { model.changeSection(.notes) }.keyboardShortcut("2")
                Button("搜索") { model.changeSection(.search) }.keyboardShortcut("f")
                Button("复习") { model.changeSection(.review) }.keyboardShortcut("r", modifiers: [.command, .shift])
                Button("账户与同步") { model.changeSection(.connection) }
                Button("备份与恢复") { model.changeSection(.backup) }
            }
        }
    }
}
