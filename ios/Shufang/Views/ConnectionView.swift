import SwiftUI

struct ConnectionView: View {
    @EnvironmentObject private var state: AppState
    @State private var address = ""
    @State private var username = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                Label("一个账户，多条连接", systemImage: "network").font(.title2.bold())
                Text("在家连接家庭电脑，在外连接云服务器。登录一次，验证所有已添加地址；自动选择可用且延迟较低的链路。")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            if let account = state.account {
                Section("账户") {
                    Label(account.userID, systemImage: "person.crop.circle")
                    Button("退出账户", role: .destructive) {
                        do { try state.disconnect() } catch { self.error = error.localizedDescription }
                    }
                }
            }
            Section {
                if state.account != nil {
                    Button {
                        Task { await state.selectServer(nil) }
                    } label: {
                        HStack {
                            Label("自动选择低延迟链路", systemImage: "bolt.horizontal.circle")
                            Spacer()
                            if state.account?.manualAddress == nil { Image(systemName: "checkmark") }
                        }
                    }
                }
                ForEach(state.servers, id: \.self) { server in
                    Button {
                        Task { await state.selectServer(server) }
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(server).lineLimit(1).truncationMode(.middle)
                                Spacer()
                                if state.selectedAddress == server { Text("当前").font(.caption).foregroundStyle(.tint) }
                            }
                            if let result = state.measurements.first(where: { $0.address == server }) {
                                Text(result.milliseconds.map { "\(Int($0)) ms" } ?? result.message ?? "待检测")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            if state.account?.manualAddress == server { Text("手动指定").font(.caption) }
                        }
                    }
                    .swipeActions {
                        if state.servers.count > 1 && state.selectedAddress != server {
                            Button("移除", role: .destructive) {
                                do { try state.removeServer(server) } catch { self.error = error.localizedDescription }
                            }
                        }
                    }
                }
                HStack {
                    TextField("https://books.example.com", text: $address)
                        .keyboardType(.URL).textInputAutocapitalization(.never)
                        .autocorrectionDisabled().accessibilityIdentifier("serverAddress")
                    Button("添加") {
                        do { try state.addServer(address); address = ""; error = nil }
                        catch { self.error = error.localizedDescription }
                    }.disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Button {
                    Task { await state.refreshRoutes() }
                } label: {
                    HStack { Text("重新测量延迟"); Spacer(); if state.measuring { ProgressView() } }
                }.disabled(state.measuring || state.account == nil)
            } header: { Text("此账户的连接地址") }
              footer: { Text("地址须属于同一同步书房。自动模式会在网络变化、回到前台及使用期间定期检测；手动指定时不自动切换。家庭电脑需提供有效 HTTPS 地址。") }
            Section {
                if state.needsLogin {
                    Text("会话已失效；离线书籍和未同步修改仍保留，请重新登录。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                TextField("用户名", text: $username)
                    .textContentType(.username).textInputAutocapitalization(.never)
                    .autocorrectionDisabled().accessibilityIdentifier("username")
                SecureField("密码", text: $password)
                    .textContentType(.password).accessibilityIdentifier("password")
                Button {
                    busy = true; error = nil
                    Task {
                        defer { busy = false; password = "" }
                        do { try await state.connect(username: username, password: password) }
                        catch { self.error = error.localizedDescription }
                    }
                } label: {
                    HStack { Text(state.account == nil ? "登录并验证连接地址" : "重新登录并验证新增地址"); Spacer(); if busy { ProgressView() } }
                }.disabled(busy || username.isEmpty || password.isEmpty)
                 .accessibilityIdentifier("connectButton")
            } header: { Text("账户登录") }
              footer: { Text("同一账户密码仅发送到你添加的地址，密码不落盘。每条链路在钥匙串独立保存会话；仅账户和工作区一致的地址参与选路。新增地址或会话过期时在此重新登录。") }
            ErrorBanner(message: error ?? state.startupError)
            Section("离线与同步") {
                Text("切换链路共用同一份离线书籍、阅读位置和待同步队列，不会切换账户。同步期间固定当前链路，结束后再择优切换。服务器之间的数据复制仍由服务器负责。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle(state.client == nil ? "连接书房" : "账户与连接")
        .disabled(busy)
        .onAppear { if username.isEmpty { username = state.account?.userID ?? state.client?.configuration.userID ?? "" } }
    }
}
