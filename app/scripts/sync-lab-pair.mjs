import { readFileSync, writeFileSync } from "node:fs";
const root = ".runtime/sync-lab";
const config = JSON.parse(readFileSync(`${root}/credentials.json`));
async function pair(port, id) {
  const response = await fetch(`http://127.0.0.1:${port}/api/v2/peers`, {
    method: "POST",
    headers: { "X-API-Key": config.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!response.ok)
    throw new Error(
      `pair ${port}: ${response.status} ${await response.text()}`
    );
  return response.json();
}
const windows = await pair(3101, "linux-lab");
const linux = await pair(3102, "windows-lab");
for (const [name, peer] of [
  [
    "windows",
    { id: "linux-lab", url: "http://127.0.0.1:3102", token: linux.token },
  ],
  [
    "linux",
    { id: "windows-lab", url: "http://127.0.0.1:13101", token: windows.token },
  ],
]) {
  const path = `${root}/${name}.env`;
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(/^SYNC_PEERS_JSON=.*\n?/m, "") +
      `SYNC_PEERS_JSON=${JSON.stringify([peer])}\n`,
    { mode: 0o600 }
  );
}
console.log(
  "Both nodes paired. Restart the two lab applications to load peer configuration."
);
