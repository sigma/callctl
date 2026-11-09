/** Google Meet meeting code, e.g. `abc-defg-hij`. */
const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/**
 * The meeting code in a `meet.google.com` URL path, or `undefined`. Accepts both
 * `/<code>` and the newer `/meet/<code>` form Meet now lands calls on. Both ends
 * derive the §10 join key from this, so the calendar side and the in-call side
 * cannot disagree on which paths carry a code.
 */
export function meetCodeFromPath(pathname: string): string | undefined {
  const segments = pathname.split("/").filter(Boolean);
  const code = segments[0] === "meet" ? segments[1] : segments[0];
  return code !== undefined && MEET_CODE.test(code) ? code : undefined;
}
