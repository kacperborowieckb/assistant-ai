import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

// These tests read the built site in dist/, so run `pnpm build` first.
const dist = new URL("../dist/", import.meta.url);
const read = (path) => readFileSync(new URL(path, dist), "utf-8");
const pages = ["index.html", "404.html"];

const walk = (url) =>
  readdirSync(url, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(new URL(`${entry.name}/`, url)).map(
          (path) => `${entry.name}/${path}`
        )
      : [entry.name]
  );

const sourceFiles = walk(new URL("../src/", import.meta.url)).map(
  (path) => new URL(`../src/${path}`, import.meta.url)
);

test("the build has exactly the expected pages", () => {
  const html = walk(dist).filter((path) => path.endsWith(".html"));
  assert.deepEqual(html.toSorted(), pages.toSorted());
});

test("each page has one h1, a language, a title, and a description", () => {
  for (const page of pages) {
    const html = read(page);
    assert.equal(html.match(/<h1\b/gu)?.length, 1, page);
    assert.match(html, /<html lang="en"/u, page);
    assert.match(html, /<title>[^<]+<\/title>/u, page);
    assert.match(html, /<meta name="description" content="[^"]+"/u, page);
  }
});

test("every image has an alt attribute and a file in the build", () => {
  for (const page of pages) {
    for (const [tag] of read(page).matchAll(/<img\b[^>]*>/gu)) {
      assert.match(tag, /\balt(?:="|[\s>])/u, `${page}: ${tag}`);
      const { src } = tag.match(/\bsrc="(?<src>[^"]+)"/u).groups;
      assert.ok(
        existsSync(new URL(`.${src}`, dist)),
        `${page}: missing ${src}`
      );
    }
  }
});

const idsOf = (html) =>
  new Set(
    [...html.matchAll(/\bid="(?<id>[^"]+)"/gu)].map((match) => match.groups.id)
  );

test("in-page links and labels point at elements that exist", () => {
  const home = idsOf(read("index.html"));
  for (const page of pages) {
    const html = read(page);
    const ids = idsOf(html);
    for (const {
      groups: { id },
    } of html.matchAll(/\bhref="\/#(?<id>[^"]+)"/gu)) {
      assert.ok(
        home.has(id),
        `${page}: no element with id ${id} on the home page`
      );
    }
    const references = [
      ...[...html.matchAll(/\bhref="#(?<id>[^"]+)"/gu)].map(
        (match) => match.groups.id
      ),
      ...[...html.matchAll(/\baria-labelledby="(?<id>[^"]+)"/gu)].map(
        (match) => match.groups.id
      ),
    ];
    for (const id of references) {
      assert.ok(ids.has(id), `${page}: no element with id ${id}`);
    }
  }
});

test("every custom property the CSS reads without a fallback is defined", () => {
  const css = walk(dist)
    .filter((path) => path.endsWith(".css"))
    .map((path) => read(path))
    .join("\n");
  const html = pages.map(read).join("\n");
  const defined = new Set(
    [...`${css}\n${html}`.matchAll(/(?<name>--[\w-]+)\s*:/gu)].map(
      (match) => match.groups.name
    )
  );
  const used = new Set(
    [...css.matchAll(/var\((?<name>--[\w-]+)\)/gu)].map(
      (match) => match.groups.name
    )
  );
  for (const name of used) {
    if (name.startsWith("--tw")) {
      // Tailwind's own internals, registered with @property.
      continue;
    }
    assert.ok(defined.has(name), `undefined custom property ${name}`);
  }
});

test("no color is written by hand: colors come from @repo/tokens", () => {
  for (const file of sourceFiles) {
    const source = readFileSync(file, "utf-8");
    assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b(?![\w-])/iu, file.pathname);
    assert.doesNotMatch(source, /\b(?:rgba?|hsla?|oklch)\(/u, file.pathname);
  }
});

test("the sun or moon is a named button that switches day and night", () => {
  const html = read("index.html");
  const toggle = html.match(/<button\b[^>]*data-theme-toggle[^>]*>/u)?.[0];
  assert.ok(toggle, "no theme toggle");
  assert.match(toggle, /aria-label="Switch to (?:night|day)"/u);
  assert.match(toggle, /type="button"/u);
});

// Walks CSS blocks and returns every declaration with a looping animation
// whose enclosing rules do not include a reduced-motion "no-preference"
// condition.
const unguardedLoops = (css) => {
  const found = [];
  const preludes = [];
  let text = "";
  for (const character of css.replaceAll(/\/\*[\s\S]*?\*\//gu, "")) {
    if (character === "{") {
      preludes.push(text.trim());
      text = "";
    } else if (character === "}" || character === ";") {
      const declaration = text.trim();
      const guarded = preludes.some((prelude) =>
        /prefers-reduced-motion:\s*no-preference/u.test(prelude)
      );
      if (
        /^animation(?:-iteration-count)?\s*:.*\binfinite\b/u.test(
          declaration
        ) &&
        !guarded
      ) {
        found.push(declaration);
      }
      text = "";
      if (character === "}") {
        preludes.pop();
      }
    } else {
      text += character;
    }
  }
  return found;
};

test("the reduced-motion check catches loops outside a no-preference block", () => {
  assert.deepEqual(
    unguardedLoops(
      "@media (min-width:1px){.cloud{animation:drift 1s infinite}}"
    ),
    ["animation:drift 1s infinite"]
  );
  assert.deepEqual(unguardedLoops(".cloud{animation:drift 1s infinite}"), [
    "animation:drift 1s infinite",
  ]);
  assert.deepEqual(
    unguardedLoops(
      "@media (prefers-reduced-motion:no-preference){.cloud{animation:drift 1s infinite}}"
    ),
    []
  );
  assert.deepEqual(
    unguardedLoops(
      "@media (prefers-reduced-motion:no-preference){@media (min-width:1px){.a{animation:x 1s infinite}}}"
    ),
    []
  );
});

test("ambient motion stops when the person asks for reduced motion", () => {
  const css = walk(dist)
    .filter((path) => path.endsWith(".css"))
    .map((path) => read(path))
    .join("\n");
  assert.match(
    css,
    /\binfinite\b/u,
    "the built CSS has looping animations to check"
  );
  assert.deepEqual(
    unguardedLoops(css),
    [],
    "a looping animation runs outside a reduced-motion check"
  );
});
