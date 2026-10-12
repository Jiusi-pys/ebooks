import Foundation

/// Read-only host metadata probe through the core's SQLite runtime.
public enum RestoreIdentity {
    public static func read(core: RustCore, database: URL) async throws -> (workspace: String, replica: String) {
        guard let value = try RustCore.value(await core.call("sessionMacIdentity", arguments: ["database": database.path])) as? [String: String],
              let workspace = value["workspace"], let replica = value["replica"] else { throw CoreError.rejected("invalid_restore_identity") }
        return (workspace, replica)
    }
}
