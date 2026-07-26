import { afterEach, describe, expect, test, vi } from "vitest";
import { ReactAPI } from "./react-plugin.js";

/**
 * Reaction clicking against a jsdom stand-in for Meet's reaction bar. The
 * headline case is skin tones: 👍/👎/👏 gain a Fitzpatrick modifier when a tone
 * is set, so the button's aria-label becomes e.g. "👍🏽" — the plugin must still
 * match it from the base glyph "👍" and must NOT fall through to toggling the
 * "Send a reaction" panel.
 */

function button(label: string): HTMLElement {
  const el = document.createElement("button");
  el.setAttribute("aria-label", label);
  el.click = vi.fn();
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ReactAPI.react", () => {
  test("clicks the exact glyph button when present", async () => {
    const opener = button("Send a reaction");
    const yes = button("👍");
    await new ReactAPI(document).react("👍");
    expect(yes.click).toHaveBeenCalledOnce();
    expect(opener.click).not.toHaveBeenCalled();
  });

  test("matches a skin-toned button from the base glyph (regression)", async () => {
    const opener = button("Send a reaction");
    const yesTone = button("👍🏽"); // thumbs up + medium skin tone modifier
    await new ReactAPI(document).react("👍");
    expect(yesTone.click).toHaveBeenCalledOnce();
    // Must NOT have toggled the panel by clicking the opener.
    expect(opener.click).not.toHaveBeenCalled();
  });

  test("opens the panel when the glyph button isn't present yet", async () => {
    const opener = button("Send a reaction");
    // Simulate Meet rendering the emoji button only once the panel is opened.
    let clap: HTMLElement | undefined;
    (opener.click as ReturnType<typeof vi.fn>).mockImplementation(() => {
      clap = button("👏");
    });
    await new ReactAPI(document).react("👏");
    expect(opener.click).toHaveBeenCalledOnce();
    expect(clap?.click).toHaveBeenCalledOnce();
  });

  test("ignores an unknown glyph without clicking anything", async () => {
    const opener = button("Send a reaction");
    await new ReactAPI(document).react("42"); // numeric ordinal out of range
    expect(opener.click).not.toHaveBeenCalled();
  });
});
