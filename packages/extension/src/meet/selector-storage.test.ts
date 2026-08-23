import { describe, expect, test } from "vitest";
import { loadMeetSelectors, saveMeetSelectors } from "./selector-storage.js";

/**
 * The point of the Meet-scoped key is that a hard-won field fix — a selector a
 * user tracked down after Google renamed an aria-label — survives the split.
 * So the migration is what these tests are about.
 */

/** Minimal in-memory stand-in for `chrome.storage.local` (keys-array `get`). */
function fakeStorage(seed: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...seed };
  const local = {
    get(keys: string[], cb: (items: Record<string, unknown>) => void): void {
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        if (key in store) {
          out[key] = store[key];
        }
      }
      cb(out);
    },
    set(items: Record<string, unknown>, cb?: () => void): void {
      Object.assign(store, items);
      cb?.();
    },
    remove(key: string, cb?: () => void): void {
      delete store[key];
      cb?.();
    },
  } as unknown as chrome.storage.LocalStorageArea;
  return { local, store };
}

describe("Meet selector storage", () => {
  test("a fresh install has no overrides", async () => {
    const { local } = fakeStorage();
    expect(await loadMeetSelectors(local)).toEqual({});
  });

  test("reads the Meet-scoped key", async () => {
    const { local } = fakeStorage({ "meet.selectors": { leave: "Hang up" } });
    expect(await loadMeetSelectors(local)).toEqual({ leave: "Hang up" });
  });

  test("a legacy override migrates on first read and is not lost", async () => {
    const { local, store } = fakeStorage({ selectors: { handRaise: "Put hand up" } });

    expect(await loadMeetSelectors(local)).toEqual({ handRaise: "Put hand up" });

    expect(store["meet.selectors"]).toEqual({ handRaise: "Put hand up" });
    expect(store.selectors).toBeUndefined(); // migration runs exactly once
  });

  test("the migration survives a second read", async () => {
    const { local } = fakeStorage({ selectors: { handRaise: "Put hand up" } });
    await loadMeetSelectors(local);
    expect(await loadMeetSelectors(local)).toEqual({ handRaise: "Put hand up" });
  });

  test("a Meet-scoped value wins over a stale legacy one", async () => {
    const { local } = fakeStorage({
      "meet.selectors": { leave: "Hang up" },
      selectors: { leave: "stale" },
    });
    expect(await loadMeetSelectors(local)).toEqual({ leave: "Hang up" });
  });

  test("saving writes the Meet-scoped key, never the legacy one", () => {
    const { local, store } = fakeStorage();
    saveMeetSelectors(local, { leave: "Hang up" } as never);
    expect(store["meet.selectors"]).toEqual({ leave: "Hang up" });
    expect(store.selectors).toBeUndefined();
  });
});
