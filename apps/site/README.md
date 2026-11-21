# Marketing site

The public site for Billy: a static [Astro](https://docs.astro.build/) project ([decision 0026](../../docs/decisions/0026-marketing-site-stack.md)). It builds plain HTML and CSS, one small script, and React islands only where a shadcn component needs them.

```sh
pnpm --filter @repo/site dev      # local server with reload
pnpm --filter @repo/site build    # writes dist/
pnpm --filter @repo/site verify   # astro check, build, and tests
```

## Where things come from

- Colors, type, spacing, radii, sizes, shadows, and motion: `@repo/tokens/tokens.css`. Never write a value by hand; add a token with a usage note instead ([tokens README](../../packages/tokens/README.md)). The tests refuse a hand-written color.
- Billy, his outfits, his pixel world, and the pixel icons: `@repo/mascot`, through [src/art.ts](src/art.ts). Pixel art is imported as a file URL, drawn with `.px` (`image-rendering: pixelated`), and never redrawn or recolored.
- Standard controls (Button, Accordion, Sheet, Separator) are shadcn/ui components in `src/components/ui`, added with `pnpm dlx shadcn@4.23.0 add <name>` from this folder. Their colors and radii map to the tokens in `src/styles/ui.css`; never give them raw colors. In `.astro` files, style a link with `buttonVariants()`; `asChild` works only inside React components.
- Bubble and Card, Billy, and the pixel world are ours, drawn from [the component contracts](../../docs/product/components.md).

## Layout

- `src/pages`: one file per route (`index.astro`, `404.astro`).
- `src/components`: page sections (`hero`, `pillars`, `feature`, `privacy`, `self-host`, `faq`, `closing`, `footer`), the illustration panels (`capture-art`, `brief-art`, `work-art`, `mini-world`), and the drawn pieces (`billy`, `bubble`, `confirmation`, `reminder-row`, `tile`, `pixel-icon`, `avatar`).
- `src/styles/site.css`: the reset, the content column (`.wrap`), the marketing type classes, the Button contract, day and night scenery, and the motion.
- `src/scripts/site.ts` and `src/scripts/hero.ts`: the only scripts. It switches day and night from the sun or moon, turns the header into a material on scroll, and reveals sections and chat messages as they scroll in.

## Motion

Motion follows `.agents/skills/apple-design`, `.agents/skills/emil-design-eng`, and `.agents/skills/review-animations`, with durations and curves from the motion tokens.

- Day and night: pressing the sun or moon saves the choice (`billy-theme` in local storage, applied before first paint) and plays a circular reveal out of it with the View Transitions API (`duration-theme`). Without that API, or under reduced motion, the theme switches at once.
- Scenery: clouds drift left to right across their scene (`duration-drift`, linear) and float (`duration-bob`); the water flows (`duration-flow`); stars twinkle at night. At night the scenery is dimmed with a filter; Billy never is.
- Billy does not move on the site for now: no greeting, idle, or tap animation. His animation comes later, from the mascot artwork.
- Hero: "Tell Billy." arrives word by word out of a blur, holds a beat, then "He'll do it all." follows; the lede and buttons rise after it. Around the headline float six small, tilted conversations, alternating sides, each a different everyday job: recall a Note, the morning Brief, a follow-up Billy starts, a quick capture, a Reminder, a list. On load they play in one after another (your message, Billy saying what he is doing, his answer) and then stay, floating (`src/components/vignette*.astro`, `src/scripts/hero.ts`). Narrow screens stack two of them above Billy. It waits while the hero is off screen or the tab is hidden.
- Buttons: "Get Billy" sweeps a light across once on hover and nudges its arrow; "See how it works" nudges down.
- Arrival: hero chat floats in once, sections and the messages in each chat panel arrive as they scroll into view, and questions open smoothly.
- Feedback: buttons and the sun scale on press; tiles and cards lift on hover only where there is a fine pointer.
- Reduced motion: no loops, no reveals, no movement; everything is visible at rest. Without script, everything is visible too.

Verification is described in [docs/verification/site.md](../../docs/verification/site.md).
