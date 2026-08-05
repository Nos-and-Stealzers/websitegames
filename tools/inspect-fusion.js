/* Reads the chunk table of a Clickteam Fusion application (.dat / .exe /.ccn).
 *
 * The point is to answer one question: is this build readable, or is it
 * packed/encrypted? A standard PAME/PAMU header followed by well-formed
 * chunks means the usual decompilers will open it.
 *
 *   node tools/inspect-fusion.js "<path to FWR.dat>"
 *
 * Reads only headers, seeking through the file — it never loads the whole
 * thing, which matters when the .dat is most of a gigabyte.
 */
"use strict";

const fs = require("fs");
const zlib = require("zlib");

const FILE = process.argv[2];
if (!FILE) {
  console.error('usage: node tools/inspect-fusion.js "<path to .dat>"');
  process.exit(1);
}

/* The chunk ids worth naming. Anything else is reported by number. */
const CHUNKS = {
  0x2223: "APPHEADER",
  0x2224: "APPNAME",
  0x2225: "APPAUTHOR",
  0x2226: "APPMENU",
  0x2227: "EXTPATH",
  0x2228: "EXTENSIONS",
  0x2229: "APPEDITORFILENAME",
  0x222a: "APPTARGETFILENAME",
  0x222b: "APPDOC",
  0x222c: "OTHEREXTENSIONS",
  0x222d: "GLOBALVALUES",
  0x222e: "GLOBALSTRINGS",
  0x222f: "EXTENSIONLIST",
  0x2230: "APPICON",
  0x2231: "DEMOFILEPATH",
  0x2232: "MUSICBANK",
  0x2233: "MUSICFILEBANK",
  0x2234: "FRAMEHANDLES",
  0x2235: "EXTDATA",
  0x2236: "ADDITIONALEXT",
  0x2237: "APPEDITORFILENAME2",
  0x223b: "GLOBALEVENTS",
  0x223c: "FRAMEHANDLES2",
  0x223f: "EXTENSIONDATA",
  0x2246: "SHADERS",
  0x2247: "EXTDHEADER",
  0x3333: "FRAME",
  0x3334: "FRAMEHEADER",
  0x3335: "FRAMENAME",
  0x3336: "FRAMEPASSWORD",
  0x3337: "FRAMEPALETTE",
  0x333d: "FRAMELAYERS",
  0x3340: "FRAMEEVENTS",
  0x333b: "OBJECTINSTANCES",
  0x5555: "IMAGEBANK",
  0x6666: "FONTBANK",
  0x7777: "SOUNDBANK",
  0x8888: "MUSICBANK2",
  0x7f7f: "LAST"
};

const fd = fs.openSync(FILE, "r");
const size = fs.fstatSync(fd).size;

function read(offset, length) {
  const buf = Buffer.alloc(length);
  fs.readSync(fd, buf, 0, length, offset);
  return buf;
}

const head = read(0, 0x30);
const magic = head.toString("latin1", 0, 4);
const pam = head.toString("latin1", 0x20, 0x24);

console.log("file    :", FILE);
console.log("size    :", (size / 1048576).toFixed(1), "MB");
console.log("magic   :", JSON.stringify(magic), magic === "wwww" ? "(Fusion external pack)" : "");
console.log("header  :", JSON.stringify(pam),
  pam === "PAMU" ? "-> Fusion 2.5, Unicode build"
  : pam === "PAME" ? "-> Fusion 2.0 / MMF2, ANSI build"
  : "-> not a recognised Fusion header");

if (pam !== "PAMU" && pam !== "PAME") {
  console.log("\nNot a plain Fusion application — likely packed or encrypted.");
  process.exit(0);
}

console.log("runtime :", head.readUInt16LE(0x24), "sub", head.readUInt16LE(0x26),
            "build", head.readUInt32LE(0x28));

/* Chunks start right after the 12-byte version block following PAMU. */
/* Try the plausible framings: raw, or a 4/8-byte size prefix, with either
   zlib or raw deflate. Whichever yields printable UTF-16 wins. */
function decode(body, flags) {
  const attempts = [];
  if (flags === 0) attempts.push(body);
  for (const skip of [0, 4, 8]) {
    if (body.length <= skip) continue;
    const slice = body.slice(skip);
    for (const fn of [zlib.inflateSync, zlib.inflateRawSync]) {
      try { attempts.push(fn(slice)); } catch (e) { /* wrong framing */ }
    }
  }
  for (const buf of attempts) {
    const utf16 = buf.toString("utf16le").replace(/\0+$/, "").trim();
    if (/^[\x20-\x7e -￿]{2,}$/.test(utf16)) return utf16;
    const ascii = buf.toString("latin1").replace(/\0+$/, "").trim();
    if (/^[\x20-\x7e]{2,}$/.test(ascii)) return ascii;
  }
  return null;
}

let author = null;
let offset = 0x30;
let count = 0;
let compressed = 0, plain = 0, other = 0;
const seen = [];
let frames = 0;
let appName = null;

console.log("\n=== chunk table ===");
while (offset + 8 <= size && count < 4000) {
  const h = read(offset, 8);
  const id = h.readUInt16LE(0);
  const flags = h.readUInt16LE(2);
  const len = h.readUInt32LE(4);

  if (len < 0 || offset + 8 + len > size) {
    console.log(`  ! chunk at ${offset} claims ${len} bytes — past EOF, stopping`);
    break;
  }

  const name = CHUNKS[id] || ("0x" + id.toString(16));
  if (flags === 0) plain++;
  else if (flags === 1) compressed++;
  else other++;

  if (id === 0x3333) frames++;
  seen.push(name);

  /* Decode a couple of text chunks to prove the payload really is readable.
     Fusion prefixes compressed chunks with a size field, but how many bytes
     varies by chunk and build, so try the handful of shapes rather than
     assuming one. */
  if ((id === 0x2224 || id === 0x2225) && len < 65536) {
    const body = read(offset + 8, len);
    const text = decode(body, flags);
    if (id === 0x2224 && appName === null) appName = text;
    if (id === 0x2225 && text) author = text;
  }

  if (count < 28) {
    console.log(`  ${String(offset).padStart(10)}  ${name.padEnd(20)} ` +
                `${String(len).padStart(10)} bytes  ` +
                `${flags === 0 ? "plain" : flags === 1 ? "deflate" : "flags=" + flags}`);
  }

  count++;
  if (id === 0x7f7f) break;
  offset += 8 + len;
}

console.log(`  … ${count} chunks total`);

console.log("\n=== verdict ===");
console.log("app name        :", appName || "(not decoded)");
console.log("author          :", author || "(not decoded)");
console.log("frames (scenes) :", frames);
console.log("chunks          :", count, `(${plain} plain, ${compressed} deflate, ${other} other flags)`);

/* Walking the whole file and landing on a valid header every time is the
   real test: an encrypted or packed build desyncs within a chunk or two. */
const walked = offset >= size - 64 || seen.indexOf("LAST") !== -1;
const decoded = !!appName;

console.log("\nwalked to EOF  :", walked ? "yes" : "no — stopped early");
console.log("text decoded   :", decoded ? "yes" : "no");

console.log("\n" + (walked && decoded
  ? "READABLE. The chunk table is intact end to end and payloads inflate,\n" +
    "so this build is not packed or encrypted. Tools that understand\n" +
    "PAME/PAMU (mmfparser/anaconda, Fusion decompilers, Chowdren) can read it."
  : walked
  ? "Structure is intact end to end, so it is not packed — some chunk\n" +
    "framings just did not decode with the shapes tried here."
  : "Stopped before EOF: the chunk chain broke, which suggests protection."));

fs.closeSync(fd);
