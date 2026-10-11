import CryptoKit
import Foundation
import Security

public struct KeychainVault {
    public let service: String
    public init(service: String = "org.shufang.mac.core") { self.service = service }
    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: account, kSecAttrSynchronizable as String: false]
    }
    public func load(_ account: String) throws -> Data? {
        var request = query(account)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let code = SecItemCopyMatching(request as CFDictionary, &result)
        if code == errSecItemNotFound { return nil }
        guard code == errSecSuccess, let data = result as? Data else {
            throw CoreError.unavailable("无法读取钥匙串（\(code)），请解锁钥匙串后重试")
        }
        return data
    }
    public func save(_ account: String, data: Data) throws {
        let request = query(account)
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var code = SecItemUpdate(request as CFDictionary, attributes as CFDictionary)
        if code == errSecItemNotFound {
            code = SecItemAdd(request.merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard code == errSecSuccess else { throw CoreError.unavailable("无法保存钥匙串（\(code)）") }
    }
    public func remove(_ account: String) throws {
        let code = SecItemDelete(query(account) as CFDictionary)
        guard code == errSecSuccess || code == errSecItemNotFound else {
            throw CoreError.unavailable("无法移除钥匙串条目（\(code)）")
        }
    }
    public static func workspaceAccount(root: String, provider: String) -> String {
        let normalized = URL(fileURLWithPath: root).standardizedFileURL.resolvingSymlinksInPath().path
        return SHA256.hash(data: Data(normalized.utf8)).map { String(format: "%02x", $0) }.joined() + "." + provider
    }
}

private func text(_ pointer: UnsafePointer<UInt8>?, _ count: Int) -> String? {
    guard count >= 0, count <= 16384, let pointer else { return nil }
    return String(bytes: UnsafeBufferPointer(start: pointer, count: count), encoding: .utf8)
}

func keychainStore(_ root: UnsafePointer<UInt8>?, _ rootLength: Int,
                   _ provider: UnsafePointer<UInt8>?, _ providerLength: Int,
                   _ secret: UnsafePointer<UInt8>?, _ secretLength: Int) -> Int32 {
    guard let root = text(root, rootLength), let provider = text(provider, providerLength),
          let secret, secretLength >= 0, secretLength <= 4096 else { return -1 }
    do {
        try KeychainVault().save(KeychainVault.workspaceAccount(root: root, provider: provider),
                                data: Data(bytes: secret, count: secretLength))
        return 0
    } catch { return -1 }
}

func keychainLoad(_ root: UnsafePointer<UInt8>?, _ rootLength: Int,
                  _ provider: UnsafePointer<UInt8>?, _ providerLength: Int,
                  _ output: UnsafeMutablePointer<UInt8>?, _ capacity: Int) -> Int {
    guard let root = text(root, rootLength), let provider = text(provider, providerLength),
          let output, capacity >= 0, capacity <= 4096 else { return -1 }
    do {
        guard let data = try KeychainVault().load(KeychainVault.workspaceAccount(root: root, provider: provider)) else { return -2 }
        guard data.count <= capacity else { return -1 }
        data.copyBytes(to: output, count: data.count)
        return data.count
    } catch { return -1 }
}
