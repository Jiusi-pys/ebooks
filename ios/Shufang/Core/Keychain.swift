import Foundation
import Security

enum Keychain {
    private static let service = "com.shufang.reader.connection"
    struct Connection: Codable {
        let address: String
        let userID: String
        let sessionToken: String
        let expiresAt: Date
        func configuration() throws -> ServerConfiguration {
            try ServerConfiguration(address: address, userID: userID, sessionToken: sessionToken,
                                    expiresAt: expiresAt, allowExpired: true)
        }
    }
    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }
    private static func account(_ address: String) -> String { "session.\(address)" }
    static func load(address: String) throws -> Connection? {
        var q = query(account(address))
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw failure(status) }
        return try JSONDecoder().decode(Connection.self, from: data)
    }
    static func save(_ connection: Connection) throws {
        let data = try JSONEncoder().encode(connection)
        let values: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let q = query(account(connection.address))
        let status = SecItemUpdate(q as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            var addedQuery = q
            values.forEach { addedQuery[$0.key] = $0.value }
            let added = SecItemAdd(addedQuery as CFDictionary, nil)
            guard added == errSecSuccess else { throw failure(added) }
        } else if status != errSecSuccess { throw failure(status) }
    }
    static func delete(address: String) throws { try delete(account(address)) }
    static func deleteLegacyAPIKey() throws { try delete("active-server") }
    private static func delete(_ account: String) throws {
        let status = SecItemDelete(query(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw failure(status) }
    }
    private static func failure(_ code: OSStatus) -> NSError {
        let message = code == errSecMissingEntitlement
            ? "应用签名缺少钥匙串权限，请通过 Xcode 重新构建安装（\(code)）。"
            : "无法访问钥匙串（\(code)），请解锁设备后重试。"
        return NSError(domain: "Keychain", code: Int(code), userInfo: [NSLocalizedDescriptionKey: message])
    }
}
