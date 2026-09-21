import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSpokenNumbers } from "./numbers.ts";

test("resolves a spoken blood pressure pair", () => {
  assert.equal(
    resolveSpokenNumbers("her pressure was one thirty-eight over eighty-eight"),
    "her pressure was 138 over 88",
  );
});

test("resolves decimals spoken digit by digit", () => {
  assert.equal(resolveSpokenNumbers("her sugar was six point two"), "her sugar was 6.2");
  assert.equal(resolveSpokenNumbers("temperature was thirty-seven point four"), "temperature was 37.4");
});

test("keeps a conjunction that belongs to the number", () => {
  assert.equal(resolveSpokenNumbers("one hundred and thirty-eight over eighty"), "138 over 80");
});

test("keeps an em-dash correction from merging into one number", () => {
  assert.equal(resolveSpokenNumbers("seventy—sorry, seventy-two"), "70—sorry, 72");
});

test("leaves ordinary words alone", () => {
  assert.equal(resolveSpokenNumbers("one of them was here"), "one of them was here");
  assert.equal(resolveSpokenNumbers("she ate half her breakfast"), "she ate half her breakfast");
});

test("resolves already-written digits unchanged", () => {
  assert.equal(resolveSpokenNumbers("pressure was 138 over 88"), "pressure was 138 over 88");
});
