import SwiftUI
import CryptoKit

@MainActor final class ReadingHistoryStore: ObservableObject {
    @Published private(set) var sessions: [ReadingSession] = []
    @Published private(set) var syncError: String?
    private var pending: [String: ReadingSession] = [:]
    private let client: APIClient
    private let storageKey: String
    let replicaID: String
    private var syncing = false

    init(client: APIClient) {
        self.client = client
        let scope = client.configuration.origin.absoluteString + "|" + client.configuration.userID
        let digest = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
        storageKey = "reading-history." + digest
        let replicaKey = "reading-replica." + digest
        if let saved = UserDefaults.standard.string(forKey: replicaKey) { replicaID = saved }
        else {
            replicaID = UUID().uuidString.lowercased()
            UserDefaults.standard.set(replicaID, forKey: replicaKey)
        }
        if let data = UserDefaults.standard.data(forKey: storageKey),
           let saved = try? JSONDecoder().decode([ReadingSession].self, from: data) {
            sessions = ReadingTime.merge(saved)
            pending = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
        }
    }
    func record(_ item: ReadingSession) {
        sessions = ReadingTime.merge(sessions + [item])
        pending[item.id] = item
        persist()
        Task { await sync() }
    }
    func sync() async {
        guard !syncing else { return }
        syncing = true; defer { syncing = false }
        do {
            guard try await client.detectSync() != nil else { return }
            for item in pending.values.sorted(by: { $0.startedAt < $1.startedAt }) {
                try await client.pushReadingSession(item, replicaID: replicaID)
                // A newer checkpoint may have arrived while this request was in flight.
                if pending[item.id] == item { pending.removeValue(forKey: item.id) }
            }
            sessions = ReadingTime.merge(sessions + (try await client.fetchReadingSessions()))
            persist()
            syncError = nil
        } catch { syncError = error.localizedDescription }
    }
    private func persist() {
        // Keep only locally created sessions. Remote history can be fetched again.
        let local = sessions.filter { $0.id.hasPrefix(replicaID + ".") }
        if let data = try? JSONEncoder().encode(local) {
            UserDefaults.standard.set(data, forKey: storageKey)
        }
    }
}

struct ReadingHistoryView: View {
    @EnvironmentObject private var state: AppState
    @State private var books: [Book] = []
    var body: some View {
        Group {
            if let history = state.readingHistory {
                HistoryContent(history: history, books: books)
            }
        }
        .background(ShufangStyle.paper.ignoresSafeArea())
        .navigationTitle("阅读记录")
        .task { await load() }
        .refreshable { await load() }
    }
    private func load() async {
        guard let client = state.client else { return }
        if let response: BooksResponse = try? await client.request(["books"]) {
            books = response.books
        } else { books = await state.offline?.savedBooks() ?? [] }
        await state.readingHistory?.sync()
    }
}

private struct HistoryContent: View {
    @ObservedObject var history: ReadingHistoryStore
    let books: [Book]
    private var bookByID: [String: Book] { Dictionary(uniqueKeysWithValues: books.map { ($0.id, $0) }) }
    private var recent: [ReadingSession] {
        Array(history.sessions.sorted { $0.endedAt > $1.endedAt }.prefix(100))
    }
    var body: some View {
        List {
            if let error = history.syncError {
                Section { Label("同步暂不可用，本机记录已保留：\(error)", systemImage: "wifi.exclamationmark")
                    .font(.footnote).foregroundStyle(.secondary) }
            }
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text("总阅读时长").font(.subheadline).foregroundStyle(.secondary)
                    Text(ReadingTime.label(ReadingTime.duration(history.sessions)))
                        .font(.system(.largeTitle, design: .serif).bold())
                    Text("仅统计阅读器在前台的时间；重叠时段只计算一次。")
                        .font(.footnote).foregroundStyle(.secondary)
                }.padding(.vertical, 8)
            }
            Section("按书统计") {
                ForEach(books.filter { book in history.sessions.contains { $0.bookId == book.id } }) { book in
                    NavigationLink { BookView(book: book) } label: {
                        HStack {
                            Text(book.title).lineLimit(1)
                            Spacer()
                            Text(ReadingTime.label(ReadingTime.duration(
                                history.sessions.filter { $0.bookId == book.id })))
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                if history.sessions.isEmpty { Text("打开一本书开始阅读后，这里会出现记录。")
                    .foregroundStyle(.secondary) }
            }
            Section("最近阅读") {
                ForEach(recent) { item in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(bookByID[item.bookId]?.title ?? "已移除的书籍")
                        HStack {
                            Text(Date(timeIntervalSince1970: item.startedAt / 1000), style: .date)
                            Text(Date(timeIntervalSince1970: item.startedAt / 1000), style: .time)
                            Spacer()
                            Text(ReadingTime.label(item.endedAt - item.startedAt))
                        }.font(.caption).foregroundStyle(.secondary)
                    }.padding(.vertical, 3)
                }
            }
        }.scrollContentBackground(.hidden)
    }
}
