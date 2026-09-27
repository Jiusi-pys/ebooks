CREATE TABLE IF NOT EXISTS sync_heads (workspace VARCHAR(128) PRIMARY KEY, node_id VARCHAR(128) NOT NULL, epoch VARCHAR(128) NOT NULL, seq BIGINT UNSIGNED NOT NULL DEFAULT 0, clock VARCHAR(40) NOT NULL DEFAULT '0:0') DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sync_operations (workspace VARCHAR(128) NOT NULL, operation_id VARCHAR(128) NOT NULL, seq BIGINT UNSIGNED NOT NULL, digest CHAR(64) NOT NULL, body LONGTEXT NOT NULL, PRIMARY KEY(workspace,operation_id), UNIQUE KEY sync_sequence(workspace,seq)) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sync_entities (workspace VARCHAR(128) NOT NULL, kind VARCHAR(32) NOT NULL, entity_id VARCHAR(128) NOT NULL, state LONGTEXT NOT NULL, PRIMARY KEY(workspace,kind,entity_id)) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sync_cursors (workspace VARCHAR(128) NOT NULL, peer VARCHAR(128) NOT NULL, checkpoint TEXT NOT NULL, PRIMARY KEY(workspace,peer)) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sync_credentials (workspace VARCHAR(128) NOT NULL, credential_id VARCHAR(128) NOT NULL, digest CHAR(64) NOT NULL, revoked BOOLEAN NOT NULL DEFAULT FALSE, PRIMARY KEY(workspace,credential_id)) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sync_snapshots (id VARCHAR(128) PRIMARY KEY, workspace VARCHAR(128) NOT NULL, checkpoint TEXT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sync_snapshot_entities (snapshot_id VARCHAR(128) NOT NULL, kind VARCHAR(32) NOT NULL, entity_id VARCHAR(128) NOT NULL, state LONGTEXT NOT NULL, PRIMARY KEY(snapshot_id,kind,entity_id)) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
