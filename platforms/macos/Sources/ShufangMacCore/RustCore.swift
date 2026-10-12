import Foundation
import Darwin

public enum CoreError: Error, LocalizedError, Equatable {
    case unavailable(String)
    case rejected(String)
    public var errorDescription: String? {
        switch self {
        case .unavailable(let reason), .rejected(let reason): return reason
        }
    }
}

/// ABI 1 ownership stays inside this adapter. All calls run on one private queue.
public final class RustCore: @unchecked Sendable {
    private typealias Version = @convention(c) () -> UInt32
    private typealias Allocate = @convention(c) (Int) -> UInt
    private typealias Length = @convention(c) (UInt) -> Int
    private typealias Execute = @convention(c) (UInt) -> UInt
    private typealias Free = @convention(c) (UInt) -> Void
    private let handle: UnsafeMutableRawPointer
    private let allocate: Allocate
    private let length: Length
    private let execute: Execute
    private let free: Free
    private let queue = DispatchQueue(label: "org.shufang.mac.core", qos: .userInitiated)

    public func installKeychain() throws {
        typealias Store = @convention(c) (UnsafePointer<UInt8>?, Int, UnsafePointer<UInt8>?, Int, UnsafePointer<UInt8>?, Int) -> Int32
        typealias Load = @convention(c) (UnsafePointer<UInt8>?, Int, UnsafePointer<UInt8>?, Int, UnsafeMutablePointer<UInt8>?, Int) -> Int
        typealias Install = @convention(c) (Store, Load) -> UInt32
        guard let symbol = dlsym(handle, "core_install_mac_credentials") else {
            throw CoreError.unavailable("共享核心缺少 macOS 钥匙串适配接口")
        }
        let install = unsafeBitCast(symbol, to: Install.self)
        guard install(keychainStore, keychainLoad) == 1 else {
            throw CoreError.unavailable("钥匙串适配已由其他宿主注册")
        }
    }

    public init(library: URL) throws {
        guard library.isFileURL, let loaded = dlopen(library.path, RTLD_NOW | RTLD_LOCAL) else {
            throw CoreError.unavailable("无法加载共享核心，请重新安装应用")
        }
        func symbol<T>(_ name: String, _ type: T.Type) throws -> T {
            guard let pointer = dlsym(loaded, name) else {
                throw CoreError.unavailable("共享核心缺少接口：\(name)")
            }
            return unsafeBitCast(pointer, to: type)
        }
        do {
            let version = try symbol("core_abi_version", Version.self)
            guard version() == 1 else { throw CoreError.unavailable("不支持的共享核心 ABI") }
            allocate = try symbol("core_alloc", Allocate.self)
            length = try symbol("core_buffer_len", Length.self)
            execute = try symbol("core_execute", Execute.self)
            free = try symbol("core_free", Free.self)
            handle = loaded
        } catch {
            dlclose(loaded)
            throw error
        }
    }

    // The library remains resident until process exit. Rust jobs may still be
    // unwinding after sessionClose; unloading their machine code is unsafe.

    public func call(_ command: String, arguments: [String: Any] = [:]) async throws -> Data {
        var request = arguments
        request["version"] = 1
        request["command"] = command
        let data = try JSONSerialization.data(withJSONObject: request)
        return try await rawCall(data)
    }

    /// Raw JSON allows callers to retain escaped UTF-16 and unknown fields intact.
    public func rawCall(_ request: Data) async throws -> Data {
        try Task.checkCancellation()
        return try await withCheckedThrowingContinuation { continuation in
            queue.async { [self] in
                do { continuation.resume(returning: try callOnQueue(request)) }
                catch { continuation.resume(throwing: error) }
            }
        }
    }

    private func callOnQueue(_ request: Data) throws -> Data {
        guard request.count <= 16 * 1024 * 1024 else { throw CoreError.rejected("request_too_large") }
        let input = allocate(request.count)
        guard input != 0, length(input) == request.count,
              let pointer = UnsafeMutableRawPointer(bitPattern: input) else {
            if input != 0 { free(input) }
            throw CoreError.unavailable("共享核心缓冲区申请失败")
        }
        defer { free(input) }
        request.copyBytes(to: pointer.assumingMemoryBound(to: UInt8.self), count: request.count)
        let output = execute(input)
        guard output != 0 else { throw CoreError.unavailable("共享核心没有返回结果") }
        defer { free(output) }
        let count = length(output)
        guard count > 0, let result = UnsafeRawPointer(bitPattern: output) else {
            throw CoreError.unavailable("共享核心返回无效缓冲区")
        }
        return Data(bytes: result, count: count)
    }

    public static func value(_ response: Data) throws -> Any {
        guard let envelope = try JSONSerialization.jsonObject(with: response) as? [String: Any],
              let ok = envelope["ok"] as? Bool else { throw CoreError.unavailable("invalid_response") }
        guard ok else {
            let error = envelope["error"] as? [String: Any]
            throw CoreError.rejected(error?["code"] as? String ?? "core_error")
        }
        return envelope["value"] ?? NSNull()
    }
}

/// Actor admission plus the Rust queue serializes writes and close per workspace.
public actor LibrarySession {
    private let core: RustCore
    private var id: String?
    private var closing = false
    private var opening = false
    private var active = 0
    private var drained: [CheckedContinuation<Void, Never>] = []

    public init(core: RustCore) { self.core = core }

    public func open(database: URL, workspace: String, replica: String) async throws {
        guard id == nil, !closing, !opening else { throw CoreError.rejected("session_already_open") }
        // Mark admission before suspension so two opens cannot race.
        opening = true
        active += 1
        defer { opening = false; finishCommand() }
        let response = try await core.call("sessionOpen", arguments: [
            "path": database.path, "workspace": workspace, "replica": replica,
        ])
        guard let value = try RustCore.value(response) as? [String: Any],
              let session = value["session"] as? String else { throw CoreError.unavailable("invalid_session") }
        id = session
    }

    public func command(_ action: String, arguments: [String: Any] = [:]) async throws -> Data {
        guard let session = id, !closing else { throw CoreError.rejected("session_closed") }
        active += 1
        defer { finishCommand() }
        let response = try await core.call("sessionCommand", arguments: [
            "session": session, "action": action, "args": arguments,
        ])
        _ = try RustCore.value(response)
        return response
    }

    public func close() async throws {
        guard !closing else { return }
        closing = true
        defer { closing = false }
        if active > 0 {
            await withCheckedContinuation { drained.append($0) }
        }
        guard let session = id else { return }
        let response = try await core.call("sessionClose", arguments: ["session": session])
        _ = try RustCore.value(response)
        id = nil
    }

    private func finishCommand() {
        active -= 1
        if active == 0 {
            let waiting = drained
            drained.removeAll()
            waiting.forEach { $0.resume() }
        }
    }
}
