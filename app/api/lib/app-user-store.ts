import { and, eq } from "drizzle-orm";
import { appUsers } from "@db/schema";
import { getDb } from "../queries/connection";

export interface StoredAppUser {
  id: number;
  usernameEncrypted: string;
  passwordHash: string;
  credentialVersion: number;
}

export interface AppUserStore {
  getSingleton(): Promise<StoredAppUser | null>;
  createInitial(input: {
    usernameEncrypted: string;
    passwordHash: string;
  }): Promise<boolean>;
  updateCredentials(input: {
    expectedVersion: number;
    usernameEncrypted: string;
    passwordHash: string;
  }): Promise<boolean>;
}

function isDuplicateEntry(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ER_DUP_ENTRY"
  );
}

export const mysqlAppUserStore: AppUserStore = {
  async getSingleton() {
    const rows = await getDb()
      .select({
        id: appUsers.id,
        usernameEncrypted: appUsers.usernameEncrypted,
        passwordHash: appUsers.passwordHash,
        credentialVersion: appUsers.credentialVersion,
      })
      .from(appUsers)
      .where(eq(appUsers.id, 1))
      .limit(1);
    return rows[0] ?? null;
  },

  async createInitial(input) {
    try {
      await getDb()
        .insert(appUsers)
        .values({ id: 1, ...input });
      return true;
    } catch (error) {
      if (isDuplicateEntry(error)) return false;
      throw error;
    }
  },

  async updateCredentials(input) {
    const result = await getDb()
      .update(appUsers)
      .set({
        usernameEncrypted: input.usernameEncrypted,
        passwordHash: input.passwordHash,
        credentialVersion: input.expectedVersion + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(appUsers.id, 1),
          eq(appUsers.credentialVersion, input.expectedVersion)
        )
      );
    return (
      Number(
        (result[0] as { affectedRows?: number } | null | undefined)
          ?.affectedRows ?? 0
      ) === 1
    );
  },
};
