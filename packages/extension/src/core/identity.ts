import type { ClientId } from "@callctl/protocol";

/**
 * This extension install's client identity.
 *
 * Minted once into `chrome.storage.local`, which is **per Chrome profile** — so
 * the id is already a per-profile identity, stable across reconnects, page
 * reloads and browser restarts, and different between two Chrome profiles
 * without anything having to arrange that.
 *
 * 🔴 **Per profile is not enough on its own.** That store is shared by *every*
 * content script, so the bare install id is the same string on Meet and on Chat
 * — and a registry keyed by it conflated the two, knocking every Chat key dark
 * the moment a Meet tab opened. The surface is therefore part of the id: the
 * unit anything routes to is a *client*, not an install.
 *
 * Typed as an opaque string rather than a UUID on purpose (ADR 0001): the unit
 * today is the profile, but one profile signed into two accounts yields one
 * install and two Chat windows. Keeping it opaque makes adding an account
 * discriminator later a *value* change rather than a schema change — which is
 * exactly what the surface suffix is, and what an address-derived account
 * discriminator would be if the two-accounts-one-profile case ever needs one.
 *
 * 🔴 **The account index (`/u/<n>`) must never enter this value.** It is a
 * property of the session, not of the account — the default is whichever
 * account you signed in with first — so an id built on it would silently
 * re-target every deck binding after a different sign-in order.
 */
const CLIENT_ID_KEY = "clientId";

/**
 * This client's id: the install's minted value, scoped to `surface`.
 *
 * Stable in every direction that matters — reconnect, tab reload, browser
 * restart — so a deck key's binding survives all three; distinct per surface,
 * so two content scripts of one install are two clients rather than one.
 */
export function loadClientId(
  local: chrome.storage.LocalStorageArea,
  surface: string,
): Promise<ClientId> {
  return new Promise((resolve) => {
    local.get([CLIENT_ID_KEY], (items) => {
      const existing = items[CLIENT_ID_KEY] as string | undefined;
      if (typeof existing === "string" && existing !== "") {
        resolve(`${existing}:${surface}`);
        return;
      }
      const minted = crypto.randomUUID();
      local.set({ [CLIENT_ID_KEY]: minted }, () => resolve(`${minted}:${surface}`));
    });
  });
}
