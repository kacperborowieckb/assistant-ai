# Marketing site

The public site for Billy: a static [Astro](https://docs.astro.build/) project ([decision 0026](../../docs/decisions/0026-marketing-site-stack.md)). It builds plain HTML and CSS, and ships one small script that plays Billy's greeting once.

```sh
pnpm --filter @repo/site dev      # local server with reload
pnpm --filter @repo/site build    # writes dist/
pnpm --filter @repo/site verify   # astro check, build, and tests
```

## Where things come from

- Colors, type, spacing, radii, sizes, shadows, and motion: `@repo/tokens/tokens.css`. Never write a value by hand; add a token with a usage note instead ([tokens README](../../packages/tokens/README.md)). The tests refuse a hand-written color.
- Billy, his outfits, his pixel world, and the pixel icons: `@repo/mascot`, through [src/art.ts](src/art.ts). Pixel art is imported as a file URL, drawn with `.px` (`image-rendering: pixelated`), and never redrawn or recolored.
- Bubble, Card, and Button follow [the component contracts](../../docs/product/components.md).

## Layout

- `src/pages`: one file per route (`index.astro`, `404.astro`).
- `src/components`: page sections (`hero`, `pillars`, `feature`, `privacy`, `self-host`, `faq`, `closing`, `footer`), the illustration panels (`capture-art`, `brief-art`, `work-art`, `mini-world`), and the drawn pieces (`billy`, `bubble`, `confirmation`, `reminder-row`, `tile`, `pixel-icon`, `avatar`).
- `src/styles/site.css`: the reset, the content column (`.wrap`), the marketing type classes, the Button contract, day and night scenery, and the motion.
- `src/scripts/site.ts`: the only script. It switches day and night from the sun or moon, turns the header into a material on scroll, reveals sections and chat messages as they scroll in, and lets Billy answer a tap.

## Motion

Motion follows `.agents/skills/apple-design`, `.agents/skills/emil-design-eng`, and `.agents/skills/review-animations`, with durations and curves from the motion tokens.

- Day and night: pressing the sun or moon saves the choice (`billy-theme` in local storage, applied before first paint) and plays a circular reveal out of it with the View Transitions API (`duration-theme`). Without that API, or under reduced motion, the theme switches at once.
- Scenery: clouds drift left to right across their scene (`duration-drift`, linear) and float (`duration-bob`); the water flows (`duration-flow`); stars twinkle at night. At night the scenery is dimmed with a filter; Billy never is.
- Arrival: hero chat floats in once, sections and the messages in each chat panel arrive as they scroll into view, and questions open smoothly.
- Feedback: buttons, the sun, and Billy scale on press; tiles and cards lift on hover only where there is a fine pointer.
- Reduced motion: no loops, no reveals, no movement; everything is visible at rest. Without script, everything is visible too.

Verification is described in [docs/verification/site.md](../../docs/verification/site.md).
