import { describe, expect, it } from "vitest";
import { isTrustedLocalBrowserEvent } from "./browser-event-auth";

describe("local browser event authentication", () => {
  it("accepts an exact same-origin loopback request", () => {
    expect(
      isTrustedLocalBrowserEvent(
        "http://127.0.0.1:3000/api/v1/events",
        "http://127.0.0.1:3000"
      )
    ).toBe(true);
    expect(
      isTrustedLocalBrowserEvent(
        "http://localhost:3000/api/v1/events",
        "http://localhost:3000"
      )
    ).toBe(true);
  });

  it("rejects forged remote, cross-origin, and missing origins", () => {
    expect(
      isTrustedLocalBrowserEvent(
        "http://192.0.2.10:3000/api/v1/events",
        "http://192.0.2.10:3000"
      )
    ).toBe(false);
    expect(
      isTrustedLocalBrowserEvent(
        "http://127.0.0.1:3000/api/v1/events",
        "http://localhost:3000"
      )
    ).toBe(false);
    expect(
      isTrustedLocalBrowserEvent(
        "http://127.0.0.1:3000/api/v1/events",
        undefined
      )
    ).toBe(false);
  });
});
