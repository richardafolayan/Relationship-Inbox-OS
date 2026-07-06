// Unit tests for the WhatsApp formatting parser. Cases pulled from
// observed WhatsApp UI behaviour: bold/italic/strike/code stay scoped,
// don't bleed across spaces awkwardly, and don't trigger on snake_case
// variables (which would be a false-positive italic).
//
// Run separately from the runner suite because dashboard code is bundled
// with Next, not the runner's CJS dist. We import the source directly
// via tsx — same pattern used by other tests that touch dashboard libs.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseWhatsAppFormat } from "../apps/dashboard/lib/whatsapp-format.ts";

function flat(spans) {
  return spans
    .map((s) => {
      if (s.kind === "text") return `T:${s.text}`;
      if (s.kind === "link") return `L:${s.text}->${s.href}`;
      if (s.kind === "code") return `C:${s.text}`;
      const inner = flat(s.children).join("|");
      return `${s.kind.toUpperCase()[0]}[${inner}]`;
    });
}

test("plain text stays as a single text span", () => {
  const spans = parseWhatsAppFormat("hello world");
  assert.deepEqual(flat(spans), ["T:hello world"]);
});

test("bold markers wrap inner text", () => {
  const spans = parseWhatsAppFormat("hello *world*");
  assert.deepEqual(flat(spans), ["T:hello ", "B[T:world]"]);
});

test("italic markers wrap inner text", () => {
  const spans = parseWhatsAppFormat("_italics_ here");
  assert.deepEqual(flat(spans), ["I[T:italics]", "T: here"]);
});

test("strike markers wrap inner text", () => {
  const spans = parseWhatsAppFormat("~old~ new");
  assert.deepEqual(flat(spans), ["S[T:old]", "T: new"]);
});

test("triple-backtick code is opaque to other markers", () => {
  const spans = parseWhatsAppFormat("type ```const x = *5*``` thanks");
  // The inner *5* must not be parsed as bold.
  assert.deepEqual(flat(spans), ["T:type ", "C:const x = *5*", "T: thanks"]);
});

test("bold containing italic nests correctly", () => {
  const spans = parseWhatsAppFormat("*bold and _italic_ inside*");
  assert.deepEqual(flat(spans), ["B[T:bold and |I[T:italic]|T: inside]"]);
});

test("snake_case variable does NOT become italics", () => {
  // Negative lookbehind/lookahead on alphanumerics — _ surrounded by word chars.
  const spans = parseWhatsAppFormat("Set foo_bar_baz to 1");
  assert.deepEqual(flat(spans), ["T:Set foo_bar_baz to 1"]);
});

test("URL becomes a link span", () => {
  const spans = parseWhatsAppFormat("see https://example.com for more");
  assert.deepEqual(flat(spans), ["T:see ", "L:https://example.com->https://example.com", "T: for more"]);
});

test("www. URL gets an https:// scheme on the href", () => {
  const spans = parseWhatsAppFormat("visit www.example.com");
  assert.deepEqual(flat(spans), ["T:visit ", "L:www.example.com->https://www.example.com"]);
});

test("URL inside bold stays inside bold", () => {
  const spans = parseWhatsAppFormat("*see https://x.com now*");
  // Either bold contains a link, OR the link wraps the surrounding text —
  // here the bold consumes everything between the asterisks, link parsing
  // runs inside.
  assert.equal(spans.length, 1);
  assert.equal(spans[0].kind, "bold");
  const inner = spans[0].children;
  const hasLink = inner.some((s) => s.kind === "link" && s.href === "https://x.com");
  assert.ok(hasLink, "bold body should contain a link span");
});

test("empty input returns an empty span list", () => {
  assert.deepEqual(parseWhatsAppFormat(""), []);
});

test("adjacent bold and italic stay separate", () => {
  const spans = parseWhatsAppFormat("*bold* _italic_");
  assert.deepEqual(flat(spans), ["B[T:bold]", "T: ", "I[T:italic]"]);
});
