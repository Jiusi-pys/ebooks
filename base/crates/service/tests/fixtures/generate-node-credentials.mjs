import {createCipheriv, createHash, scryptSync} from "node:crypto";
import {writeFileSync} from "node:fs";
const secret = "public-node-rust-data-test-key-0001";
const iv = Buffer.alloc(12, 3), salt = Buffer.alloc(16, 5);
const key = createHash("sha256").update(`${secret}\0shufang-username-encryption-v1`).digest();
const cipher = createCipheriv("aes-256-gcm",key,iv);
const encrypted = Buffer.concat([cipher.update("用户AB","utf8"),cipher.final()]);
const derived = scryptSync("public-long-test-password",salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024});
writeFileSync(new URL("node-credentials.json",import.meta.url), JSON.stringify({secret,
  encrypted: ["aes-256-gcm","v1",iv.toString("base64url"),cipher.getAuthTag().toString("base64url"),encrypted.toString("base64url")].join("$"),
  hash:["scrypt",32768,8,3,salt.toString("base64url"),derived.toString("base64url")].join("$")},null,2)+"\n");
