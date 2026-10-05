// Public test data only. This mirrors app/api/auth.ts createSessionToken.
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
const secret = "public-node-rust-session-test-key-0001";
const payload = { v: 2, sub: "用户甲", iat: 1800000000, exp: 1800043200,
  nonce: "public-test-nonce-0001", setup: false, cv: 7 };
const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
const signature = createHmac("sha256", `${secret}\0shufang-session-v2`)
  .update(encoded).digest("base64url");
writeFileSync(new URL("node-session.json", import.meta.url),
  JSON.stringify({ secret, token: `${encoded}.${signature}` }, null, 2) + "\n");
