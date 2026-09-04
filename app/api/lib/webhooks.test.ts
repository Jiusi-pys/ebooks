import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const connectionMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("../queries/connection", () => connectionMocks);

import { deliverWebhook, type ShufangEvent, type WebhookRow } from "./webhooks";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface PendingUpdate {
  values: Record<string, unknown>;
  commit: () => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(innerResolve => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function response(ok: boolean, status = ok ? 204 : 503): Response {
  return { ok, status } as Response;
}

describe("webhook delivery outcome ordering", () => {
  const row: WebhookRow = {
    id: 41,
    url: "https://hooks.example.test/books",
    secret: "",
    events: "[]",
    active: true,
    // Both concurrent deliveries receive this stale fanout-time snapshot.
    failCount: 0,
  };
  const event: ShufangEvent = {
    type: "book.updated",
    data: { extId: "book-1" },
  };

  let persistedFailCount: number;
  let pendingUpdates: PendingUpdate[];
  let fetchResponses: Deferred<Response>[];

  beforeEach(() => {
    persistedFailCount = 0;
    pendingUpdates = [];
    fetchResponses = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        const pendingResponse = deferred<Response>();
        fetchResponses.push(pendingResponse);
        return pendingResponse.promise;
      })
    );

    connectionMocks.getDb.mockReturnValue({
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(() => {
            const committed = deferred<void>();
            pendingUpdates.push({
              values,
              commit: () => {
                // A numeric value is the success reset. The failure branch is
                // a Drizzle SQL expression and increments the live DB value.
                if (typeof values.failCount === "number") {
                  persistedFailCount = values.failCount;
                } else {
                  persistedFailCount += 1;
                }
                committed.resolve();
              },
            });
            return committed.promise;
          }),
        })),
      })),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears an earlier failure even when the success snapshot was zero", async () => {
    const failedDelivery = deliverWebhook(row, event);
    const successfulDelivery = deliverWebhook(row, event);

    fetchResponses[0].resolve(response(false));
    await vi.waitFor(() => expect(pendingUpdates).toHaveLength(1));

    fetchResponses[1].resolve(response(true));
    await Promise.resolve();
    expect(pendingUpdates).toHaveLength(1);

    pendingUpdates[0].commit();
    await vi.waitFor(() => expect(pendingUpdates).toHaveLength(2));
    pendingUpdates[1].commit();
    await Promise.all([failedDelivery, successfulDelivery]);

    expect(persistedFailCount).toBe(0);
    expect(pendingUpdates[1].values.failCount).toBe(0);
  });

  it("does not let an earlier slow success overwrite a later failure", async () => {
    const successfulDelivery = deliverWebhook(row, event);
    const failedDelivery = deliverWebhook(row, event);

    fetchResponses[0].resolve(response(true));
    await vi.waitFor(() => expect(pendingUpdates).toHaveLength(1));

    // The later failure is known while the successful reset is still blocked.
    // Its state update must wait behind the earlier outcome.
    fetchResponses[1].resolve(response(false));
    await Promise.resolve();
    expect(pendingUpdates).toHaveLength(1);

    pendingUpdates[0].commit();
    await vi.waitFor(() => expect(pendingUpdates).toHaveLength(2));
    pendingUpdates[1].commit();
    await Promise.all([successfulDelivery, failedDelivery]);

    expect(persistedFailCount).toBe(1);
    expect(typeof pendingUpdates[1].values.failCount).not.toBe("number");
  });
});
