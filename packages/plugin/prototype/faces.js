// PROTOTYPE — THROWAWAY (#109). Shared by chat-key-face.html and render-check.mjs.
// ---- geometry + palette copied from packages/plugin/src/calendar/render.ts ----
const SIZE = 144;
const COLOR = {
  bg: "#1c2128", ink: "#e6edf3", title: "#8b949e",
  quiet: "#8b949e",           // connected, nothing unread
  unread: "#58a6ff",          // unread-and-notifying (blue: informational, not alarm)
  absentBg: "#15181c", absent: "#484f58", // no client — deliberately inert
};
const FONT = 'Helvetica, Arial, sans-serif';
const esc = s => String(s).replace(/[<>&'"]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;","'":"&apos;",'"':"&quot;"}[c]));
const svg = (body, bg = COLOR.bg) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
  `<rect width="${SIZE}" height="${SIZE}" fill="${bg}"/>${body}</svg>`;
const text = (s, y, size, fill, weight = "normal", x = 72, anchor = "middle") =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(s)}</text>`;
// Speech-bubble glyph, centred on (cx,cy), width w.
const bubble = (cx, cy, w, fill, op = 1) => {
  const h = w * 0.78, x = cx - w/2, y = cy - h/2, r = w * 0.17, tail = w * 0.2;
  return `<path opacity="${op}" fill="${fill}" d="M${x+r},${y} h${w-2*r} a${r},${r} 0 0 1 ${r},${r} v${h-2*r-tail*0.2} a${r},${r} 0 0 1 -${r},${r} h-${w*0.52} l-${tail*0.9},${tail} v-${tail} h-${w*0.48-tail*0.9} a${r},${r} 0 0 1 -${r},-${r} v-${h-2*r-tail*0.2} a${r},${r} 0 0 1 ${r},-${r} z"/>`;
};


// #109 feedback: the label is ALWAYS shown, and defaults to the domain with its
// TLD stripped — "arbora", not "arbora.partners". First dot-label only, so
// "acme.co.uk" also reduces to "acme". A user-set label overrides this whole
// derivation (#117's tier 1).
const shortLabel = (domain) => String(domain || "").split(".")[0];

// ---- the state matrix every variant must answer ----
const STATES = [
  { k:"absent",  n:null, cap:"No Chat client" },
  { k:"quiet",   n:0,    cap:"Connected, nothing unread" },
  { k:"unread",  n:1,    cap:"1 unread conversation" },
  { k:"unread",  n:3,    cap:"3 unread" },
  { k:"unread",  n:12,   cap:"12 unread (2 digits)" },
];

// ============================ VARIANT A — Badge ============================
// Glyph is the subject; the count is a small badge riding the corner. The
// familiar notification idiom. Count = unread CONVERSATIONS.
const A = {
  name: "Badge — glyph subject, count rides the corner",
  desc: "The conventional notification idiom: a Chat bubble owns the key, a small badge in the corner carries the count. Most instantly readable as 'messages'; the count is the smallest thing on the key.",
  draw(s, label) {
    if (s.k === "absent") return svg(bubble(72, 72, 74, COLOR.absent, .55) + (label ? text(label, 132, 17, COLOR.absent) : ""), COLOR.absentBg);
    // #109 feedback: "quiet" is the SAME blue as unread, minus the badge — so
    // grey means exactly one thing (no client) and can never be mistaken for
    // "connected and nothing to see".
    const body = bubble(72, label ? 64 : 72, 74, COLOR.unread, 1)
      + (s.n ? `<circle cx="112" cy="${label?32:40}" r="24" fill="#f85149"/>` + text(String(s.n), (label?32:40)+9, s.n > 9 ? 24 : 28, "#fff", "bold", 112) : "")
      + (label ? text(label, 132, 17, COLOR.title) : "");
    return svg(body);
  },
};

// ======================= VARIANT B — Numeral-primary =======================
// Mirrors this repo's OWN existing idiom: next-meeting's countdown-primary face,
// where the number fills the key and a thin strip labels it. Consistency with
// the deck's other data key, not with phone notifications.
const B = {
  name: "Numeral-primary — the count fills the key",
  desc: "Mirrors next-meeting's countdown-primary face: the number is the subject, a thin top strip names it. Consistent with the other data key on this deck. Reads as a quantity first, 'chat' second.",
  draw(s, label) {
    if (s.k === "absent")
      return svg(text(label || "Chat", 34, 18, COLOR.absent) + text("—", 96, 62, COLOR.absent, "bold"), COLOR.absentBg);
    if (s.n === 0)
      return svg(text(label || "Chat", 34, 18, COLOR.title) + bubble(72, 88, 54, COLOR.quiet, .5));
    return svg(text(label || "Chat", 34, 18, COLOR.title)
      + text(String(s.n), 108, s.n > 99 ? 62 : s.n > 9 ? 78 : 86, COLOR.unread, "bold"));
  },
};

// ========================= VARIANT C — Roster strip =========================
// The count AND its shape: one tick per unread conversation. Pre-empts the
// paging key by making "which/how many" visible, and degrades to a count when
// the roster is long.
const C = {
  name: "Roster strip — one tick per unread conversation",
  desc: "Shows the count and its shape: a tick per unread conversation, so 3 reads as three things, not the numeral 3. Deliberately pre-empts the paging key. Collapses to a numeral past 6.",
  draw(s, label) {
    const top = label ? 30 : 0;
    if (s.k === "absent")
      return svg(bubble(72, label ? 50 : 66, 60, COLOR.absent, .5) + (label ? text(label, 132, 17, COLOR.absent) : ""), COLOR.absentBg);
    const head = bubble(72, label ? 50 : 58, 60, s.n ? COLOR.unread : COLOR.quiet, s.n ? 1 : .55);
    let strip = "";
    if (s.n > 0 && s.n <= 6) {
      const w = 16, gap = 6, total = s.n * w + (s.n - 1) * gap, x0 = 72 - total / 2;
      for (let i = 0; i < s.n; i++)
        strip += `<rect x="${x0 + i * (w + gap)}" y="${label ? 92 : 100}" width="${w}" height="9" rx="4.5" fill="${COLOR.unread}"/>`;
    } else if (s.n > 6) {
      strip = text(String(s.n), label ? 108 : 116, 34, COLOR.unread, "bold");
    }
    return svg(head + strip + (label ? text(label, 134, 16, COLOR.title) : ""));
  },
};

const VARIANTS = { A, B, C };
