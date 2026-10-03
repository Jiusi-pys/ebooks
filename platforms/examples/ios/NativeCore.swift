import Foundation

// Import shufang.h through the application's bridging header and link the Rust
// static library built for its exact iOS device/simulator target.
enum NativeCore {
    static func execute(_ request: String) throws -> Data {
        guard core_abi_version() == 1 else { throw Failure.abi }
        let bytes = Array(request.utf8)
        let input = core_alloc(bytes.count)
        guard let pointer = UnsafeMutableRawPointer(bitPattern: input) else { throw Failure.allocation }
        defer { core_free(input) }
        bytes.withUnsafeBytes { buffer in
            if let base = buffer.baseAddress { pointer.copyMemory(from: base, byteCount: bytes.count) }
        }
        let output = core_execute(input)
        guard let result = UnsafeRawPointer(bitPattern: output) else { throw Failure.execution }
        defer { core_free(output) }
        return Data(bytes: result, count: core_buffer_len(output))
    }
    enum Failure: Error { case abi, allocation, execution }
}
