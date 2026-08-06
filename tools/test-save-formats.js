/* Clickteam INI parsing, which is what every FNAF save actually is.
 *
 * The runtime those games ship stores its INI object as the file's lines
 * joined by the literal separator "{@24}", so the whole save arrives as one
 * string. Splitting it correctly is the difference between a textarea and a
 * per-field mod menu — and writing it back wrong corrupts someone's progress,
 * so the round trip matters more than the parse.
 *
 *   node tools/test-save-formats.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

let passed = 0;
const failures = [];
function ok(label, cond, extra) {
  if (cond) { passed++; console.log("  ok   " + label + (extra ? "   " + extra : "")); }
  else { failures.push(label); console.log("  FAIL " + label + (extra ? "   " + extra : "")); }
}

const box = { console };
box.window = box;
vm.createContext(box);
vm.runInContext(fs.readFileSync(path.join(ROOT, "js", "save-formats.js"), "utf8"),
                box, { filename: "save-formats.js" });
const SF = box.SaveFormats;

/* Shaped exactly like what the FNAF runtime writes. */
const FNAF = "[Game]{@24}Night=3{@24}Stars=2{@24}Completed=0{@24}" +
             "[Options]{@24}Volume=10{@24}Fullscreen=1";

console.log("recognising what a save is");
{
  ok("a Clickteam save is recognised", SF.detect(FNAF) === "clickteam-ini", SF.detect(FNAF));
  ok("JSON is still recognised", SF.detect('{"coins":5}') === "json");
  ok("a plain number is left alone", SF.detect("42") === "raw");
  ok("a base64 blob is left alone", SF.detect("aGVsbG8gd29ybGQ=") === "raw", SF.detect("aGVsbG8gd29ybGQ="));
  ok("newline INI is recognised too",
     SF.detect("[Game]\nNight=3") === "clickteam-ini");
  ok("ordinary multi-line text is not claimed as INI",
     SF.detect("hello\nthere\nfriend") === "raw", SF.detect("hello\nthere\nfriend"));
}

console.log("\ntaking a FNAF save apart");
{
  const model = SF.parse(FNAF);
  ok("both sections are found", model.length === 2,
     model.map((g) => g.section).join(","));
  ok("the first section is named", model[0].section === "Game");
  ok("its values are split out", model[0].entries.length === 3,
     JSON.stringify(model[0].entries));
  ok("a key and value are separated",
     model[0].entries[0].key === "Night" && model[0].entries[0].value === "3");
  ok("the second section is separate",
     model[1].section === "Options" && model[1].entries.length === 2);
  ok("every value is counted", SF.countValues(model) === 5, String(SF.countValues(model)));
}

console.log("\nwriting it back unchanged");
{
  const model = SF.parse(FNAF);
  ok("an untouched save round-trips byte for byte",
     SF.stringify(model, FNAF) === FNAF, SF.stringify(model, FNAF));
}

console.log("\nchanging one value");
{
  const model = SF.parse(FNAF);
  ok("the target is found", SF.set(model, "Game", "Night", "5"));
  const out = SF.stringify(model, FNAF);
  ok("it changed", out.indexOf("Night=5") !== -1);
  ok("the separator is preserved", out.indexOf("{@24}") !== -1);
  ok("nothing else moved",
     out === FNAF.replace("Night=3", "Night=5"), out);

  ok("a key in the wrong section is not found",
     SF.set(model, "Options", "Night", "9") === false);
  ok("an unknown key is not invented",
     SF.set(model, "Game", "Godmode", "1") === false);
}

console.log("\nshapes that would otherwise lose data");
{
  const loose = "Night=1{@24}[Game]{@24}Stars=2";
  const model = SF.parse(loose);
  ok("a value before any section is kept",
     model[0].section === "" && model[0].entries[0].key === "Night",
     JSON.stringify(model[0]));
  ok("and it round-trips", SF.stringify(model, loose) === loose);

  const commented = "[Game]{@24}; a note{@24}Night=3";
  const withNote = SF.parse(commented);
  ok("a comment survives", SF.stringify(withNote, commented) === commented);
  ok("a comment is not counted as a value", SF.countValues(withNote) === 1);

  const empty = SF.parse("");
  ok("an empty save parses to nothing", empty.length === 0);

  const valueWithEquals = SF.parse("[A]{@24}path=C:=weird");
  ok("only the first = splits the line",
     valueWithEquals[0].entries[0].value === "C:=weird",
     valueWithEquals[0].entries[0].value);

  const blankValue = SF.parse("[A]{@24}Name=");
  ok("an empty value is still a value",
     blankValue[0].entries[0].key === "Name" && blankValue[0].entries[0].value === "",
     JSON.stringify(blankValue[0].entries[0]));
}

console.log("\nnewline builds keep newlines");
{
  const nl = "[Game]\nNight=3\nStars=2";
  const model = SF.parse(nl);
  SF.set(model, "Game", "Night", "7");
  const out = SF.stringify(model, nl);
  ok("a newline save is not rewritten with the separator",
     out.indexOf("{@24}") === -1, out);
  ok("and the change took", out.indexOf("Night=7") !== -1);
}

console.log("\n" + "=".repeat(52));
if (failures.length) {
  console.log(failures.length + " FAILED of " + (passed + failures.length));
  failures.forEach((f) => console.log("  · " + f));
  process.exitCode = 1;
} else {
  console.log("All " + passed + " format checks passed.");
}
