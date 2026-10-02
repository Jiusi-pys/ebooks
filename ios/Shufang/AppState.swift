import SwiftUI
import CryptoKit
import Combine
import Network

@MainActor final class AppState: ObservableObject {
    private let serversKey = "connection.servers.v1"
    private let selectedKey = "connection.selected.v1"
    private let accountKey = "connection.account.v2"
    @Published var sidebarVisibility: NavigationSplitViewVisibility = .automatic
    @Published var servers: [String] = []
    @Published var selectedAddress = ServerConfiguration.defaultAddress
    @Published var origin: URL?
    @Published var client: APIClient?
    @Published var offline: OfflineLibrary?
    @Published var readingHistory: ReadingHistoryStore?
    @Published var study: StudyStore?
    @Published var sessionID = UUID()
    @Published var needsLogin = false
    @Published var startupError: String?
    @Published var account: AccountRoutes?
    @Published var measurements: [RouteMeasurement] = []
    @Published var measuring = false
    private var studyChanges: AnyCancellable?
    private let network = NWPathMonitor()
    private var routeRevision = 0
    init() {
        do {
            try Keychain.deleteLegacyAPIKey()
            if let data = UserDefaults.standard.data(forKey: accountKey) {
                let saved = try JSONDecoder().decode(AccountRoutes.self, from: data)
                guard saved.version == 2 else { throw APIError.invalidResponse }
                account = saved
                servers = saved.addresses
            } else {
                servers = (UserDefaults.standard.stringArray(forKey: serversKey) ?? []).compactMap {
                    try? ServerConfiguration.validatedOrigin($0).absoluteString
                }
            }
            if servers.isEmpty { servers = [ServerConfiguration.defaultAddress + "/"] }
            let selected = UserDefaults.standard.string(forKey: selectedKey)
            selectedAddress = selected.flatMap { servers.contains($0) ? $0 : nil } ?? servers[0]
            if let saved = try Keychain.load(address: selectedAddress) {
                try activate(try saved.configuration(), anchor: account?.anchorAddress ?? selectedAddress)
            }
        } catch { startupError = error.localizedDescription }
        network.pathUpdateHandler = { [weak self] _ in
            Task { @MainActor in await self?.refreshRoutes() }
        }
        network.start(queue: DispatchQueue(label: "shufang.routes"))
    }
    deinit { network.cancel() }
    private func persist() throws {
        if let account {
            if UserDefaults.standard.data(forKey: "connection.before-account-v2") == nil {
                let backup: [String: Any] = ["servers": UserDefaults.standard.stringArray(forKey: serversKey) ?? [],
                    "selected": UserDefaults.standard.string(forKey: selectedKey) ?? selectedAddress]
                UserDefaults.standard.set(try JSONSerialization.data(withJSONObject: backup), forKey: "connection.before-account-v2")
            }
            UserDefaults.standard.set(try JSONEncoder().encode(account), forKey: accountKey)
        }
        else { UserDefaults.standard.removeObject(forKey: accountKey) }
        UserDefaults.standard.set(servers, forKey: serversKey)
        UserDefaults.standard.set(selectedAddress, forKey: selectedKey)
        routeRevision += 1
    }
    private func activate(_ route: ServerConfiguration, anchor: String) throws {
        // The first account origin remains only a local storage key. All HTTP uses route.
        let config = try ServerConfiguration(address: anchor, userID: route.userID,
            sessionToken: route.sessionToken, expiresAt: route.expiresAt, allowExpired: true)
        if let client, client.configuration.origin == config.origin,
           client.configuration.userID == config.userID {
            guard client.useRoute(route) else { return }
        } else {
            study?.cancelSync()
            let candidate = APIClient(configuration: config, route: route)
            sessionID = UUID()
            let activeSession = sessionID
            candidate.onUnauthorized = { [weak self] in
                Task { @MainActor in
                    guard let self, self.sessionID == activeSession else { return }
                    self.needsLogin = true
                    await self.refreshRoutes()
                }
            }
            candidate.onUnavailable = { [weak self] in
                Task { @MainActor in
                    guard let self, self.sessionID == activeSession else { return }
                    await self.refreshRoutes()
                }
            }
            client = candidate
            offline = OfflineLibrary(configuration: config)
            readingHistory = ReadingHistoryStore(client: candidate)
            study = StudyStore(client: candidate)
            studyChanges = study?.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        }
        origin = route.origin
        selectedAddress = route.origin.absoluteString
        needsLogin = route.expiresAt <= Date()
        UserDefaults.standard.set(selectedAddress, forKey: selectedKey)
    }
    func addServer(_ address: String) throws {
        let normalized = try ServerConfiguration.validatedOrigin(address).absoluteString
        guard !servers.contains(where: { ServerConfiguration.sameOrigin($0, normalized) }) else { return }
        guard servers.count < 8 else { throw APIError.invalidResponse }
        servers.append(normalized)
        // An added address is not eligible until password login validates its identity.
        account?.addresses = servers
        measurements.append(.init(address: normalized, message: "待验证：请使用同一账户登录"))
        try persist()
        if client == nil { selectedAddress = normalized }
    }
    func selectServer(_ address: String?) async {
        account?.manualAddress = address
        if let address, account == nil { selectedAddress = address }
        do { try persist() } catch { startupError = error.localizedDescription }
        await refreshRoutes()
    }
    func connect(username: String, password: String) async throws {
        let expected = account
        var accepted: [(ServerConfiguration, SyncCapabilities)] = []
        var results: [RouteMeasurement] = []
        let addresses = [selectedAddress] + servers.filter { $0 != selectedAddress }
        for address in addresses {
            do {
                let config = try await APIClient.login(address: address, username: username, password: password)
                let probe = APIClient(configuration: config)
                guard let caps = try await probe.detectSync() else { throw APIError.serverNeedsUpdate }
                let identity = expected ?? accepted.first.map {
                    AccountRoutes(anchorAddress: $0.0.origin.absoluteString, userID: $0.0.userID,
                                  workspaceID: $0.1.workspaceId, addresses: servers)
                }
                guard identity?.accepts(userID: config.userID, workspaceID: caps.workspaceId) ?? true else {
                    throw RouteIdentityError.mismatch
                }
                try Keychain.save(.init(address: config.origin.absoluteString, userID: config.userID,
                    sessionToken: config.sessionToken, expiresAt: config.expiresAt))
                accepted.append((config, caps))
            } catch { results.append(.init(address: address, message: error.localizedDescription)) }
        }
        guard let first = accepted.first else {
            measurements = results
            throw RouteIdentityError.noRoute
        }
        account = expected ?? AccountRoutes(anchorAddress: first.0.origin.absoluteString,
            userID: first.0.userID, workspaceID: first.1.workspaceId, addresses: servers)
        try persist()
        try activate(first.0, anchor: account!.anchorAddress)
        measurements = results
        startupError = nil
        await refreshRoutes()
    }
    func refreshRoutes() async {
        guard !measuring, let identity = account, let activeClient = client else { return }
        measuring = true; defer { measuring = false }
        let revision = routeRevision
        let candidates = servers.map { address -> (String, ServerConfiguration?) in
            (address, try? Keychain.load(address: address)?.configuration())
        }
        let results = await withTaskGroup(of: RouteMeasurement.self, returning: [RouteMeasurement].self) { group in
            for (address, configuration) in candidates {
                group.addTask {
                    guard let configuration, configuration.expiresAt > Date() else {
                        return .init(address: address, message: "待登录或会话已过期")
                    }
                    do {
                        let probe = APIClient(configuration: configuration)
                        let start = ProcessInfo.processInfo.systemUptime
                        let caps: SyncCapabilities = try await probe.request(["capabilities"], timeout: 3, version: 2)
                        guard identity.accepts(userID: configuration.userID, workspaceID: caps.workspaceId) else {
                            throw RouteIdentityError.mismatch
                        }
                        return .init(address: address, milliseconds: (ProcessInfo.processInfo.systemUptime - start) * 1000)
                    } catch { return .init(address: address, message: error.localizedDescription) }
                }
            }
            var values: [RouteMeasurement] = []
            for await result in group { values.append(result) }
            return values.sorted { $0.address < $1.address }
        }
        guard revision == routeRevision, client === activeClient else { return }
        measurements = results
        guard let best = RouteSelection.best(results, current: selectedAddress, manual: identity.manualAddress),
              let config = candidates.first(where: { $0.0 == best })?.1 else {
            activeClient.suspendRoute()
            startupError = "当前没有可用链路，离线内容与待同步修改仍保留。"
            return
        }
        do {
            try activate(config, anchor: identity.anchorAddress)
            startupError = nil
        } catch { startupError = error.localizedDescription }
    }
    func disconnect() throws {
        for address in servers { try Keychain.delete(address: address) }
        study?.cancelSync()
        client = nil; offline = nil; readingHistory = nil; study = nil
        account = nil; needsLogin = false; measurements = []; sessionID = UUID()
        try persist()
    }
    func removeServer(_ address: String) throws {
        guard servers.count > 1, address != selectedAddress else { return }
        try Keychain.delete(address: address)
        servers.removeAll { $0 == address }
        account?.addresses = servers
        if account?.manualAddress == address { account?.manualAddress = nil }
        try persist()
        if selectedAddress == address { selectedAddress = servers[0] }
        Task { await refreshRoutes() }
    }
    func progressKey(book: String) -> String {
        let scope = (client?.configuration.origin.absoluteString ?? "") + "|" + (client?.configuration.userID ?? "") + "|" + book
        return "chapter." + SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
enum RouteIdentityError: LocalizedError {
    case mismatch, noRoute
    var errorDescription: String? {
        switch self {
        case .mismatch: return "该地址的账户或同步工作区不一致，未加入自动选路。"
        case .noRoute: return "所有地址均无法登录，请检查地址、账户密码和服务器状态。"
        }
    }
}
@main struct ShufangApp: App {
    @StateObject private var state = AppState()
    var body: some Scene {
        WindowGroup {
            Group {
                if state.client == nil { ConnectionView() }
                else { MainView().id(state.sessionID) }
            }
            .environmentObject(state)
            .tint(ShufangStyle.tint)
        }
    }
}
struct MainView: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase
    @State private var section: String? = "书架"
    var body: some View {
        Group {
        if sizeClass == .regular {
            NavigationSplitView(columnVisibility: $state.sidebarVisibility) {
                List(["书架", "学习", "搜索", "笔记", "备份", "设置"], id: \.self, selection: $section) { item in Label(item, systemImage: ShufangStyle.symbol(for: item)).tag(item) }
                    .navigationTitle("书房")
            } detail: {
                NavigationStack {
                    switch section {
                    case "学习": StudyView()
                    case "搜索": StudySearchView()
                    case "笔记": NotesView()
                    case "备份": StudyTransferView()
                    case "设置": ConnectionView()
                    default: LibraryView()
                    }
                }
            }
        } else {
        TabView {
            NavigationStack { LibraryView() }
                .tabItem { Label("书架", systemImage: ShufangStyle.symbol(for: "书架")) }
            NavigationStack { StudySearchView() }
                .tabItem { Label("搜索", systemImage: "magnifyingglass") }
            NavigationStack { StudyView() }
                .tabItem { Label("学习", systemImage: ShufangStyle.symbol(for: "学习")) }
            NavigationStack { NotesView() }
                .tabItem { Label("笔记", systemImage: "square.and.pencil") }
            NavigationStack { ConnectionView() }.tabItem { Label("设置", systemImage: "gearshape") }
        }
        }
        }
        .task { await state.refreshRoutes(); await state.study?.sync(automatic: true) }
        .onChange(of: scenePhase) { _, value in
            if value == .active { Task { await state.refreshRoutes(); await state.study?.sync(automatic: true) } }
        }
        .onReceive(Timer.publish(every: 45, on: .main, in: .common).autoconnect()) { _ in
            if scenePhase == .active { Task { await state.refreshRoutes(); await state.study?.sync(automatic: true) } }
        }
    }
}
enum ShufangStyle {
    static let ink = Color.primary
    static let tint = Color(uiColor: .systemBlue)
    static let pine = tint
    static let paper = Color(uiColor: .systemGroupedBackground)
    static let surface = Color(uiColor: .secondarySystemGroupedBackground)
    static let muted = Color.secondary
    static func symbol(for section: String) -> String {
        switch section {
        case "书架": return "books.vertical"
        case "学习": return "rectangle.stack"
        case "搜索": return "magnifyingglass"
        case "笔记": return "square.and.pencil"
        case "备份": return "externaldrive"
        default: return "gearshape"
        }
    }
}

struct ErrorBanner: View {
    let message: String?
    var body: some View {
        if let message {
            Label(message, systemImage: "exclamationmark.circle")
                .font(.callout).foregroundStyle(.red).padding()
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.red.opacity(0.06)).accessibilityIdentifier("errorBanner")
        }
    }
}
