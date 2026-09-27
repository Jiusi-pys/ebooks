// Local lab bootstrap. Generated credentials live only in ignored .runtime/.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
const root = ".runtime/sync-lab";
mkdirSync(root, { recursive: true });
const configPath = `${root}/credentials.json`;
const config = existsSync(configPath)
  ? JSON.parse(readFileSync(configPath))
  : {
      rootPassword: randomBytes(24).toString("hex"),
      ownerPassword: randomBytes(24).toString("hex"),
      apiKey: randomBytes(32).toString("hex"),
      dataSecret: randomBytes(32).toString("hex"),
      sessionSecret: randomBytes(32).toString("hex"),
    };
writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
config.linuxDbPassword ??= randomBytes(24).toString("hex");
writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
writeFileSync(
  `${root}/mysql.env`,
  `MYSQL_ROOT_PASSWORD=${config.rootPassword}\nMYSQL_DATABASE=shufang_sync_lab\n`,
  { mode: 0o600 }
);
writeFileSync(
  `${root}/windows.env`,
  [
    "NODE_ENV=production",
    "HOST=127.0.0.1",
    "PORT=3101",
    "APP_ID=sync-lab-owner",
    `APP_SECRET=${config.ownerPassword}`,
    `APP_DATA_SECRET=${config.dataSecret}`,
    `APP_SESSION_SECRET=${config.sessionSecret}`,
    `OPEN_API_KEY=${config.apiKey}`,
    `DATABASE_URL=mysql://root:${config.rootPassword}@127.0.0.1:13307/shufang_sync_lab`,
    "SYNC_ENABLED=true",
    "SYNC_WORKSPACE_ID=windows-linux-lab",
    "SYNC_NODE_ID=windows-lab",
    "SYNC_BLOB_DIR=.runtime/sync-lab/windows-blobs",
    "AUTO_UPDATE_ENABLED=false",
  ].join("\n") + "\n",
  { mode: 0o600 }
);
writeFileSync(
  `${root}/linux.env`,
  readFileSync(`${root}/windows.env`, "utf8")
    .replace("PORT=3101", "PORT=3102")
    .replace(
      /DATABASE_URL=.*/,
      `DATABASE_URL=mysql://sync_20260927:${config.linuxDbPassword}@172.18.0.2:3306/shufang_sync_20260927`
    )
    .replace("SYNC_NODE_ID=windows-lab", "SYNC_NODE_ID=linux-lab")
    .replace(
      "SYNC_BLOB_DIR=.runtime/sync-lab/windows-blobs",
      "SYNC_BLOB_DIR=/lab/blobs"
    ),
  { mode: 0o600 }
);
writeFileSync(
  `${root}/bootstrap.sql`,
  `CREATE DATABASE IF NOT EXISTS shufang_sync_20260927; CREATE USER IF NOT EXISTS 'sync_20260927'@'%' IDENTIFIED BY '${config.linuxDbPassword}'; GRANT ALL ON shufang_sync_20260927.* TO 'sync_20260927'@'%';`,
  { mode: 0o600 }
);
const inspect = spawnSync("docker", ["inspect", "shufang-sync-lab-db"], {
  stdio: "ignore",
});
if (inspect.status !== 0) {
  const result = spawnSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      "shufang-sync-lab-db",
      "--env-file",
      `${root}/mysql.env`,
      "-p",
      "127.0.0.1:13307:3306",
      "--mount",
      "type=volume,src=shufang-sync-lab-db,dst=/var/lib/mysql",
      "mysql:8.4",
      "--max-allowed-packet=268435456",
    ],
    { stdio: "inherit" }
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(
  "Lab configuration prepared; MySQL listens on loopback port 13307."
);
