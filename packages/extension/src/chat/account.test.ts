import { DEFAULT_CHAT_SELECTORS } from "@callctl/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { loadClientId } from "../core/identity.js";
import { accountLabel, type ChatAccount, observeAccount, readAccount } from "./account.js";

/**
 * Identity and the label ladder. The account anchor's shape is browser truth
 * (confirmed live, `docs/research/chat-account-identity.md`); what these tests
 * pin is that we read the right thing out of it, that the selector stays
 * locale-invariant, and that discovery failing degrades instead of breaking.
 */

/** The anchor Chat renders, verbatim in shape. */
function anchor(label: string): void {
  const a = document.createElement("a");
  a.setAttribute("role", "button");
  a.setAttribute("aria-label", label);
  document.body.appendChild(a);
}

/** The OneGoogle iframe, whose `src` carries the `/u/<n>` account index. */
function oneGoogleFrame(index: number): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("src", `https://ogs.google.com/u/${index}/widget/app?origin=x`);
  document.body.appendChild(frame);
}

const config = DEFAULT_CHAT_SELECTORS;
const read = () => readAccount(document, config);

afterEach(() => {
  document.body.innerHTML = "";
});

describe("reading the Chat account", () => {
  test("extracts the address from the account anchor", () => {
    anchor("Google Account: Yann Hodique  \n(yann@arbora.partners)");

    expect(read()).toMatchObject({
      address: "yann@arbora.partners",
      localPart: "yann",
      domain: "arbora.partners",
    });
  });

  test("the anchor is matched on '@', not on an English prefix", () => {
    // The same anchor in a French UI. Selecting on `@` is what keeps this one
    // selector locale-invariant — an address contains `@` in every locale.
    anchor("Compte Google : Yann Hodique  \n(yann@arbora.partners)");

    expect(read().domain).toBe("arbora.partners");
  });

  test("reports the full domain, never a shortened form", () => {
    anchor("Google Account: A  \n(a@acme.co.uk)");

    // The plugin does the TLD stripping; the raw fact travels.
    expect(read().domain).toBe("acme.co.uk");
  });

  test("reads the account index from the OneGoogle iframe", () => {
    oneGoogleFrame(1);
    expect(read().accountIndex).toBe(1);
  });

  test("an unsettled page yields nothing rather than a wrong answer", () => {
    expect(read()).toEqual({});
  });
});

describe("the label ladder", () => {
  const id = "4f2a9c11-dead-beef-0000-000000000000";

  test("prefers the domain", () => {
    const account: ChatAccount = { domain: "arbora.partners", localPart: "yann", accountIndex: 1 };
    expect(accountLabel(account, id)).toBe("arbora.partners");
  });

  test("falls back to the local part", () => {
    expect(accountLabel({ localPart: "yann", accountIndex: 1 }, id)).toBe("yann");
  });

  test("falls back to the account index", () => {
    expect(accountLabel({ accountIndex: 1 }, id)).toBe("Chat u/1");
  });

  test("bottoms out in an id stub rather than nothing", () => {
    // A client that cannot name itself is still a client somebody binds a key
    // to; a blank dropdown entry is a broken binding, not a missing label.
    expect(accountLabel({}, id)).toBe("Chat · 4f2a");
  });

  test("the account index never appears in the id", () => {
    // It is a property of the session, so an id built on it would re-target
    // every binding after a different sign-in order.
    expect(accountLabel({ accountIndex: 3 }, id)).toContain("3");
    expect(id).not.toContain("u/");
  });
});

describe("late discovery", () => {
  test("an anchor that arrives after load fires a refinement", async () => {
    const seen: ChatAccount[] = [];
    observeAccount(
      document,
      () => config,
      (a) => seen.push(a),
    );

    anchor("Google Account: Y  \n(yann@arbora.partners)");
    await new Promise((r) => setTimeout(r, 20));

    expect(seen.at(-1)?.domain).toBe("arbora.partners");
  });

  test("a re-render that reveals nothing new does not fire", async () => {
    anchor("Google Account: Y  \n(yann@arbora.partners)");
    const seen: ChatAccount[] = [];
    observeAccount(
      document,
      () => config,
      (a) => seen.push(a),
    );

    document.body.setAttribute("data-noise", "1");
    await new Promise((r) => setTimeout(r, 20));

    expect(seen).toEqual([]);
  });
});

describe("the client id", () => {
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
      remove(_key: string, cb?: () => void): void {
        cb?.();
      },
    } as unknown as chrome.storage.LocalStorageArea;
    return { local, store };
  }

  test("is minted once and survives every later read", async () => {
    const { local } = fakeStorage();

    const first = await loadClientId(local);
    const second = await loadClientId(local);

    // Storage is per-Chrome-profile, so this is already a per-profile identity:
    // stable across reconnect, reload and restart.
    expect(second).toBe(first);
    expect(first).not.toBe("");
  });

  test("two profiles mint different ids", async () => {
    // Separate stores stand in for separate Chrome profiles.
    const a = await loadClientId(fakeStorage().local);
    const b = await loadClientId(fakeStorage().local);
    expect(a).not.toBe(b);
  });
});
