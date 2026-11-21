import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import mascot from "@repo/mascot" with { type: "json" };

const pngSignature = "89504e470d0a1a0a";

const assertPng = async (asset, expected) => {
  const png = await readFile(
    new URL(import.meta.resolve(`@repo/mascot/assets/${asset}`))
  );
  assert.equal(png.toString("hex", 0, 8), pngSignature, asset);
  assert.equal(png.toString("ascii", 12, 16), "IHDR", asset);
  assert.equal(png.readUInt32BE(16), expected.canvas, asset);
  assert.equal(png.readUInt32BE(20), expected.canvas, asset);
  assert.equal(png[25], expected.alpha ? 6 : 2, asset);
};

test("the portrait, base, and accessories export as square RGBA PNGs", async () => {
  const layers = mascot.slots.flatMap(({ layers: slot }) =>
    Object.entries(slot)
  );
  assert.equal(
    new Set(mascot.slots.map(({ id }) => id)).size,
    mascot.slots.length
  );
  assert.equal(new Set(layers.map(([id]) => id)).size, layers.length);
  const assets = [
    mascot.portrait,
    mascot.base,
    ...layers.map(([, file]) => file),
  ];
  assert.equal(new Set(assets).size, assets.length);
  await Promise.all(
    assets.map((asset) =>
      assertPng(asset, { canvas: mascot.canvas, alpha: true })
    )
  );
});

test("icon exports have an RGBA foreground and opaque backgrounds and composites", async () => {
  const { canvas, foreground, light, dark } = mascot.icon;
  await assertPng(foreground, { canvas, alpha: true });
  await Promise.all(
    [light.background, light.flat, dark.background, dark.flat].map((asset) =>
      assertPng(asset, { canvas, alpha: false })
    )
  );
});

test("the web stylesheet resolves through the package interface", async () => {
  const css = await readFile(
    new URL(import.meta.resolve("@repo/mascot/web.css")),
    "utf-8"
  );
  assert.ok(css.includes("prefers-reduced-motion: no-preference"));
});

test("Billy's world and pixel icons are static pixel-grid SVGs", async () => {
  const { pixel, scenery, icons } = mascot.world;
  const files = [...Object.values(scenery), ...Object.values(icons)];
  assert.equal(new Set(files).size, files.length);
  await Promise.all(
    files.map(async (file) => {
      const svg = await readFile(
        new URL(import.meta.resolve(`@repo/mascot/assets/${file}`)),
        "utf-8"
      );
      assert.match(
        svg,
        /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u,
        file
      );
      assert.ok(svg.includes('shape-rendering="crispEdges"'), file);
      assert.doesNotMatch(
        svg,
        /<(?:script|style|image|foreignObject|a)\b/iu,
        file
      );
      const { viewWidth, viewHeight } = svg.match(
        /viewBox="0 0 (?<viewWidth>\d+) (?<viewHeight>\d+)"/u
      ).groups;
      const { width } = svg.match(/ width="(?<width>\d+)"/u).groups;
      const { height } = svg.match(/ height="(?<height>\d+)"/u).groups;
      assert.equal(Number(width), Number(viewWidth) * pixel, file);
      assert.equal(Number(height), Number(viewHeight) * pixel, file);
    })
  );
});
