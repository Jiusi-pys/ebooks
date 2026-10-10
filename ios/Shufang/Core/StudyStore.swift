import Foundation
import Combine
import CryptoKit

enum StudyRestorePolicy { case keepBoth, keepLocal, replace }
enum StudyError: LocalizedError {
    case unsupportedVersion, corrupted, unavailable, deleted, missingAttachment, invalidRecord
    var errorDescription: String? {
        switch self {
        case .unsupportedVersion: return "学习资料版本较新，请更新 App 后打开。"
        case .corrupted: return "本机学习资料无法读取。原文件已保留，请从备份恢复。"
        case .unavailable: return "此服务器尚不支持学习同步。修改已保存在本机。"
        case .deleted: return "内容已被其他设备删除，请另存副本。"
        case .missingAttachment: return "附件不完整，请重新下载或恢复完整备份。"
        case .invalidRecord: return "学习资料格式不正确，未保存修改。"
        }
    }
}
struct StudyField: Codable { var version: String; var value: JSONValue?; var removed: Bool? }
struct StudyEntity: Codable {
    var id: String; var kind: String; var deleted: Bool; var fields: [String: StudyField]
    var key: String { kind + ":" + id }
    var values: [String: JSONValue] { fields.filter { $0.value.removed != true }.compactMapValues(\.value) }
}
struct StudyOperation: Codable, Identifiable {
    var id: String { operationId }
    var workspaceId: String; var operationId: String; var replicaId: String
    var kind: String; var entityId: String; var clock: String
    var patch: [String: JSONValue]; var unset: [String]; var deleted: Bool
    var key: String { kind + ":" + entityId }
}
struct StudyPending: Codable {
    var operation: StudyOperation
    var base: [String: JSONValue]
    var submitted: Bool? = nil
}
struct StudySnapshot: Codable {
    var version = 1
    var replica = UUID().uuidString.lowercased()
    var clock: Int64 = 0
    var workspace: String? = nil
    var cursor: String? = nil
    var cursorOrigin: String? = nil
    var entities: [String: StudyEntity] = [:]
    var pending: [StudyPending] = []
    var conflicts: [StudyConflict] = []
}

/// One durable transaction contains local edits and their retryable operations.
/// Credentials are never included; the directory is bound to origin + user ID.
@MainActor final class StudyStore: ObservableObject {
    let client: APIClient
    let root: URL
    var attachmentDirectory: URL { root.appendingPathComponent("attachments", isDirectory: true) }
    @Published private var snapshot = StudySnapshot()
    @Published private(set) var syncing = false
    @Published var error: String?
    @Published private(set) var transferProgress: Double = 0
    @Published private(set) var syncPaused = false
    private var cancelRequested = false
    private var writable = true
    private var syncTask: Task<Void, Never>?
    private var uploaded = Set<String>()
    init(client: APIClient, baseDirectory: URL? = nil) {
        self.client = client
        let base = baseDirectory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let origin = client.configuration.origin
        let scope = "\(origin.scheme!.lowercased())://\(origin.host!.lowercased()):\(origin.port ?? (origin.scheme == "https" ? 443 : 80))|\(client.configuration.userID)"
        root = base.appendingPathComponent("Shufang/Study/" + Self.hash(Data(scope.utf8)), isDirectory: true)
        let file = root.appendingPathComponent("workspace.json")
        if FileManager.default.fileExists(atPath: file.path) {
            do {
                let loaded = try JSONDecoder().decode(StudySnapshot.self, from: Data(contentsOf: file))
                guard loaded.version == 1 else { throw StudyError.unsupportedVersion }
                if loaded.cursorOrigin == nil {
                    let backup = root.appendingPathComponent("workspace.before-account-routes-v2.json")
                    if !FileManager.default.fileExists(atPath: backup.path) {
                        try FileManager.default.copyItem(at: file, to: backup)
                    }
                }
                snapshot = loaded
            } catch { writable = false; self.error = error.localizedDescription }
        }
    }
    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    var pendingCount: Int { snapshot.pending.count }
    var conflicts: [StudyConflict] { snapshot.conflicts }
    var records: [StudyRecord] {
        var entities = snapshot.entities
        for item in snapshot.pending { Self.apply(item.operation, to: &entities, force: true) }
        return entities.values.filter { !$0.deleted }.map {
            StudyRecord(id: $0.id, kind: $0.kind, fields: Self.materialize(kind: $0.kind, values: resolved($0.values)))
        }.sorted { $0.key < $1.key }
    }
    private func values<T: Decodable>(_ kind: String, as: T.Type) -> [T] {
        records.filter { $0.kind == kind }.compactMap { record in
            var fields = record.fields; fields["id"] = .string(record.id)
            return try? JSONValue.object(fields).decoded(T.self)
        }
    }
    var cards: [StudyCard] { values("highlights", as: StudyCard.self).sorted { $0.createdAt > $1.createdAt } }
    var notes: [StudyNote] { values("notes", as: StudyNote.self).filter { !$0.id.hasPrefix("pdfink.") }.sorted { $0.updatedAt > $1.updatedAt } }
    var sets: [StudySet] { values("studySets", as: StudySet.self).sorted { $0.updatedAt > $1.updatedAt } }
    var maps: [StudyMindMap] { values("mindMaps", as: StudyMindMap.self).sorted { $0.updatedAt > $1.updatedAt } }
    var associations: [StudyAssociation] { values("associations", as: StudyAssociation.self) }
    var books: [Book] { values("books", as: Book.self).sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending } }
    var reviewEvents: [StudyReviewEvent] {
        records.filter { $0.kind == "reviews" }.compactMap { record in
            let f = record.fields
            guard let card = f["highlightId"]?.string,
                  let review = try? (f["state"] ?? .null).decoded(ReviewState.self),
                  let rating = review.lastRating else { return nil }
            return StudyReviewEvent(id: record.id, highlightId: card, rating: rating,
                reviewedAt: f["createdAt"]?.number ?? review.lastReviewedAt ?? 0, review: review)
        }.sorted { $0.reviewedAt > $1.reviewedAt }
    }
    func save(_ value: StudyCard) throws { try save(value, kind: "highlights", id: value.id) }
    func save(_ value: StudyNote) throws { try save(value, kind: "notes", id: value.id) }
    func save(_ value: StudySet) throws { try save(value, kind: "studySets", id: value.id) }
    func save(_ value: StudyMindMap) throws { try save(value, kind: "mindMaps", id: value.id) }
    func save(_ value: StudyAssociation) throws { try save(value, kind: "associations", id: value.id) }
    private func save<T: Codable>(_ value: T, kind: String, id: String) throws {
        guard var fields = try JSONValue.encoded(value).object else { throw StudyError.invalidRecord }
        fields.removeValue(forKey: "id")
        let newKnown = fields
        if let prior = records.first(where: { $0.kind == kind && $0.id == id }) {
            // Preserve fields added by another client version when editing known fields.
            var old = prior.fields; old["id"] = .string(id)
            if let typed = try? JSONValue.object(old).decoded(T.self),
               let known = try JSONValue.encoded(typed).object {
                fields = prior.fields.merging(fields) { _, new in new }
                for key in known.keys where key != "id" && newKnown[key] == nil { fields.removeValue(forKey: key) }
            }
        }
        try saveRecord(.init(id: id, kind: kind, fields: fields))
    }
    func saveRecord(_ record: StudyRecord) throws {
        var next = snapshot
        try queue(record, into: &next)
        try commit(next); scheduleSync()
    }
    private func queue(_ record: StudyRecord, into next: inout StudySnapshot, deleted: Bool = false) throws {
        guard !record.id.isEmpty, ["books", "notes", "highlights", "studySets", "mindMaps", "associations", "reviews", "sources", "preferences", "translations", "folders"].contains(record.kind) else { throw StudyError.invalidRecord }
        var effective = next.entities
        for pending in next.pending { Self.apply(pending.operation, to: &effective, force: true) }
        let prior = effective[record.key]
        if prior?.deleted == true { throw StudyError.deleted }
        let before = resolved(prior?.values ?? [:])
        var after = Self.flatten(kind: record.kind, fields: record.fields)
        after.removeValue(forKey: "id")
        let patch = after.filter { before[$0.key] != $0.value }
        let unset = before.keys.filter { after[$0] == nil }.sorted()
        guard deleted || !patch.isEmpty || !unset.isEmpty else { return }
        next.clock = max(next.clock + 1, Int64(Date().timeIntervalSince1970 * 1000))
        let op = StudyOperation(workspaceId: next.workspace ?? "", operationId: record.kind == "reviews" ? record.id : UUID().uuidString.lowercased(),
            replicaId: next.replica, kind: record.kind, entityId: record.id, clock: "\(next.clock):0",
            patch: deleted ? [:] : patch, unset: deleted ? [] : unset, deleted: deleted)
        next.pending.append(StudyPending(operation: op, base: before))
    }
    func delete(kind: String, id: String) throws {
        guard let record = records.first(where: { $0.kind == kind && $0.id == id }) else { return }
        var next = snapshot
        try queue(record, into: &next, deleted: true)
        try commit(next); scheduleSync()
    }
    func grade(_ card: StudyCard, rating: Int) throws {
        guard (1...4).contains(rating),
              let current = cards.first(where: { $0.id == card.id }), let review = current.review,
              var fields = records.first(where: { $0.kind == "highlights" && $0.id == card.id })?.fields else { throw StudyError.invalidRecord }
        let now = Date().timeIntervalSince1970 * 1000
        let graded = review.graded(rating, now: now)
        var next = snapshot
        // Grading changes only review state; preserve newer-client metadata and edits
        // made after the review screen captured its card value.
        fields["review"] = try .encoded(graded)
        try queue(.init(id: card.id, kind: "highlights", fields: fields), into: &next)
        let event = StudyRecord(id: UUID().uuidString.lowercased(), kind: "reviews", fields: [
            "highlightId": .string(card.id), "event": .string("review"), "state": try .encoded(graded),
            "createdAt": .number(now), "deviceId": .string(next.replica)])
        try queue(event, into: &next)
        try commit(next); scheduleSync()
    }
    private func commit(_ next: StudySnapshot) throws {
        guard writable else { throw StudyError.corrupted }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(next)
        try data.write(to: root.appendingPathComponent("workspace.json"), options: .atomic)
        #if os(iOS)
        try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: root.path)
        #endif
        snapshot = next
    }
    private func scheduleSync() {
        syncTask?.cancel()
        syncTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard !Task.isCancelled else { return }
            await self?.sync(automatic: true)
        }
    }
    func cancelSync() { syncTask?.cancel(); cancelRequested = true; syncPaused = true }
    private func checkCancellation() throws {
        try Task.checkCancellation()
        if cancelRequested { throw CancellationError() }
    }
    func sync(automatic: Bool = false) async {
        guard writable, !syncing, !(automatic && syncPaused) else { return }
        cancelRequested = false; syncPaused = false
        client.beginRouteLease()
        syncing = true; defer { syncing = false; client.endRouteLease() }
        do {
            guard let caps = try await client.detectSync() else { throw StudyError.unavailable }
            if let workspace = snapshot.workspace, workspace != caps.workspaceId { throw StudyError.invalidRecord }
            var next = snapshot; next.workspace = caps.workspaceId
            let routeOrigin = client.transportConfiguration.origin.absoluteString
            if next.cursorOrigin != routeOrigin {
                next.cursor = nil; next.cursorOrigin = routeOrigin
                uploaded.removeAll()
            }
            try commit(next)
            try await pull()
            while let pending = snapshot.pending.first(where: { item in !snapshot.conflicts.contains(where: { $0.kind == item.operation.kind && $0.entityId == item.operation.entityId }) }) {
                try checkCancellation()
                var op = pending.operation; op.workspaceId = caps.workspaceId
                let remote = snapshot.entities[op.key]
                let remoteValues = resolved(remote?.values ?? [:])
                let keys = op.deleted ? Set(remoteValues.keys).union(pending.base.keys) : Set(op.patch.keys).union(op.unset)
                let changed = (remote?.deleted == true && !op.deleted) || keys.contains {
                    let actual = remoteValues[$0]
                    return actual != pending.base[$0] && (op.deleted || actual != resolved(op.patch)[$0])
                }
                if changed {
                    var next = snapshot
                    let local = op.deleted ? Self.materialize(kind: op.kind, values: pending.base) : records.first { $0.key == op.key }?.fields ?? [:]
                    next.conflicts.append(.init(id: op.id, kind: op.kind, entityId: op.entityId,
                        local: local, remote: Self.materialize(kind: op.kind, values: remoteValues), localDeleted: op.deleted))
                    try commit(next); continue
                }
                if pending.submitted != true {
                    var next = snapshot
                    next.clock = max(next.clock + 1, Int64(Date().timeIntervalSince1970 * 1000))
                    op.clock = "\(next.clock):0"
                    for (key, value) in op.patch {
                        let data = try JSONEncoder().encode(value)
                        if data.count > 60_000 {
                            let hash = try attachment(name: key + ".json", data: data)
                            op.patch[key] = .object(["$blob": .object(["sha256": .string(hash), "size": .number(Double(data.count)), "name": .string(key + ".json"), "type": .string("application/json")])])
                        }
                    }
                    if let index = next.pending.firstIndex(where: { $0.operation.id == op.id }) {
                        next.pending[index].operation = op; next.pending[index].submitted = true
                    }
                    try commit(next)
                }
                try await uploadAttachments(op.patch)
                if op.kind == "sources", let fields = records.first(where: { $0.key == op.key })?.fields {
                    try await uploadAttachments(["source": .object(["$attachment": .object(fields)])])
                }
                struct Push: Encodable { let operations: [StudyOperation] }
                struct Reply: Decodable { struct Receipt: Decodable { let operationId: String; let error: String? }; let receipts: [Receipt] }
                let reply: Reply = try await client.request(["sync", "push"], method: "POST", body: JSONEncoder().encode(Push(operations: [op])), version: 2)
                guard reply.receipts.count == 1, reply.receipts[0].operationId == op.operationId,
                      reply.receipts[0].error == nil else { throw APIError.invalidResponse }
                var next = snapshot
                Self.apply(op, to: &next.entities)
                next.pending.removeAll { $0.operation.id == op.id }
                try commit(next)
            }
            try await pull()
            try await downloadAttachments()
            error = nil
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
    private func pull() async throws {
        struct Start: Decodable { let id: String; let cursor: String }
        struct Page: Decodable { let entities: [StudyEntity]; let next: String?; let cursor: String }
        struct Changes: Decodable { let operations: [StudyOperation]; let cursor: String; let hasMore: Bool }
        if snapshot.cursor == nil {
            let start: Start = try await client.request(["sync", "snapshots"], method: "POST", version: 2)
            var after: String?; var entities: [String: StudyEntity] = [:]
            repeat {
                let page: Page = try await client.request(["sync", "snapshots", start.id], version: 2,
                    query: after.map { [URLQueryItem(name: "after", value: $0)] } ?? [])
                try checkCancellation()
                for entity in page.entities { entities[entity.key] = entity }
                after = page.next
            } while after != nil
            var next = snapshot; next.entities = Self.merged(snapshot.entities, entities); next.cursor = start.cursor
            for entity in entities.values {
                for field in entity.fields.values {
                    if let clock = Int64(field.version.prefix(16)) { next.clock = max(next.clock, clock) }
                }
            }
            try commit(next)
        }
        do {
            var more: Bool
            repeat {
                let changes: Changes = try await client.request(["sync", "changes"], version: 2,
                    query: [URLQueryItem(name: "cursor", value: snapshot.cursor)])
                var next = snapshot
                for op in changes.operations {
                    Self.apply(op, to: &next.entities)
                    if let clock = Int64(op.clock.split(separator: ":").first ?? "0") { next.clock = max(next.clock, clock) }
                    // A server-accepted operation can arrive after the app lost its HTTP reply.
                    next.pending.removeAll { $0.operation.id == op.id }
                    next.conflicts.removeAll { $0.id == op.id }
                }
                next.cursor = changes.cursor
                try commit(next); more = changes.hasMore
            } while more
            try await hydrateJSONFields()
        } catch APIError.http(409) {
            var next = snapshot; next.cursor = nil; try commit(next)
            try await pull()
        }
    }
    func resolve(_ conflict: StudyConflict, choice: StudyConflictChoice) throws {
        var next = snapshot
        next.pending.removeAll { $0.operation.kind == conflict.kind && $0.operation.entityId == conflict.entityId }
        next.conflicts.removeAll { $0.kind == conflict.kind && $0.entityId == conflict.entityId }
        if choice != .remote {
            let id = choice == .copy ? UUID().uuidString.lowercased() : conflict.entityId
            try queue(.init(id: id, kind: conflict.kind, fields: conflict.local), into: &next,
                      deleted: conflict.localDeleted == true && choice == .local)
        }
        try commit(next); scheduleSync()
    }
    func exportData(bookIDs: Set<String>? = nil) throws -> Data {
        let all = records
        guard let requested = bookIDs else { return try JSONEncoder().encode(all) }
        var books = requested
        var cards = Set<String>(), notes = Set<String>(), folders = Set<String>(), selected = Set<String>()
        let noteRecords = all.filter { $0.kind == "notes" && !$0.id.hasPrefix("pdfink.") }
        let links = try NSRegularExpression(pattern: #"\[\[([^\[\]\n|]+)(?:\|[^\[\]\n]*)?\]\]"#)
        func cardReferences(_ value: JSONValue) -> Set<String> {
            switch value {
            case .object(let fields):
                var ids = Set(fields["sourceHighlightId"]?.string.map { [$0] } ?? [])
                for child in fields.values { ids.formUnion(cardReferences(child)) }
                return ids
            case .array(let values): return values.reduce(into: Set<String>()) { $0.formUnion(cardReferences($1)) }
            default: return []
            }
        }
        // Follow source relationships to a fixed point. Every exported link gets
        // its source book/card/note; unrelated learning-set memberships do not
        // silently pull the entire library into a selected-set backup.
        var changed = true
        while changed {
            let previous = [books.count, cards.count, notes.count, folders.count, selected.count]
            for record in all {
                let f = record.fields
                var include = selected.contains(record.key)
                switch record.kind {
                case "books": include = books.contains(record.id)
                case "sources": include = books.contains(record.id)
                case "highlights": include = cards.contains(record.id) || f["bookId"]?.string.map(books.contains) == true
                case "notes": include = notes.contains(record.id) || f["bookId"]?.string.map(books.contains) == true
                case "translations": include = f["bookId"]?.string.map(books.contains) == true
                case "reviews": include = f["highlightId"]?.string.map(cards.contains) == true
                case "mindMaps":
                    include = f["bookId"]?.string.map(books.contains) == true || !cardReferences(.object(f)).isDisjoint(with: cards)
                case "associations":
                    include = f["source"]?.object?["bookId"]?.string.map(books.contains) == true || f["target"]?.object?["bookId"]?.string.map(books.contains) == true
                case "studySets":
                    let members = Set(f["bookIds"]?.array?.compactMap(\.string) ?? [])
                    include = members.isSubset(of: requested) && (!members.isEmpty || requested.isEmpty)
                case "folders": include = folders.contains(record.id)
                default: break
                }
                guard include else { continue }
                selected.insert(record.key)
                if record.kind == "books" {
                    if let folder = f["folderId"]?.string ?? f["folder"]?.string, !folder.isEmpty { folders.insert(folder) }
                }
                if record.kind == "folders", let parent = f["parentId"]?.string { folders.insert(parent) }
                if record.kind == "highlights" {
                    cards.insert(record.id)
                    if let book = f["bookId"]?.string { books.insert(book) }
                    if let note = f["noteId"]?.string { notes.insert(note) }
                }
                if record.kind == "mindMaps" { cards.formUnion(cardReferences(.object(f))) }
                if record.kind == "associations" {
                    for key in ["source", "target"] {
                        if let book = f[key]?.object?["bookId"]?.string { books.insert(book) }
                    }
                }
                if record.kind == "notes", let content = f["content"]?.string {
                    let text = content as NSString
                    for match in links.matches(in: content, range: NSRange(location: 0, length: text.length)) {
                        let target = text.substring(with: match.range(at: 1)).trimmingCharacters(in: .whitespacesAndNewlines)
                        for note in noteRecords where note.id.caseInsensitiveCompare(target) == .orderedSame || note.fields["title"]?.string?.caseInsensitiveCompare(target) == .orderedSame { notes.insert(note.id) }
                    }
                }
            }
            changed = previous != [books.count, cards.count, notes.count, folders.count, selected.count]
        }
        return try JSONEncoder().encode(all.filter { selected.contains($0.key) })
    }
    private func restoreEntities() -> [String: StudyEntity] {
        var entities = snapshot.entities
        for pending in snapshot.pending { Self.apply(pending.operation, to: &entities, force: true) }
        return entities
    }
    private func restoreFingerprint(_ entities: [String: StudyEntity]) throws -> String {
        let values = entities.mapValues { entity in
            JSONValue.object(["deleted": .bool(entity.deleted), "fields": .object(entity.values)])
        }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return Self.hash(try encoder.encode(values))
    }
    func prepareRestore(data: Data, policy: StudyRestorePolicy) throws -> StudyRestorePlan {
        guard writable else { throw StudyError.corrupted }
        let input = try JSONDecoder().decode([StudyRecord].self, from: data)
        guard Set(input.map(\.key)).count == input.count else { throw StudyError.invalidRecord }
        let existing = restoreEntities()
        var ids: [String: String] = [:]
        // A source is addressed by its book ID. Tombstones are permanent in
        // v2, so both identities move together when restoring a deleted book.
        for record in input where record.kind == "books" || record.kind == "sources" {
            let bookKey = "books:" + record.id, sourceKey = "sources:" + record.id
            if existing[bookKey]?.deleted == true || existing[sourceKey]?.deleted == true {
                let id = ids[bookKey] ?? UUID().uuidString.lowercased()
                ids[bookKey] = id; ids[sourceKey] = id
            }
        }
        for record in input where record.kind != "books" && record.kind != "sources" && record.kind != "reviews" {
            if record.kind == "notes", record.id.hasPrefix("pdfink.") {
                if let book = record.fields["bookId"]?.string, let replacement = ids["books:" + book],
                   let page = record.fields["pdfPage"]?.number, page.isFinite, page > 0, page <= Double(Int.max), page.rounded() == page {
                    ids[record.key] = "pdfink." + Self.hash(Data(replacement.utf8)) + ".\(Int(page))"
                } else if existing[record.key]?.deleted == true { throw StudyRestoreError.deletedInk }
                continue
            }
            if existing[record.key]?.deleted == true || (policy == .keepBoth && existing[record.key] != nil) {
                ids[record.key] = UUID().uuidString.lowercased()
            }
        }
        // Review events are immutable. A copied card needs copied event IDs;
        // otherwise the server's idempotency receipt would discard its history.
        for record in input where record.kind == "reviews" {
            let copiedCard = record.fields["highlightId"]?.string.map { ids["highlights:" + $0] != nil } == true
            if copiedCard || existing[record.key]?.deleted == true { ids[record.key] = UUID().uuidString.lowercased() }
        }
        let notes = input.filter { $0.kind == "notes" && !$0.id.hasPrefix("pdfink.") }
        var restored: [StudyRecord] = []
        for record in input {
            if ids[record.key] == nil, existing[record.key] != nil {
                if policy == .keepLocal || record.kind == "reviews" || (policy == .keepBoth && (record.kind == "books" || record.kind == "sources" || (record.kind == "notes" && record.id.hasPrefix("pdfink.")))) { continue }
            }
            restored.append(.init(id: ids[record.key] ?? record.id, kind: record.kind,
                fields: StudyRestoreRemapping.fields(record, ids: ids, notes: notes)))
        }
        // Validate the entire queue without writing before staging original files.
        var trial = snapshot
        for record in restored { try queue(record, into: &trial) }
        return StudyRestorePlan(records: restored, idMap: ids, fingerprint: try restoreFingerprint(existing), scope: root.path)
    }
    func restore(plan: StudyRestorePlan) throws {
        guard plan.scope == root.path, plan.fingerprint == (try restoreFingerprint(restoreEntities())) else { throw StudyRestoreError.changed }
        var next = snapshot
        for record in plan.records { try queue(record, into: &next) }
        try commit(next); scheduleSync()
    }
    func restore(data: Data, policy: StudyRestorePolicy) throws {
        try restore(plan: prepareRestore(data: data, policy: policy))
    }
    func attachment(name: String, data: Data) throws -> String {
        guard data.count <= 256 * 1024 * 1024 else { throw OfflineBookError.tooLarge }
        let hash = Self.hash(data)
        try FileManager.default.createDirectory(at: attachmentDirectory, withIntermediateDirectories: true)
        try data.write(to: attachmentDirectory.appendingPathComponent(hash), options: .atomic)
        return hash
    }
    func attachmentData(_ hash: String) -> Data? {
        guard hash.count == 64, hash.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
              let data = try? Data(contentsOf: attachmentDirectory.appendingPathComponent(hash)), Self.hash(data) == hash else { return nil }
        return data
    }
    private func resolved(_ fields: [String: JSONValue]) -> [String: JSONValue] {
        fields.mapValues { value in
            guard let hash = value.object?["$blob"]?.object?["sha256"]?.string,
                  let data = attachmentData(hash), let json = try? JSONDecoder().decode(JSONValue.self, from: data) else { return value }
            return json
        }
    }
    private func hydrateJSONFields() async throws {
        for entity in snapshot.entities.values where !entity.deleted {
            for value in entity.values.values {
                guard let ref = value.object?["$blob"]?.object, let hash = ref["sha256"]?.string,
                      attachmentData(hash) == nil else { continue }
                let bytes = try await client.data(["blobs", hash], timeout: 120, version: 2)
                guard Self.hash(bytes) == hash, Double(bytes.count) == ref["size"]?.number else { throw StudyError.missingAttachment }
                _ = try JSONDecoder().decode(JSONValue.self, from: bytes)
                _ = try attachment(name: ref["name"]?.string ?? hash, data: bytes)
            }
        }
        objectWillChange.send()
    }
    func blob(name: String, type: String, data: Data) throws -> JSONValue {
        let hash = try attachment(name: name, data: data)
        return .object(["$attachment": .object(["sha256": .string(hash), "size": .number(Double(data.count)), "name": .string(name), "type": .string(type)])])
    }
    func sourcePDF(bookID: String) -> Data? {
        guard let ref = records.first(where: { $0.kind == "sources" && $0.id == bookID })?.fields,
              let hash = ref["sha256"]?.string else { return nil }
        return attachmentData(hash)
    }
    func importBook(book: Book, contents: [Chapter], pdf: Data?) throws {
        let chapters: [JSONValue] = contents.map { .object(["id": .string($0.id), "title": .string($0.title), "paragraphs": .array($0.paragraphs.map(JSONValue.string))]) }
        var next = snapshot
        if let pdf {
            let hash = try attachment(name: book.title + ".pdf", data: pdf)
            try queue(.init(id: book.id, kind: "sources", fields: ["sha256": .string(hash), "size": .number(Double(pdf.count)),
                "name": .string(String(book.title.prefix(240)) + ".pdf"), "type": .string("application/pdf"), "format": .string("pdf")]), into: &next)
        }
        try queue(.init(id: book.id, kind: "books", fields: ["title": .string(book.title), "author": .string(book.author),
            "format": .string(book.format), "coverTone": .number(Double(book.coverTone ?? 0)), "chapters": .array(chapters),
            "createdAt": .number(Date().timeIntervalSince1970 * 1000), "progress": .object(["chapterId": .string(contents.first?.id ?? ""), "ratio": .number(0)])]), into: &next)
        try commit(next); scheduleSync()
    }
    func savePDFDrawing(bookID: String, page: Int, drawing: Data, preview: Data?, portableInk: Data? = nil) throws {
        let id = "pdfink." + Self.hash(Data(bookID.utf8)) + ".\(page)"
        let now = Date().timeIntervalSince1970 * 1000
        var fields = records.first(where: { $0.kind == "notes" && $0.id == id })?.fields ?? [:]
        let current: [String: JSONValue] = ["title": .string("第 \(page) 页手写"), "content": .string(""),
            "createdAt": .number(now), "updatedAt": .number(now), "bookId": .string(bookID), "pdfPage": .number(Double(page)),
            "pdfDrawing": try blob(name: "drawing.pkdraw", type: "application/octet-stream", data: drawing)]
        fields.merge(current, uniquingKeysWith: { _, new in new })
        if let old = records.first(where: { $0.kind == "notes" && $0.id == id })?.fields["createdAt"] { fields["createdAt"] = old }
        if let portableInk {
            _ = try JSONDecoder().decode(PortableInk.self, from: portableInk).validated()
            fields["pdfPortableInk"] = try blob(name: "drawing.ink.json", type: "application/vnd.shufang.ink+json", data: portableInk)
        }
        if let preview { fields["pdfPreview"] = try blob(name: "drawing.png", type: "image/png", data: preview) }
        try saveRecord(.init(id: id, kind: "notes", fields: fields))
    }
    func portablePDFInk(bookID: String, page: Int) throws -> PortableInk? {
        let id = "pdfink." + Self.hash(Data(bookID.utf8)) + ".\(page)"
        guard let ref = records.first(where: { $0.id == id && $0.kind == "notes" })?.fields["pdfPortableInk"] else { return nil }
        guard let hash = ref.object?["$attachment"]?.object?["sha256"]?.string,
            let bytes = attachmentData(hash) else { throw StudyError.missingAttachment }
        return try JSONDecoder().decode(PortableInk.self, from: bytes).validated()
    }
    func pdfDrawing(bookID: String, page: Int) -> Data? {
        let id = "pdfink." + Self.hash(Data(bookID.utf8)) + ".\(page)"
        guard let hash = records.first(where: { $0.id == id && $0.kind == "notes" })?.fields["pdfDrawing"]?.object?["$attachment"]?.object?["sha256"]?.string else { return nil }
        return attachmentData(hash)
    }
    private func uploadAttachments(_ fields: [String: JSONValue]) async throws {
        for value in fields.values {
            guard let manifest = value.object?["$attachment"]?.object ?? value.object?["$blob"]?.object, let hash = manifest["sha256"]?.string,
                  !uploaded.contains(hash) else { continue }
            guard let data = attachmentData(hash) else { throw StudyError.missingAttachment }
            struct Upload: Decodable { let id: String; let chunkSize: Int; let chunks: Int; let present: Bool }
            let upload: Upload = try await client.request(["blobs", "uploads"], method: "POST", body: JSONEncoder().encode(manifest), version: 2)
            if !upload.present {
                for index in 0..<upload.chunks {
                    try checkCancellation()
                    let part = data.subdata(in: index * upload.chunkSize..<min(data.count, (index + 1) * upload.chunkSize))
                    _ = try await client.data(["blobs", "uploads", upload.id, String(index)], method: "PUT", body: part, version: 2,
                        headers: ["Content-Type": "application/octet-stream", "X-Chunk-SHA256": Self.hash(part)])
                    transferProgress = Double(index + 1) / Double(max(upload.chunks, 1))
                }
            }
            _ = try await client.data(["blobs", "uploads", upload.id, "commit"], method: "POST", version: 2)
            uploaded.insert(hash)
        }
    }
    private func downloadAttachments() async throws {
        // Ink is small and needed when reopening pages; original books remain opt-in downloads.
        for record in records where record.kind == "notes" && record.id.hasPrefix("pdfink.") {
            for value in record.fields.values {
                guard let ref = value.object?["$attachment"]?.object, let hash = ref["sha256"]?.string,
                      attachmentData(hash) == nil else { continue }
                let bytes = try await client.data(["blobs", hash], timeout: 120, version: 2)
                guard Self.hash(bytes) == hash else { throw StudyError.missingAttachment }
                _ = try attachment(name: ref["name"]?.string ?? hash, data: bytes)
            }
        }
    }
    /// Replication can lag: preserve newer fields already received from another route.
    static func merged(_ local: [String: StudyEntity], _ remote: [String: StudyEntity]) -> [String: StudyEntity] {
        var result = local
        for (key, incoming) in remote {
            guard var existing = result[key] else { result[key] = incoming; continue }
            existing.deleted = existing.deleted || incoming.deleted
            for (field, value) in incoming.fields {
                if existing.fields[field].map({ $0.version < value.version }) ?? true { existing.fields[field] = value }
            }
            result[key] = existing
        }
        return result
    }
    static func apply(_ op: StudyOperation, to entities: inout [String: StudyEntity], force: Bool = false) {
        var entity = entities[op.key] ?? StudyEntity(id: op.entityId, kind: op.kind, deleted: false, fields: [:])
        entity.deleted = entity.deleted || op.deleted
        let pieces = op.clock.split(separator: ":")
        let stamp = String(format: "%016lld:%010lld", Int64(pieces.first ?? "0") ?? 0, Int64(pieces.last ?? "0") ?? 0) + ":\(op.replicaId):\(op.id)"
        for key in Set(op.patch.keys).union(op.unset) {
            if !force, let prior = entity.fields[key], prior.version >= stamp { continue }
            entity.fields[key] = StudyField(version: stamp, value: op.unset.contains(key) ? nil : op.patch[key], removed: op.unset.contains(key))
        }
        entities[entity.key] = entity
    }
    static func flatten(kind: String, fields: [String: JSONValue]) -> [String: JSONValue] {
        var result = fields
        if kind == "studySets", let ids = result.removeValue(forKey: "bookIds")?.array {
            for id in ids.compactMap(\.string) { result["@member:" + id] = .bool(true) }
        }
        if kind == "mindMaps", let root = result.removeValue(forKey: "root")?.object {
            func visit(_ node: [String: JSONValue], parent: String?, order: Int) {
                guard let id = node["id"]?.string else { return }
                for (key, value) in node where key != "id" && key != "children" { result["@node:\(id):\(key)"] = value }
                result["@node:\(id):parent"] = parent.map(JSONValue.string) ?? .null
                result["@node:\(id):order"] = .number(Double(order))
                for (index, child) in (node["children"]?.array ?? []).enumerated() { if let child = child.object { visit(child, parent: id, order: index) } }
            }
            visit(root, parent: nil, order: 0)
        }
        return result
    }
    static func materialize(kind: String, values: [String: JSONValue]) -> [String: JSONValue] {
        var result = values
        if kind == "studySets" {
            result["bookIds"] = .array(values.keys.filter { $0.hasPrefix("@member:") }.sorted().map { .string(String($0.dropFirst(8))) })
            result = result.filter { !$0.key.hasPrefix("@member:") }
        }
        if kind == "mindMaps" {
            var nodes: [String: [String: JSONValue]] = [:]
            for (key, value) in values where key.hasPrefix("@node:") {
                // Node identifiers may themselves contain colons. The web contract
                // separates the field name at the final colon.
                let suffix = key.dropFirst(6)
                if let separator = suffix.lastIndex(of: ":") {
                    let id = String(suffix[..<separator])
                    let field = String(suffix[suffix.index(after: separator)...])
                    nodes[id, default: [:]][field] = value
                }
                result.removeValue(forKey: key)
            }
            func build(_ id: String, visited: Set<String>) -> JSONValue? {
                guard !visited.contains(id), var node = nodes[id] else { return nil }
                let seen = visited.union([id])
                node["id"] = .string(id); node.removeValue(forKey: "parent"); node.removeValue(forKey: "order")
                let children = nodes.keys.filter { nodes[$0]?["parent"]?.string == id }.sorted {
                    let a = nodes[$0]?["order"]?.number ?? 0, b = nodes[$1]?["order"]?.number ?? 0
                    return a == b ? $0 < $1 : a < b
                }.compactMap { build($0, visited: seen) }
                node["children"] = .array(children)
                return .object(node)
            }
            if let root = nodes.keys.sorted().first(where: { nodes[$0]?["parent"] == .null }) { result["root"] = build(root, visited: []) }
        }
        return result
    }
}
