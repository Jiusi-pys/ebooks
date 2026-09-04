import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 3;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const USERNAME_CIPHER = "aes-256-gcm";
const USERNAME_FORMAT = "v1";

function deriveScrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export class CredentialFormatError extends Error {}

export function normalizeUsername(value: string): string {
  return value.trim().normalize("NFKC");
}

export function validateUsername(value: string): string | null {
  const username = normalizeUsername(value);
  if (username.length < 2 || username.length > 64) {
    return "用户名长度需为 2–64 个字符";
  }
  if (/\p{Cc}/u.test(username)) return "用户名不能包含控制字符";
  return null;
}

export function validatePassword(value: string): string | null {
  if (value.length < 12) return "新密码至少需要 12 个字符";
  if (value.length > 1024) return "密码不能超过 1024 个字符";
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await deriveScrypt(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEMORY,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encodedHash: string
): Promise<boolean> {
  const parts = encodedHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;
  try {
    const salt = Buffer.from(parts[4] ?? "", "base64url");
    const expected = Buffer.from(parts[5] ?? "", "base64url");
    if (salt.length !== 16 || expected.length !== SCRYPT_KEY_LENGTH)
      return false;
    const actual = await deriveScrypt(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: SCRYPT_MAX_MEMORY,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function usernameKey(appSecret: string): Buffer {
  return createHash("sha256")
    .update(`${appSecret}\0shufang-username-encryption-v1`, "utf8")
    .digest();
}

export function encryptUsername(username: string, appSecret: string): string {
  const normalized = normalizeUsername(username);
  const iv = randomBytes(12);
  const cipher = createCipheriv(USERNAME_CIPHER, usernameKey(appSecret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(normalized, "utf8"),
    cipher.final(),
  ]);
  return [
    USERNAME_CIPHER,
    USERNAME_FORMAT,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join("$");
}

export function decryptUsername(value: string, appSecret: string): string {
  const parts = value.split("$");
  if (
    parts.length !== 5 ||
    parts[0] !== USERNAME_CIPHER ||
    parts[1] !== USERNAME_FORMAT
  ) {
    throw new CredentialFormatError("用户名密文格式无效");
  }
  try {
    const iv = Buffer.from(parts[2] ?? "", "base64url");
    const tag = Buffer.from(parts[3] ?? "", "base64url");
    const ciphertext = Buffer.from(parts[4] ?? "", "base64url");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
      throw new Error("invalid encrypted username lengths");
    }
    const decipher = createDecipheriv(
      USERNAME_CIPHER,
      usernameKey(appSecret),
      iv
    );
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof CredentialFormatError) throw error;
    throw new CredentialFormatError("无法解密用户名");
  }
}
