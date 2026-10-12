import AppKit
import SwiftUI
import ShufangMacCore

struct ReviewPane: View {
    @ObservedObject var model: LibraryModel
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("复习").font(.largeTitle)
            Text("待复习 \(model.queue.count) 张")
            if let card = model.queue.first {
                Text(card.value["name"] as? String ?? "回忆这张卡片的内容").font(.title2)
                if model.answerVisible {
                    ScrollView { VStack(alignment: .leading) {
                        Text(card.value["text"] as? String ?? "").textSelection(.enabled)
                        Text(card.value["note"] as? String ?? "").foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading) }
                    HStack {
                        Button("重来") { model.grade(1) }; Button("困难") { model.grade(2) }
                        Button("良好") { model.grade(3) }; Button("容易") { model.grade(4) }
                    }
                } else { Button("显示答案") { model.answerVisible = true }.keyboardShortcut(.space, modifiers: []) }
            } else { Text("当前没有到期卡片。可从批注页将内容加入复习。").foregroundStyle(.secondary) }
            Spacer()
        }.padding(28).disabled(model.busy || !model.ready)
    }
}

struct SearchPane: View {
    @ObservedObject var model: LibraryModel
    var body: some View {
        VStack(alignment: .leading) {
            Text("搜索书库、正文、笔记和批注").font(.title2)
            HStack { TextField("搜索词", text: $model.query).onSubmit { model.search() }; Button("搜索") { model.search() } }
            if model.searchTruncated { Text("显示前 500 项结果，请缩小范围。").font(.caption) }
            List(Array(model.hits.enumerated()), id: \.offset) { _, hit in
                Button { model.openHit(hit) } label: {
                    VStack(alignment: .leading) {
                        if let row = hit["record"] as? [String: Any], let record = try? Record(row) { Text(record.title).font(.headline) }
                        Text(hit["preview"] as? String ?? "").lineLimit(3).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.plain)
            }
        }.padding().disabled(model.busy || !model.ready)
    }
}

struct ConnectionPane: View {
    @ObservedObject var model: LibraryModel
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("账户与同步").font(.largeTitle)
                if let connection = model.currentConnection {
                    Text("已连接 \(connection.origin.absoluteString)")
                    Text("账户：\(connection.userID)")
                    Text(connection.expiresAt > Date() ? "会话有效" : "会话已过期，离线数据仍保留")
                    HStack {
                        Button("立即同步") { model.start("同步") { try await model.sync() } }
                        Button(model.syncConfig["paused"] as? Bool == false ? "暂停自动同步" : "开启自动同步") {
                            model.pauseSync(model.syncConfig["paused"] as? Bool == false)
                        }
                        Button("退出登录") { model.logout() }
                        Button("断开本机连接") { model.disconnect() }
                    }
                } else { Text("本机书库未配对。登录后会打开独立账户目录；本机编辑不会自动归入账户。") }
                Divider()
                TextField("服务器 HTTPS 地址", text: $model.connectionAddress)
                TextField("账号", text: $model.connectionUser)
                SecureField("密码", text: $model.connectionPassword)
                Button("登录 / 重新登录") { if model.confirmDiscard() { model.login() } }
                Text("登录信息和 AI 密钥由本机 Keychain 管理，不写入同步数据或备份。").font(.caption).foregroundStyle(.secondary)
                Divider()
                Text("离线冲突").font(.title2)
                if model.conflicts.isEmpty { Text("当前没有待处理冲突。").foregroundStyle(.secondary) }
                ForEach(Array(model.conflicts.enumerated()), id: \.offset) { _, conflict in
                    Button("查看 \(conflict["kind"] as? String ?? "记录") 冲突") { model.previewConflict(conflict) }
                }
                if !model.conflictPreview.isEmpty {
                    HStack(alignment: .top) {
                        conflict("本机版本", model.conflictPreview["local"])
                        conflict("远端版本", model.conflictPreview["remote"])
                    }
                    HStack {
                        Button("保留本机") { model.resolveConflict("local") }
                        Button("采用远端") { model.resolveConflict("remote") }
                        Button("保留两份") { model.resolveConflict("copy") }
                    }
                }
            }.padding(28).frame(maxWidth: 850, alignment: .leading)
        }.disabled(model.busy || !model.ready)
    }
    func conflict(_ title: String, _ value: Any?) -> some View {
        let record = value as? [String: Any] ?? [:]
        return VStack(alignment: .leading) {
            Text(title).font(.headline)
            Text(record["title"] as? String ?? record["name"] as? String ?? "已删除")
            Text(record["content"] as? String ?? record["text"] as? String ?? "").lineLimit(12).textSelection(.enabled)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct BackupPane: View {
    @ObservedObject var model: LibraryModel
    @State private var policy = "keepBoth"
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("备份与恢复").font(.largeTitle)
                Text("整库备份保留离线状态、待发送操作和原文件；学习资料包用于跨端资料导入。凭据不随包传递。")
                HStack {
                    Button("整库备份…") { if let url = Panels.save("书房整库-\(stamp).zip") { model.backup(url) } }
                    Button("导出学习资料…") { if let url = Panels.save("书房学习资料-\(stamp).zip") { model.exportStudy(url) } }
                    Button("创建版本") { model.version() }
                }
                Divider()
                Text("学习资料恢复").font(.title2)
                Picker("重名处理", selection: $policy) {
                    Text("保留两份").tag("keepBoth"); Text("保留本机").tag("keepLocal"); Text("替换").tag("replace")
                }.frame(width: 320)
                Button("选择学习资料包并预览…") { if let url = Panels.openArchive() { model.previewRestore(url, policy: policy) } }
                if !model.restorePreview.isEmpty {
                    Text("准备恢复：\(model.restorePreview["title"] as? String ?? "学习资料")")
                    let counts = model.restorePreview["counts"] as? [String: Int] ?? [:]
                    ForEach(counts.keys.sorted(), id: \.self) { kind in
                        Text("\(Section(rawValue: kind)?.title ?? kind)：\(counts[kind] ?? 0)")
                    }
                    Button("确认恢复预览中的内容") { model.commitRestore() }
                    Text("提交前会生成安全备份；预览后发生编辑将拒绝旧计划。").font(.caption)
                }
                Divider()
                Text("整库恢复到新目录").font(.title2)
                Text("原书库保持不变。恢复成功后可核对新目录中的数据库和原文件；不会直接覆盖活动书库。")
                Button("选择整库备份和目标父目录…") {
                    if let archive = Panels.openArchive(), let parent = Panels.directory() {
                        model.restoreLibrary(archive, destination: parent.appendingPathComponent("书房恢复-\(UUID().uuidString)"))
                    }
                }
                Button("打开已恢复的书库…") { if let directory = Panels.directory() { model.openRestored(directory) } }
                Divider()
                Text("已保存版本：\(model.versions.count)")
                ForEach(Array(model.versions.enumerated()), id: \.offset) { _, version in
                    HStack {
                        Text(version["id"] as? String ?? "版本")
                        Spacer()
                        if let id = version["id"] as? String, id.hasPrefix("version-") { Button("恢复到新目录") { model.restoreVersion(id) } }
                        Button("在 Finder 查看") {
                            if let path = version["archive"] as? String { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
                        }
                    }
                }
            }.padding(28).frame(maxWidth: 850, alignment: .leading)
        }.disabled(model.busy || !model.ready)
    }
    var stamp: String { ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-") }
}

struct AIPane: View {
    @ObservedObject var model: LibraryModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack { Text("AI 助手").font(.title2); Spacer(); Button("关闭") { dismiss() } }
            HStack {
                Picker("提供商", selection: $model.aiProvider) {
                    ForEach(["codex", "openai", "deepseek", "kimi", "minimax"], id: \.self) { Text($0).tag($0) }
                }
                TextField("模型名称", text: $model.aiModel)
            }
            if model.aiProvider != "codex" { SecureField("API 密钥（留空保留原值）", text: $model.aiKey) }
            Button("保存设置") { model.saveAI() }
            Text(model.aiProvider == "codex" ? "Codex 使用本机 CLI 的独立登录；未登录时会提示错误。" : "API 密钥保存在本机 Keychain。").font(.caption).foregroundStyle(.secondary)
            Picker("任务", selection: $model.aiTask) {
                Text("对话").tag("chat"); Text("总结").tag("digest"); Text("翻译").tag("translate")
                Text("生成脑图").tag("mindmap"); Text("生成卡片").tag("studyCard")
            }
            TextField("问题或指令", text: $model.aiQuestion)
            HStack { Button("生成") { model.askAI() }; Button("保存成果") { model.saveAIResult() }.disabled(model.aiText.isEmpty) }
            if !model.aiHistory.isEmpty { DisclosureGroup("最近对话（已存入共享笔记，可备份）") { ScrollView { ForEach(Array(model.aiHistory.enumerated()), id: \.offset) { _, message in Text("\(message["role"] ?? ""): \(message["content"] ?? "")").textSelection(.enabled) } }.frame(maxHeight: 160) } }
            ScrollView { Text(model.aiText).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
        }.padding(24).disabled(model.busy || !model.ready)
    }
}
