/* Repairs catalogue text that was mangled by repeated UTF-8 → cp1252 → UTF-8
 * round trips.
 *
 * tools/build-sitemap.ps1 used to read data/games.json with Get-Content -Raw,
 * which decodes using the system ANSI codepage (cp1252 here) rather than
 * UTF-8, then wrote the result back out as UTF-8. Every run compounded the
 * damage, so a single em dash became a long run of Ã/â€/Æ noise. The reader
 * is fixed; this undoes the damage already written to the file.
 *
 *   node tools/fix-mojibake.js          # report only
 *   node tools/fix-mojibake.js --write  # apply
 */
"use strict";

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "games.json");
const WRITE = process.argv.includes("--write");

/* The bytes 0x80–0x9F are undefined in latin1 but carry printable characters
   in cp1252. Reversing the mis-decode means mapping those characters back to
   the single byte they came from. */
const CP1252 = {
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
  0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
  0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
  0x017E: 0x9E, 0x0178: 0x9F
};

/* Encode a string back to the bytes it was decoded from. Characters up to
   0xFF map to themselves; the printable cp1252 characters above that map
   through the table.
 *
 * The five bytes cp1252 leaves undefined (0x81, 0x8D, 0x8F, 0x90, 0x9D) came
 * back as the matching control characters rather than failing, so they map
 * straight through too — the damage here was done by a decoder that fell back
 * to latin1 for exactly those. Without that, the worst-mangled entries stop
 * on the first pass.
 *
 * Returns null when a character has no byte representation at all, which
 * means the text was never mis-decoded this way and must not be touched. */
function toCp1252(text) {
  const out = Buffer.alloc(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0xFF) out[i] = code;
    else if (CP1252[code] !== undefined) out[i] = CP1252[code];
    else return null;
  }
  return out;
}

/* Undo one round of the mis-decode. Returns null when it doesn't apply. */
function unmangleOnce(text) {
  const bytes = toCp1252(text);
  if (!bytes) return null;
  const decoded = bytes.toString("utf8");
  /* U+FFFD means the bytes weren't valid UTF-8 — we guessed wrong. */
  if (decoded.includes("�") || decoded === text) return null;
  return decoded;
}

function repair(text) {
  let current = text;
  for (let i = 0; i < 10; i++) {
    const next = unmangleOnce(current);
    if (next === null) break;
    current = next;
  }
  return current;
}

const games = JSON.parse(fs.readFileSync(FILE, "utf8"));
const changes = [];

for (const game of games) {
  for (const field of ["title", "description", "notice"]) {
    const value = game[field];
    if (typeof value !== "string" || !value) continue;
    const fixed = repair(value);
    if (fixed !== value) {
      changes.push({ id: game.id, field, before: value, after: fixed });
      if (WRITE) game[field] = fixed;
    }
  }
}

if (!changes.length) {
  console.log("Nothing to repair — the catalogue text is clean.");
  process.exit(0);
}

console.log(`${changes.length} field${changes.length === 1 ? "" : "s"} to repair:\n`);
for (const c of changes.slice(0, 8)) {
  console.log(`  ${c.id}.${c.field}`);
  console.log(`    before: ${c.before.slice(0, 90)}`);
  console.log(`    after : ${c.after.slice(0, 90)}\n`);
}
if (changes.length > 8) console.log(`  … and ${changes.length - 8} more\n`);

if (!WRITE) {
  console.log("Dry run. Re-run with --write to apply, then rebuild:");
  console.log("  powershell -ExecutionPolicy Bypass -File tools\\build-sitemap.ps1");
  process.exit(0);
}

fs.writeFileSync(FILE, JSON.stringify(games, null, 2) + "\n", "utf8");
console.log(`Wrote ${FILE}. Now rebuild data/games.js:`);
console.log("  powershell -ExecutionPolicy Bypass -File tools\\build-sitemap.ps1");
