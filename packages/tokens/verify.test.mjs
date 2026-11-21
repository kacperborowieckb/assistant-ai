import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import theme from "@repo/tokens/theme.json" with { type: "json" };
import tokens from "@repo/tokens/tokens.json" with { type: "json" };

import {
  contrastRatio,
  contrastResults,
  resolveColors,
  toCss,
  toTheme,
  validate,
} from "./lib.mjs";

const copy = () => structuredClone(tokens);
const colorToken = (source, name) =>
  source.color.tokens.find((token) => token.name === name);

test("contrast ratios match the WCAG formula", () => {
  assert.equal(contrastRatio("#000000", "#ffffff").toFixed(2), "21.00");
  assert.equal(contrastRatio("#ffffff", "#ffffff"), 1);
  assert.equal(
    contrastRatio("#31594b", "#ffffff"),
    contrastRatio("#fff", "#31594b")
  );
});

test("every declared text and control pair meets its minimum in every theme", () => {
  const results = contrastResults(tokens);
  assert.equal(
    results.length,
    tokens.contrast.pairs.length * tokens.color.themes.length
  );
  const failing = results.filter(({ passes }) => !passes);
  assert.deepEqual(failing, []);
  for (const { min } of tokens.contrast.pairs) {
    assert.ok(min === 4.5 || min === 3, `use the WCAG AA minimums, not ${min}`);
  }
});

test("a color that fails its contrast pair cannot build", () => {
  const broken = copy();
  colorToken(broken, "ink-muted").value.dark = "#5a5650";
  assert.throws(() => toCss(broken), /ink-muted on surface in dark/u);
  assert.throws(() => toTheme(broken), /below 4.5:1/u);
});

test("aliases resolve per theme, and broken aliases are refused", () => {
  const colors = resolveColors(tokens);
  for (const values of Object.values(colors)) {
    assert.equal(values["bubble-you"], values.forest);
    assert.equal(values["focus-ring"], values.forest);
  }
  const missing = copy();
  colorToken(missing, "focus-ring").value.light = "{nowhere}";
  assert.throws(() => validate(missing), /unknown color alias/u);
  const loop = copy();
  colorToken(loop, "forest").value.light = "{focus-ring}";
  assert.throws(() => validate(loop), /alias loop/u);
});

test("the native theme expands short hex to six digits", () => {
  const short = copy();
  colorToken(short, "surface").value.light = "#fff";
  assert.equal(toTheme(short).colors.light.surface, "#ffffff");
  assert.equal(toTheme(short).colors.light["surface-raised"], "#ffffff");
});

test("names are unique and every token says how to use it", () => {
  const duplicate = copy();
  duplicate.radius.tokens.push({
    name: "space-1",
    value: "1px",
    usage: "Duplicate.",
  });
  assert.throws(() => validate(duplicate), /duplicate token name: space-1/u);
  const twoBodies = copy();
  twoBodies.type.groups[1].styles.push({
    ...twoBodies.type.groups[1].styles[0],
    name: "body",
  });
  assert.throws(() => validate(twoBodies), /duplicate text style name: body/u);
  const silent = copy();
  delete silent.spacing.tokens[0].usage;
  assert.throws(() => validate(silent), /space-1 needs a usage note/u);
  const named = copy();
  colorToken(named, "danger").value.light = "red";
  assert.throws(() => validate(named), /lowercase hex or an alias/u);
});

test("the stylesheet themes colors and stills motion through the package interface", async () => {
  const css = await readFile(
    new URL(import.meta.resolve("@repo/tokens/tokens.css")),
    "utf-8"
  );
  assert.equal(css, toCss(tokens));
  assert.match(css, /--color-surface: #ffffff;/u);
  assert.match(css, /--color-bubble-you: var\(--color-forest\);/u);
  assert.match(
    css,
    /@media \(prefers-color-scheme: dark\) \{\n {2}:root:not\(\[data-theme="light"\]\) \{\n {4}--color-surface: #1a1a19;/u
  );
  assert.match(css, /:root\[data-theme="dark"\] \{\n {2}color-scheme: dark;/u);
  assert.match(css, /--text-body: 400 15px\/22px var\(--font-sans\);/u);
  const reduced = css.slice(css.indexOf("prefers-reduced-motion: reduce"));
  for (const { name, value } of tokens.motion.tokens) {
    if (value.endsWith("ms")) {
      assert.match(reduced, new RegExp(`--${name}: 0ms;`, "u"));
    }
  }
});

test("the native theme has resolved colors and point values for every token", () => {
  assert.deepEqual(theme, toTheme(tokens));
  for (const values of Object.values(theme.colors)) {
    assert.deepEqual(
      Object.keys(values),
      tokens.color.tokens.map(({ name }) => name)
    );
    for (const value of Object.values(values)) {
      assert.match(value, /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/u);
    }
  }
  assert.deepEqual(theme.text.display, {
    family: "display",
    size: 44,
    lineHeight: 43.12,
    weight: 500,
    tracking: -2.64,
    iosTextStyle: "largeTitle",
  });
  assert.equal(theme.space["space-4"], 16);
  assert.deepEqual(theme.radius["radius-round"], { percent: 50 });
  assert.equal(theme.size["size-touch"], 44);
  assert.deepEqual(theme.shadow["shadow-icon"][0], {
    x: 0,
    y: 24,
    blur: 28,
    spread: -18,
    color: "#612d22b3",
  });
  assert.deepEqual(theme.motion["easing-greet"], {
    steps: 1,
    position: "end",
  });
});

test("touch targets stay at least 44 points", () => {
  assert.ok(theme.size["size-touch"] >= 44);
});
