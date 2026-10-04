import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "../..");
const name = process.argv[2];
if (!/^\d{8}-through-mysql\d{4}-sqlite\d{4}(-indexeddb\d{4})?(-canonical)?$/.test(name ?? "")) throw Error("Expected versioned archive name");
const destination = path.join(root, "app/db/migration-history", name);
if (fs.existsSync(destination + ".tar.gz") || fs.existsSync(destination + ".manifest.json")) throw Error("History is immutable");
function list(relative) {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) throw Error("Migration symlinks are not supported");
    const child = `${relative}/${entry.name}`;
    return entry.isDirectory() ? list(child) : [child];
  });
}
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const files = [...list("app/db/migrations"), ...list("base/crates/sqlite/migrations"),
  ...(name.includes("-indexeddb") ? list("app/db/indexeddb-migrations") : [])].sort();
// Git's committed blobs are the release source of truth. Windows may expose
// CRLF in a checkout even when .gitattributes commits LF. Never record one
// byte stream in the manifest and package another in the archive.
const staging = fs.mkdtempSync(path.join(root, ".archive-"));
try {
  for (const file of files) {
    const working = fs.readFileSync(path.join(root, file));
    let bytes;
    try {
      bytes = execFileSync("git", ["show", `HEAD:${file}`], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
      if (!working.equals(bytes) && (file.endsWith(".source") || working.toString("utf8").replace(/\r\n/g, "\n") !== bytes.toString("utf8"))) {
        throw Error(`Tracked migration differs from HEAD: ${file}`);
      }
    } catch (error) {
      if (String(error).includes("Tracked migration differs")) throw error;
      // A newly appended migration is not in HEAD yet. Normalize only files
      // governed by the repository's LF attributes; binary .source stays raw.
      bytes = file.endsWith(".source") ? working : Buffer.from(working.toString("utf8").replace(/\r\n/g, "\n"));
    }
    const target = path.join(staging, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  execFileSync("tar", ["-czf", destination + ".tar.gz", ...files], { cwd: staging });
} finally {
  if (!path.resolve(staging).startsWith(path.resolve(root) + path.sep) || !path.basename(staging).startsWith(".archive-")) {
    throw Error("Unsafe staging path");
  }
  fs.rmSync(staging, { recursive: true, force: true });
}
fs.writeFileSync(destination + ".manifest.json", JSON.stringify({
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  source: "Canonical committed Git blobs; newly appended files use LF-normalized working bytes",
  files: files.map(file => ({ path: file, sha256: hash(execFileSync("tar", ["-xOzf", destination + ".tar.gz", file], { maxBuffer: 32 * 1024 * 1024 })) })),
  archiveSha256: hash(fs.readFileSync(destination + ".tar.gz")),
  recovery: "Extract separately and verify checksums. This archive restores migration source only; restore user data from an independent database and original-file backup with all writers stopped.",
}, null, 2) + "\n");
console.log(`Archived ${files.length} source files: ${name}`);
