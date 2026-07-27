/**
 * Meet URL classification. The content script matches every
 * `https://meet.google.com/*` path (manifest `content_scripts`), which includes
 * the home/landing pages where there is no call to control. The widget should
 * only surface on an *actual meeting* — a room whose path is a Meet meeting
 * code, e.g. `https://meet.google.com/xqy-ebgf-wsx` — and stay hidden on
 * `/landing`, `/`, `/new`, `/lookup/...` and the rest.
 */

/**
 * A Meet meeting code: three-four-three lowercase letters, `xxx-xxxx-xxx`. This
 * is a fixed lexical token, so a single anchored pattern is the right tool — not
 * a parser. The surrounding URL *is* parsed (by {@link URL}); only the code
 * shape is matched.
 */
const MEETING_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/**
 * Is `href` a Meet meeting room (as opposed to the landing/home/lookup pages)?
 * The single path segment must be a meeting code; query and hash are ignored.
 * Anything unparseable, or off `meet.google.com`, is treated as not-a-meeting.
 */
export function isMeetingUrl(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.hostname !== "meet.google.com") {
    return false;
  }
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  return segments.length === 1 && MEETING_CODE.test(segments[0]);
}
