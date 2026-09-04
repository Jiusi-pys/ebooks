import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

const MIN_SECRET_BYTES = 32;
const SESSION_SECRET_FILE = "session-secret";
const DATA_SECRET_FILE = "data-secret";

function validateSecret(value: string, source: string): string {
  if (Buffer.byteLength(value, "utf8") < MIN_SECRET_BYTES) {
    throw new Error(`${source} must contain at least 32 bytes`);
  }
  return value;
}

function readGeneratedSecret(path: string): string {
  const value = readFileSync(path, { encoding: "utf8" }).trim();
  return validateSecret(value, path);
}

function resolvePersistentSecret(
  environment: Readonly<Record<string, string | undefined>>,
  environmentName: string,
  fileName: string,
  runtimeDirectory: string
): string {
  const configured = environment[environmentName]?.trim();
  if (configured) return validateSecret(configured, environmentName);

  mkdirSync(runtimeDirectory, { recursive: true });
  const path = resolve(runtimeDirectory, fileName);
  try {
    return readGeneratedSecret(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const generated = randomBytes(32).toString("base64url");
  try {
    writeFileSync(path, `${generated}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new Error(
        `Unable to persist the generated ${fileName}; configure ${environmentName}`,
        { cause: error }
      );
    }
    return readGeneratedSecret(path);
  }
}

/**
 * Resolve the independent session-signing key. A local installation can omit
 * APP_SESSION_SECRET and gets a stable random key in the ignored runtime dir.
 */
export function resolveSessionSecret(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  runtimeDirectory = resolve(process.cwd(), ".runtime")
): string {
  return resolvePersistentSecret(
    environment,
    "APP_SESSION_SECRET",
    SESSION_SECRET_FILE,
    runtimeDirectory
  );
}

/** Resolve the key used only for encrypted application data. */
export function resolveDataSecret(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  runtimeDirectory = resolve(process.cwd(), ".runtime")
): string {
  return resolvePersistentSecret(
    environment,
    "APP_DATA_SECRET",
    DATA_SECRET_FILE,
    runtimeDirectory
  );
}
