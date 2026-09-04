import { describe, expect, it } from "vitest";
import {
  CredentialFormatError,
  decryptUsername,
  encryptUsername,
  hashPassword,
  normalizeUsername,
  validatePassword,
  validateUsername,
  verifyPassword,
} from "./user-credentials";

describe("stored user credentials", () => {
  it("hashes passwords with a fresh salt and verifies them", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");
    expect(first).not.toBe(second);
    expect(first).not.toContain("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", first)).toBe(
      true
    );
    expect(await verifyPassword("wrong password", first)).toBe(false);
    expect(await verifyPassword("anything", "malformed")).toBe(false);
  });

  it("encrypts usernames with authentication and rejects tampering", () => {
    const encrypted = encryptUsername("阅读者", "application-secret");
    expect(encrypted).not.toContain("阅读者");
    expect(decryptUsername(encrypted, "application-secret")).toBe("阅读者");
    const changed = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;
    expect(() => decryptUsername(changed, "application-secret")).toThrow(
      CredentialFormatError
    );
    expect(() => decryptUsername(encrypted, "wrong-secret")).toThrow(
      CredentialFormatError
    );
  });

  it("normalizes and validates account input", () => {
    expect(normalizeUsername("  Ａlice  ")).toBe("Alice");
    expect(validateUsername("A")).not.toBeNull();
    expect(validateUsername("正常用户")).toBeNull();
    expect(validatePassword("short")).not.toBeNull();
    expect(validatePassword("long-enough-password")).toBeNull();
  });
});
