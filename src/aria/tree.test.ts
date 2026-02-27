import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { DOMParser } from "@b-fuze/deno-dom";
import { buildAriaTree, type DomElement } from "./tree.ts";
import { renderYaml } from "./render.ts";

function snapshot(
  html: string,
  options?: { maxDepth?: number; maxNodes?: number; selector?: string },
): string {
  const doc = new DOMParser().parseFromString(
    `<html><body>${html}</body></html>`,
    "text/html",
  );
  const root = options?.selector
    ? doc.querySelector(options.selector) as unknown as DomElement
    : doc.body as unknown as DomElement;
  if (!root) return "";
  const tree = buildAriaTree(root, options);
  return renderYaml(tree);
}

Deno.test("link with href gets role and ref", () => {
  const yaml = snapshot(`<a href="/about">About Us</a>`);
  assertStringIncludes(yaml, `link "About Us" [ref=e1]`);
});

Deno.test("anchor without href has no role", () => {
  const yaml = snapshot(`<a>Not a link</a>`);
  assert(!yaml.includes("- link"));
});

Deno.test("button gets role and ref", () => {
  const yaml = snapshot(`<button>Click me</button>`);
  assertStringIncludes(yaml, `button "Click me" [ref=e1]`);
});

Deno.test("heading level preserved", () => {
  const yaml = snapshot(`<h2>Chapter One</h2>`);
  assertStringIncludes(yaml, `heading "Chapter One" [level=2]`);
});

Deno.test("all heading levels", () => {
  for (let i = 1; i <= 6; i++) {
    const yaml = snapshot(`<h${i}>Title</h${i}>`);
    assertStringIncludes(yaml, `[level=${i}]`);
  }
});

Deno.test("table structure maps to ARIA roles", () => {
  const html = `<table>
    <tr><th>Rank</th><th>Title</th></tr>
    <tr><td>1</td><td>Some Book</td></tr>
  </table>`;
  const yaml = snapshot(html);
  assertStringIncludes(yaml, "table:");
  assertStringIncludes(yaml, "row:");
  assertStringIncludes(yaml, `columnheader "Rank"`);
  assertStringIncludes(yaml, `columnheader "Title"`);
  assertStringIncludes(yaml, `cell "1"`);
  assertStringIncludes(yaml, `cell "Some Book"`);
});

Deno.test("img with alt gets role and name", () => {
  const yaml = snapshot(`<img alt="Logo" src="logo.png">`);
  assertStringIncludes(yaml, `img "Logo"`);
});

Deno.test("hidden elements excluded - display:none", () => {
  const yaml = snapshot(`<div>Visible</div><div style="display:none">Hidden</div>`);
  assertStringIncludes(yaml, "Visible");
  assert(!yaml.includes("Hidden"));
});

Deno.test("hidden elements excluded - aria-hidden", () => {
  const yaml = snapshot(`<p>Shown</p><p aria-hidden="true">Secret</p>`);
  assertStringIncludes(yaml, "Shown");
  assert(!yaml.includes("Secret"));
});

Deno.test("hidden elements excluded - hidden attribute", () => {
  const yaml = snapshot(`<p>Shown</p><p hidden>Secret</p>`);
  assertStringIncludes(yaml, "Shown");
  assert(!yaml.includes("Secret"));
});

Deno.test("generic div wrappers collapsed", () => {
  const yaml = snapshot(`<div><div><a href="/">Home</a></div></div>`);
  assert(!yaml.includes("generic"));
  assertStringIncludes(yaml, `link "Home"`);
});

Deno.test("generic span wrappers collapsed", () => {
  const yaml = snapshot(`<span><button>Go</button></span>`);
  assert(!yaml.includes("generic"));
  assertStringIncludes(yaml, `button "Go"`);
});

Deno.test("aria-label overrides text content", () => {
  const yaml = snapshot(`<button aria-label="Close dialog">X</button>`);
  assertStringIncludes(yaml, `button "Close dialog"`);
  assert(!yaml.includes(`"X"`));
});

Deno.test("nav maps to navigation", () => {
  const yaml = snapshot(`<nav><a href="/">Home</a></nav>`);
  assertStringIncludes(yaml, "navigation:");
});

Deno.test("landmark roles", () => {
  const yaml = snapshot(`
    <header><a href="/">Logo</a></header>
    <main><p>Content</p></main>
    <footer><p>Copyright</p></footer>
  `);
  assertStringIncludes(yaml, "banner:");
  assertStringIncludes(yaml, "main:");
  assertStringIncludes(yaml, "contentinfo:");
});

Deno.test("list and listitem", () => {
  const yaml = snapshot(`<ul><li>One</li><li>Two</li></ul>`);
  assertStringIncludes(yaml, "list:");
  assertStringIncludes(yaml, `listitem "One"`);
  assertStringIncludes(yaml, `listitem "Two"`);
});

Deno.test("input gets textbox role and ref", () => {
  const yaml = snapshot(`<input type="text">`);
  assertStringIncludes(yaml, `textbox [ref=e1]`);
});

Deno.test("select gets combobox role and ref", () => {
  const yaml = snapshot(`<select><option>A</option></select>`);
  assertStringIncludes(yaml, `combobox`);
  assertStringIncludes(yaml, `ref=e1`);
});

Deno.test("textarea gets textbox role and ref", () => {
  const yaml = snapshot(`<textarea></textarea>`);
  assertStringIncludes(yaml, `textbox [ref=e1]`);
});

Deno.test("refs increment sequentially", () => {
  const yaml = snapshot(`
    <a href="/a">A</a>
    <a href="/b">B</a>
    <button>C</button>
  `);
  assertStringIncludes(yaml, `[ref=e1]`);
  assertStringIncludes(yaml, `[ref=e2]`);
  assertStringIncludes(yaml, `[ref=e3]`);
});

Deno.test("section without label is transparent", () => {
  const yaml = snapshot(`<section><p>Hello</p></section>`);
  assert(!yaml.includes("region"));
  assertStringIncludes(yaml, `paragraph "Hello"`);
});

Deno.test("section with aria-label becomes region", () => {
  const yaml = snapshot(`<section aria-label="Sidebar"><p>Hello</p></section>`);
  assertStringIncludes(yaml, `region "Sidebar":`);
});

Deno.test("explicit role attribute overrides implicit", () => {
  const yaml = snapshot(`<div role="alert">Warning!</div>`);
  assertStringIncludes(yaml, `alert "Warning!"`);
});

Deno.test("maxDepth limits tree depth", () => {
  const yaml = snapshot(
    `<nav><ul><li><a href="/">Deep</a></li></ul></nav>`,
    { maxDepth: 2 },
  );
  assertStringIncludes(yaml, "navigation:");
  assertStringIncludes(yaml, "list:");
  // At maxDepth=2 the link child is omitted; listitem appears without children
  assert(!yaml.includes("link"));
});

Deno.test("maxNodes limits total nodes", () => {
  const yaml = snapshot(
    `<p>One</p><p>Two</p><p>Three</p><p>Four</p><p>Five</p>`,
    { maxNodes: 3 },
  );
  const matches = yaml.match(/paragraph/g);
  assertEquals(matches?.length, 3);
});

Deno.test("selector scopes to subtree", () => {
  const yaml = snapshot(
    `<div id="outside"><p>Skip</p></div><div id="target"><p>Include</p></div>`,
    { selector: "#target" },
  );
  assert(!yaml.includes("Skip"));
  assertStringIncludes(yaml, `paragraph "Include"`);
});

Deno.test("selector preserves semantic root element", () => {
  const yaml = snapshot(
    `<div><nav id="main-nav"><a href="/">Home</a></nav></div>`,
    { selector: "#main-nav" },
  );
  assertStringIncludes(yaml, "navigation:");
  assertStringIncludes(yaml, `link "Home"`);
});

Deno.test("empty document produces empty string", () => {
  const yaml = snapshot(``);
  assertEquals(yaml, "");
});

Deno.test("visibility:hidden excluded", () => {
  const yaml = snapshot(
    `<p>Shown</p><p style="visibility: hidden">Ghost</p>`,
  );
  assertStringIncludes(yaml, "Shown");
  assert(!yaml.includes("Ghost"));
});

Deno.test("hidden input type excluded", () => {
  const yaml = snapshot(`<input type="hidden" value="secret">`);
  assertEquals(yaml, "");
});

Deno.test("cell with link child", () => {
  const yaml = snapshot(`<table><tr><td><a href="/book">Title</a></td></tr></table>`);
  assertStringIncludes(yaml, "cell:");
  assertStringIncludes(yaml, `link "Title"`);
});

Deno.test("checkbox input gets checkbox role", () => {
  const yaml = snapshot(`<input type="checkbox">`);
  assertStringIncludes(yaml, `checkbox [ref=e1]`);
});

Deno.test("radio input gets radio role", () => {
  const yaml = snapshot(`<input type="radio">`);
  assertStringIncludes(yaml, `radio [ref=e1]`);
});

Deno.test("submit input gets button role and value as name", () => {
  const yaml = snapshot(`<input type="submit" value="Send">`);
  assertStringIncludes(yaml, `button "Send" [ref=e1]`);
});

Deno.test("article gets article role", () => {
  const yaml = snapshot(`<article><p>Content</p></article>`);
  assertStringIncludes(yaml, "article:");
});

Deno.test("aside gets complementary role", () => {
  const yaml = snapshot(`<aside><p>Sidebar</p></aside>`);
  assertStringIncludes(yaml, "complementary:");
});

Deno.test("ordered list gets list role", () => {
  const yaml = snapshot(`<ol><li>First</li></ol>`);
  assertStringIncludes(yaml, "list:");
  assertStringIncludes(yaml, `listitem "First"`);
});

Deno.test("form with aria-label gets form role", () => {
  const yaml = snapshot(`<form aria-label="Login"><input type="text"></form>`);
  assertStringIncludes(yaml, `form "Login":`);
});

Deno.test("form without label is transparent", () => {
  const yaml = snapshot(`<form><input type="text"></form>`);
  assert(!yaml.includes("form"));
  assertStringIncludes(yaml, "textbox");
});

Deno.test("explicit role on span prevents text leaking into parent name", () => {
  const yaml = snapshot(`<p>Hello <span role="button">Click</span></p>`);
  assert(!yaml.includes(`paragraph "Hello Click"`));
  assertStringIncludes(yaml, `button "Click"`);
});

Deno.test("role=presentation is transparent", () => {
  const yaml = snapshot(`<div role="presentation"><a href="/">Home</a></div>`);
  assert(!yaml.includes("presentation"));
  assertStringIncludes(yaml, `link "Home"`);
});

Deno.test("role=none is transparent", () => {
  const yaml = snapshot(`<nav role="none"><a href="/">Home</a></nav>`);
  assert(!yaml.includes("navigation"));
  assert(!yaml.includes("none"));
  assertStringIncludes(yaml, `link "Home"`);
});

Deno.test("aria-hidden=True (uppercase) is excluded", () => {
  const yaml = snapshot(`<p>Shown</p><p aria-hidden="True">Hidden</p>`);
  assertStringIncludes(yaml, "Shown");
  assert(!yaml.includes("Hidden"));
});

Deno.test("text across inline elements preserves spacing", () => {
  const yaml = snapshot(`<p>Click <strong>here</strong> now</p>`);
  assertStringIncludes(yaml, `paragraph "Click here now"`);
});
