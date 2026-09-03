import { beforeEach, describe, expect, it, vi } from "vitest";

interface ReceiptRow {
  deliveryId: string;
  eventType: string;
  payloadHash: string;
}

const state = vi.hoisted(() => ({
  receiptTable: null as unknown,
  noteTable: null as unknown,
  receipts: new Map<string, ReceiptRow>(),
  noteWrites: 0,
  failNoteWrite: false,
  failGetDb: false,
  transactionAttempts: 0,
  transactionFailureCodes: [] as string[],
  cleanupFailureCodes: [] as string[],
  receiptCleanupRuns: 0,
  receiptDeletesInsideTransaction: 0,
  cleanupGate: null as Promise<void> | null,
  releaseCleanup: null as (() => void) | null,
  events: [] as Record<string, unknown>[],
}));

vi.mock("./queries/connection", () => {
  const createOperations = (insideTransaction: boolean) => ({
    select: () => ({
      from: (table: unknown) => {
        const builder = {
          where: () => builder,
          limit: async (count: number) =>
            table === state.receiptTable
              ? [...state.receipts.values()].slice(0, count)
              : [],
          then: (
            resolve: (value: Record<string, unknown>[]) => unknown,
            reject: (reason: unknown) => unknown
          ) => Promise.resolve([]).then(resolve, reject),
        };
        return builder;
      },
    }),
    insert: (table: unknown) => {
      const values = () => ({
        onDuplicateKeyUpdate: async () => {
          if (table === state.noteTable) {
            if (state.failNoteWrite) throw new Error("injected DB failure");
            state.noteWrites += 1;
          }
          return [{ affectedRows: 1 }];
        },
      });
      return {
        values,
        ignore: () => ({
          values: async (value: ReceiptRow) => {
            if (state.receipts.has(value.deliveryId)) {
              return [{ affectedRows: 0 }];
            }
            state.receipts.set(value.deliveryId, value);
            return [{ affectedRows: 1 }];
          },
        }),
      };
    },
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    delete: (table: unknown) => ({
      where: () => {
        const execute = async () => {
          if (table !== state.receiptTable) return;
          if (insideTransaction) {
            state.receiptDeletesInsideTransaction += 1;
            return;
          }
          state.receiptCleanupRuns += 1;
          const failureCode = state.cleanupFailureCodes.shift();
          if (failureCode) throw transactionError(failureCode);
          await state.cleanupGate;
        };
        return {
          limit: async () => execute(),
          then: (
            resolve: (value: void) => unknown,
            reject: (reason: unknown) => unknown
          ) => execute().then(resolve, reject),
        };
      },
    }),
  });

  const transactionError = (code: string) => {
    const cause = Object.assign(new Error("injected database lock error"), {
      code,
    });
    return Object.assign(new Error("injected transaction failure"), { cause });
  };

  return {
    getDb: () => {
      if (state.failGetDb)
        throw new Error("injected database acquisition failure");
      const operations = createOperations(false);
      return {
        ...operations,
        transaction: async <T>(
          work: (transaction: ReturnType<typeof createOperations>) => Promise<T>
        ): Promise<T> => {
          state.transactionAttempts += 1;
          const receiptsBefore = new Map(state.receipts);
          const writesBefore = state.noteWrites;
          try {
            const result = await work(createOperations(true));
            const failureCode = state.transactionFailureCodes.shift();
            if (failureCode) throw transactionError(failureCode);
            return result;
          } catch (error) {
            state.receipts = receiptsBefore;
            state.noteWrites = writesBefore;
            throw error;
          }
        },
      };
    },
  };
});

vi.mock("./lib/openapi-auth", () => ({
  requireApiKey: async (
    _context: unknown,
    next: () => Promise<void>
  ): Promise<void> => next(),
}));

vi.mock("./lib/webhooks", () => ({
  EVENT_TYPES: ["note.created"],
  fanout: (event: Record<string, unknown>) => state.events.push(event),
}));

vi.mock("./lib/codex", () => ({
  askCodex: vi.fn(),
  codexAuthController: {
    status: vi.fn(),
    startLogin: vi.fn(),
    logout: vi.fn(),
  },
}));

import { mirrorEventReceipts, mirrorNotes } from "@db/mirror-schema";
import { v1 } from "./v1";

const DELIVERY_ID = "delivery-0000000000000001";

function noteEvent(content = "Body") {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deliveryId: DELIVERY_ID,
      type: "note.created",
      data: { extId: "note-1", title: "Title", content },
    }),
  } satisfies RequestInit;
}

describe("browser event delivery receipts", () => {
  beforeEach(() => {
    state.receiptTable = mirrorEventReceipts;
    state.noteTable = mirrorNotes;
    state.receipts = new Map();
    state.noteWrites = 0;
    state.failNoteWrite = false;
    state.failGetDb = false;
    state.transactionAttempts = 0;
    state.transactionFailureCodes = [];
    state.cleanupFailureCodes = [];
    state.receiptCleanupRuns = 0;
    state.receiptDeletesInsideTransaction = 0;
    state.cleanupGate = null;
    state.releaseCleanup = null;
    state.events = [];
  });

  it("shares startup cleanup and keeps it outside concurrent hot transactions", async () => {
    state.cleanupFailureCodes = ["ER_LOCK_DEADLOCK"];
    state.cleanupGate = new Promise<void>(resolve => {
      state.releaseCleanup = resolve;
    });

    const first = v1.request("/events", noteEvent());
    const concurrentRetry = v1.request("/events", noteEvent());
    await vi.waitFor(() => expect(state.receiptCleanupRuns).toBe(2));

    expect(state.transactionAttempts).toBe(0);
    state.releaseCleanup?.();
    const responses = await Promise.all([first, concurrentRetry]);

    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(state.receiptDeletesInsideTransaction).toBe(0);
    expect(state.transactionAttempts).toBe(2);
    expect(state.noteWrites).toBe(1);
    expect(state.receipts).toHaveLength(1);
    expect(state.events).toHaveLength(1);
  });

  it("commits one mutation and one fanout when a lost response is retried", async () => {
    const first = await v1.request("/events", noteEvent());
    const retry = await v1.request("/events", noteEvent());

    expect(first.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      ok: true,
      mirrored: true,
      duplicate: true,
    });
    expect(state.noteWrites).toBe(1);
    expect(state.events).toHaveLength(1);
    expect(state.receipts).toHaveLength(1);
    expect(state.receiptDeletesInsideTransaction).toBe(0);
  });

  it("rejects reusing a deliveryId for a different payload", async () => {
    await v1.request("/events", noteEvent("First"));
    const conflict = await v1.request("/events", noteEvent("Second"));

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      ok: false,
      error: "delivery_id_conflict",
    });
    expect(state.noteWrites).toBe(1);
    expect(state.events).toHaveLength(1);
  });

  it.each(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"])(
    "retries %s and commits one mutation and fanout",
    async errorCode => {
      state.transactionFailureCodes = [errorCode];

      const response = await v1.request("/events", noteEvent());

      expect(response.status).toBe(200);
      expect(state.transactionAttempts).toBe(2);
      expect(state.receipts).toHaveLength(1);
      expect(state.noteWrites).toBe(1);
      expect(state.events).toHaveLength(1);
      expect(state.receiptDeletesInsideTransaction).toBe(0);
    }
  );

  it("bounds lock retries and returns 503 without fanout", async () => {
    state.transactionFailureCodes = [
      "ER_LOCK_DEADLOCK",
      "ER_LOCK_DEADLOCK",
      "ER_LOCK_DEADLOCK",
    ];

    const response = await v1.request("/events", noteEvent());

    expect(response.status).toBe(503);
    expect(state.transactionAttempts).toBe(3);
    expect(state.receipts).toHaveLength(0);
    expect(state.noteWrites).toBe(0);
    expect(state.events).toHaveLength(0);
  });

  it("maps synchronous database acquisition failure to 503 without fanout", async () => {
    state.failGetDb = true;

    const response = await v1.request("/events", noteEvent());

    expect(response.status).toBe(503);
    expect(state.transactionAttempts).toBe(0);
    expect(state.receipts).toHaveLength(0);
    expect(state.noteWrites).toBe(0);
    expect(state.events).toHaveLength(0);
  });

  it("rolls back the receipt, returns 503 and suppresses fanout on DB failure", async () => {
    state.failNoteWrite = true;
    const failed = await v1.request("/events", noteEvent());

    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({
      ok: false,
      mirrored: false,
      error: "mirror_write_failed",
    });
    expect(state.receipts).toHaveLength(0);
    expect(state.events).toHaveLength(0);
    expect(state.transactionAttempts).toBe(1);

    state.failNoteWrite = false;
    const retry = await v1.request("/events", noteEvent());
    expect(retry.status).toBe(200);
    expect(state.noteWrites).toBe(1);
    expect(state.events).toHaveLength(1);
  });
});
