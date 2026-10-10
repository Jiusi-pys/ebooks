import Foundation
import CryptoKit

enum StudyBackupError: LocalizedError {
    case invalid, unsupported, wrongAccount, tooLarge, missingBook(String), changedBook(String)
    var errorDescription: String? {
        switch self {
        case .invalid: return "备份不完整或校验失败，尚未恢复任何学习记录。"
        case .unsupported: return "该备份来自更新的书房版本，请先升级 App。"
        case .wrongAccount: return "此备份属于其他服务器或账户，请切换到原服务器并登录对应账户后恢复。"
        case .tooLarge: return "备份超过本机单次 512 MB 限制，请分别备份较小的学习集。"
        case .missingBook(let name): return "《\(name)》尚未完整下载，无法生成完整备份。请联网后重试。"
        case .changedBook(let name): return "《\(name)》的本机原文与备份不同。请选择“使用备份版本”恢复，避免卡片定位到错误原文。"
        }
    }
}

/// Portable transport uses ZIP stored entries. Compression, encryption, links,
/// ZIP64 and ambiguous local/central headers are deliberately rejected.
extension StudyBackupArchive {
    func zipData() throws -> Data {
        var files = payloads
        files["manifest.json"] = try JSONEncoder().encode(manifest)
        var output = Data(), central = Data()
        for name in files.keys.sorted() {
            let bytes = files[name]!, path = Data(name.utf8), crc = StudyZIP.crc(bytes)
            let offset = output.count
            guard bytes.count <= Self.maximumBytes, path.count <= 65535 else { throw StudyBackupError.tooLarge }
            output.zipWords([(0x04034b50,4),(20,2),(2048,2),(0,2),(0,2),(0,2),(Int(crc),4),(bytes.count,4),(bytes.count,4),(path.count,2),(0,2)])
            output.append(path); output.append(bytes)
            central.zipWords([(0x02014b50,4),(20,2),(20,2),(2048,2),(0,2),(0,2),(0,2),(Int(crc),4),(bytes.count,4),(bytes.count,4),(path.count,2),(0,2),(0,2),(0,2),(0,2),(0,4),(offset,4)])
            central.append(path)
        }
        let offset = output.count
        output.append(central)
        output.zipWords([(0x06054b50,4),(0,2),(0,2),(files.count,2),(files.count,2),(central.count,4),(offset,4),(0,2)])
        return output
    }
    init(zipData: Data) throws {
        let files = try StudyZIP.read(zipData)
        let root = FileWrapper(directoryWithFileWrappers: [:])
        for (path, bytes) in files {
            guard path == "manifest.json" || Self.validPath(path) else { throw StudyBackupError.invalid }
            let parts = path.split(separator: "/").map(String.init)
            var directory = root
            for part in parts.dropLast() {
                if let child = directory.fileWrappers?[part] { directory = child }
                else {
                    let child = FileWrapper(directoryWithFileWrappers: [:]); child.preferredFilename = part
                    directory.addFileWrapper(child); directory = child
                }
            }
            let file = FileWrapper(regularFileWithContents: bytes); file.preferredFilename = parts.last!
            directory.addFileWrapper(file)
        }
        try self.init(wrapper: root)
        guard Set(files.keys) == Set(manifest.entries.map(\.path)).union(["manifest.json"]) else { throw StudyBackupError.invalid }
        _ = try validatedBooks()
    }
}

private extension Data {
    mutating func zipWords(_ words: [(Int, Int)]) {
        for (value, count) in words { for shift in 0..<count { append(UInt8((value >> (8 * shift)) & 255)) } }
    }
}
private enum StudyZIP {
    static let crcTable: [UInt32] = (0..<256).map { index in
        var value = UInt32(index)
        for _ in 0..<8 { value = value & 1 == 0 ? value >> 1 : (value >> 1) ^ 0xedb88320 }
        return value
    }
    static func crc(_ data: Data) -> UInt32 {
        var result: UInt32 = 0xffffffff
        for byte in data { result = (result >> 8) ^ crcTable[Int((result ^ UInt32(byte)) & 255)] }
        return result ^ 0xffffffff
    }
    static func read(_ data: Data) throws -> [String: Data] {
        guard data.count >= 22, data.count <= StudyBackupArchive.maximumBytes + 8 * 1024 * 1024 else { throw StudyBackupError.tooLarge }
        func word(_ offset: Int, _ count: Int) throws -> Int {
            guard offset >= 0, count <= 4, offset <= data.count - count else { throw StudyBackupError.invalid }
            var result = 0
            for index in 0..<count { result |= Int(data[offset + index]) << (8 * index) }
            return result
        }
        let end = data.count - 22
        guard try word(end,4) == 0x06054b50, try word(end+4,2) == 0, try word(end+6,2) == 0,
              try word(end+20,2) == 0 else { throw StudyBackupError.invalid }
        let count = try word(end+10,2), centralSize = try word(end+12,4), start = try word(end+16,4)
        guard count > 0, count <= 10001, try word(end+8,2) == count,
              start <= end, centralSize == end-start else { throw StudyBackupError.invalid }
        var cursor = start, localEnd = 0, total = 0, files: [String: Data] = [:]
        for _ in 0..<count {
            guard cursor <= end-46, try word(cursor,4) == 0x02014b50 else { throw StudyBackupError.invalid }
            let flags = try word(cursor+8,2), method = try word(cursor+10,2), expectedCRC = try word(cursor+16,4)
            let size = try word(cursor+24,4), compressed = try word(cursor+20,4)
            let nameSize = try word(cursor+28,2), extra = try word(cursor+30,2), comment = try word(cursor+32,2), offset = try word(cursor+42,4)
            guard method == 0 else { throw StudyBackupError.unsupported }
            guard flags == 0 || flags == 2048, size == compressed, size <= StudyBackupArchive.maximumBytes,
                  total <= StudyBackupArchive.maximumBytes-size, try word(cursor+34,2) == 0,
                  try word(cursor+38,4) >> 16 & 0xf000 != 0xa000,
                  nameSize > 0, cursor+46+nameSize+extra+comment <= end,
                  offset == localEnd, offset <= start-30 else { throw StudyBackupError.invalid }
            let nameBytes = data.subdata(in: cursor+46..<cursor+46+nameSize)
            guard let name = String(data: nameBytes, encoding: .utf8), files[name] == nil,
                  try word(offset,4) == 0x04034b50, try word(offset+6,2) == flags, try word(offset+8,2) == method,
                  try word(offset+14,4) == expectedCRC, try word(offset+18,4) == size, try word(offset+22,4) == size,
                  try word(offset+26,2) == nameSize else { throw StudyBackupError.invalid }
            let localExtra = try word(offset+28,2), body = offset+30+nameSize+localExtra
            guard body <= start, size <= start-body,
                  data.subdata(in: offset+30..<offset+30+nameSize) == nameBytes else { throw StudyBackupError.invalid }
            let bytes = data.subdata(in: body..<body+size)
            guard crc(bytes) == UInt32(expectedCRC) else { throw StudyBackupError.invalid }
            files[name] = bytes; total += size; localEnd = body+size; cursor += 46+nameSize+extra+comment
        }
        guard cursor == end, localEnd == start else { throw StudyBackupError.invalid }
        return files
    }
}

struct StudyBackupManifest: Codable {
    struct Entry: Codable {
        var path: String
        var bytes: Int
        var sha256: String
    }
    let format: String
    let version: Int
    let createdAt: Date
    let origin: String
    let userID: String
    let title: String
    let entries: [Entry]
}

/// A package uses regular files instead of embedding PDFs as base64 in JSON.
/// Paths are generated by the app and verified before reading any record.
struct StudyBackupArchive {
    static let maximumBytes = 512 * 1024 * 1024
    let manifest: StudyBackupManifest
    let payloads: [String: Data]
    init(title: String, origin: String, userID: String, payloads: [String: Data]) throws {
        guard payloads["study.json"] != nil, payloads.count <= 10_000,
              payloads.values.reduce(0, { $0 + $1.count }) <= Self.maximumBytes else { throw StudyBackupError.tooLarge }
        self.payloads = payloads
        manifest = StudyBackupManifest(format: "ShufangStudyBackup", version: 1, createdAt: Date(), origin: origin, userID: userID, title: title,
            entries: payloads.keys.sorted().map { path in
                .init(path: path, bytes: payloads[path]!.count, sha256: Self.hash(payloads[path]!))
            })
    }
    init(wrapper: FileWrapper) throws {
        guard wrapper.isDirectory, let metadata = wrapper.fileWrappers?["manifest.json"]?.regularFileContents,
              metadata.count < 2 * 1024 * 1024 else { throw StudyBackupError.invalid }
        manifest = try JSONDecoder().decode(StudyBackupManifest.self, from: metadata)
        guard manifest.format == "ShufangStudyBackup" else { throw StudyBackupError.invalid }
        guard manifest.version == 1 else { throw StudyBackupError.unsupported }
        guard manifest.entries.count <= 10_000, Set(manifest.entries.map(\.path)).count == manifest.entries.count else { throw StudyBackupError.invalid }
        var data: [String: Data] = [:]
        var total = 0
        for entry in manifest.entries {
            guard Self.validPath(entry.path), entry.bytes >= 0, entry.bytes <= Self.maximumBytes,
                  total <= Self.maximumBytes - entry.bytes else { throw StudyBackupError.tooLarge }
            total += entry.bytes
            var file = wrapper
            for part in entry.path.split(separator: "/") {
                guard file.isDirectory, let next = file.fileWrappers?[String(part)], !next.isSymbolicLink else { throw StudyBackupError.invalid }
                file = next
            }
            guard file.isRegularFile, let bytes = file.regularFileContents, bytes.count == entry.bytes,
                  Self.hash(bytes) == entry.sha256,
                  (!entry.path.hasPrefix("attachments/") || entry.path == "attachments/" + Self.hash(bytes)) else { throw StudyBackupError.invalid }
            data[entry.path] = bytes
        }
        guard data["study.json"] != nil else { throw StudyBackupError.invalid }
        let records = try JSONDecoder().decode([StudyRecord].self, from: data["study.json"]!)
        guard Set(records.map(\.key)).count == records.count else { throw StudyBackupError.invalid }
        for (hash, size) in try Self.referencedAttachments(records) {
            guard data["attachments/" + hash]?.count == size else { throw StudyBackupError.invalid }
        }
        payloads = data
    }
    func fileWrapper() throws -> FileWrapper {
        let root = FileWrapper(directoryWithFileWrappers: [:])
        for (path, data) in payloads {
            guard Self.validPath(path) else { throw StudyBackupError.invalid }
            let parts = path.split(separator: "/").map(String.init)
            var directory = root
            for part in parts.dropLast() {
                if let child = directory.fileWrappers?[part] { directory = child }
                else {
                    let child = FileWrapper(directoryWithFileWrappers: [:]); child.preferredFilename = part
                    directory.addFileWrapper(child); directory = child
                }
            }
            let file = FileWrapper(regularFileWithContents: data); file.preferredFilename = parts.last!
            directory.addFileWrapper(file)
        }
        let metadata = FileWrapper(regularFileWithContents: try JSONEncoder().encode(manifest))
        metadata.preferredFilename = "manifest.json"; root.addFileWrapper(metadata)
        return root
    }
    func validateScope(origin: String, userID: String) throws {
        guard ServerConfiguration.sameOrigin(origin, manifest.origin), userID == manifest.userID else { throw StudyBackupError.wrongAccount }
    }
    var records: [StudyRecord] { (try? JSONDecoder().decode([StudyRecord].self, from: payloads["study.json"] ?? Data())) ?? [] }
    var books: [(String, OfflineBookPackage)] {
        payloads.keys.filter { $0.hasPrefix("books/") && $0.hasSuffix("/package.json") }.sorted().compactMap { path in
            guard let data = payloads[path], let package = try? JSONDecoder().decode(OfflineBookPackage.self, from: data) else { return nil }
            return (String(path.dropLast("package.json".count)), package)
        }
    }
    func validatedBooks() throws -> [(String, OfflineBookPackage)] {
        let paths = payloads.keys.filter { $0.hasPrefix("books/") && $0.hasSuffix("/package.json") }
        let packages = books
        guard paths.count == packages.count, Set(packages.map { $0.1.book.id }).count == packages.count else { throw StudyBackupError.invalid }
        for (prefix, package) in packages {
            guard prefix == "books/" + Self.hash(Data(package.book.id.utf8)) + "/",
                  package.chapters.count == package.contents.count,
                  zip(package.chapters, package.contents).allSatisfy({ $0.0.id == $0.1.id }),
                  !package.contents.isEmpty || package.hasPDF else { throw StudyBackupError.invalid }
            if package.hasPDF {
                guard let pdf = payloads[prefix + "source.pdf"], pdf.starts(with: Data("%PDF".utf8)), pdf.count <= 256 * 1024 * 1024 else { throw StudyBackupError.invalid }
            }
        }
        return packages
    }
    static func referencedAttachments(_ records: [StudyRecord]) throws -> [String: Int] {
        var result: [String: Int] = [:]
        func insert(_ fields: [String: JSONValue]) throws {
            guard let hash = fields["sha256"]?.string, hash.count == 64,
                  hash.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
                  let size = fields["size"]?.number, size.isFinite, size >= 0,
                  size <= Double(256 * 1024 * 1024), size.rounded(.towardZero) == size,
                  result[hash] == nil || result[hash] == Int(size) else { throw StudyBackupError.invalid }
            result[hash] = Int(size)
        }
        func collect(_ value: JSONValue) throws {
            switch value {
            case .object(let fields):
                for key in ["$attachment", "$blob"] {
                    if let value = fields[key] {
                        guard let manifest = value.object else { throw StudyBackupError.invalid }
                        try insert(manifest)
                    }
                }
                for child in fields.values { try collect(child) }
            case .array(let values): for child in values { try collect(child) }
            default: break
            }
        }
        for record in records {
            try collect(.object(record.fields))
            if record.kind == "sources" { try insert(record.fields) }
        }
        return result
    }
    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func validPath(_ path: String) -> Bool {
        if path == "study.json" { return true }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\\") }), !path.hasPrefix("/") else { return false }
        if parts.count == 3 && parts[0] == "books" {
            return parts[1].count == 64 && parts[1].allSatisfy(\.isHexDigit) && ["package.json", "source.pdf"].contains(String(parts[2]))
        }
        return parts.count == 2 && parts[0] == "attachments" && parts[1].count == 64 && parts[1].allSatisfy(\.isHexDigit)
    }
}

