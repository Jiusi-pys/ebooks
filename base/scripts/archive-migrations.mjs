import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "../..");
const name = process.argv[2];
if (!/^\d{8}-through-mysql\d{4}-sqlite\d{4}(-indexeddb\d{4})?$/.test(name ?? "")) throw Error("Expected versioned archive name");
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
execFileSync("tar", ["-czf", destination + ".tar.gz", ...files], { cwd: root });
fs.writeFileSync(destination + ".manifest.json", JSON.stringify({
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  source: "Working tree source; immutable prior migrations plus appended native migrations",
  files: files.map(file => ({ path: file, sha256: hash(fs.readFileSync(path.join(root, file))) })),
  archiveSha256: hash(fs.readFileSync(destination + ".tar.gz")),
  recovery: "Extract separately and verify checksums. This archive restores migration source only; restore user data from an independent database and original-file backup with all writers stopped.",
}, null, 2) + "\n");
console.log(`Archived ${files.length} source files: ${name}`);
