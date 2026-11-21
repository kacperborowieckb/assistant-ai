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
- `src/styles/site.css`: the reset, the content column (`.wrap`), the marketing type classes, and the Button contract.

Verification is described in [docs/verification/site.md](../../docs/verification/site.md).
