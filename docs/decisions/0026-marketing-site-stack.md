# 0026: Astro for the marketing site

Status: accepted

Date: 2026-11-21

This records how `apps/site` is built. It builds on [0001](0001-repository-foundation.md), which places the static marketing site in `apps/site`, and on the [design direction](../product/design-direction.md).

## Decision

- **Framework.** `apps/site` is an [Astro](https://docs.astro.build/) project with static output. Pages and sections are `.astro` files that render to plain HTML and CSS at build time. One small script runs the day and night switch and the scroll reveals; React ships only for the components that need it, as islands (the FAQ accordion when it scrolls into view, the mobile menu on narrow screens).
- **Design values.** Every color, type style, spacing step, radius, size, shadow, and motion value comes from `@repo/tokens/tokens.css`. Values only the marketing site needs (`sky`, `display-hero`, `display-section`, `lede`, `body-lg`, `label-lg`, `code`, `space-8`, `space-9`, `size-page`, `size-measure`, `size-button-lg`) are tokens too, with a usage note that says "Marketing site only". The site's tests refuse a hand-written color in its source.
- **Artwork.** Billy, his outfits, and his pixel world (hills, water, logs, sun, clouds, sparkles, the frame, and the 12-pixel icons) come from `@repo/mascot`. The site imports them as file URLs, so the build copies them untouched and never resamples pixel art. The world artwork started in the landing mocks of the Billy chat canvas and now lives in the package, so the app can use it for empty states.
- **Components.** Standard controls come from [shadcn/ui](https://ui.shadcn.com/) (`radix-nova` style, Radix primitives, Tailwind CSS v4), copied into `apps/site/src/components/ui` and used only by this app: Button, Accordion, Sheet, Separator. Their colors, radii, and fonts map to `@repo/tokens` in `src/styles/ui.css`, the buttons are pills with press feedback, and dark mode follows the tokens' rule. In `.astro` files, links use `buttonVariants()` on a plain `<a>`, because `asChild` cannot merge into children Astro renders. What is ours (Bubble, Card, Billy, the pixel world) stays drawn by hand from [the component contracts](../product/components.md).
- **Deploy.** The build output in `apps/site/dist` is served as static assets by a Cloudflare Worker with no code (`apps/site/wrangler.jsonc`), the same platform as `apps/agent`. Deploying is a separate, approved action; `verify` never deploys.

## Why

The design direction asks for plain, fast HTML that search engines can read, scripts only where something moves, and library components copied in one at a time (principle 4). Astro renders components to HTML at build time and ships no runtime by default, while still giving us components, scoped styles, and an asset pipeline. Hand-built controls fell short on details such as accordion height animation and an accessible mobile menu, so the site copies in shadcn/ui components, which carry those details, and keeps them inside `apps/site`. The repository is TypeScript throughout, and `astro check` type-checks the components.

Sources, read on 2026-11-21: [Astro documentation](https://docs.astro.build/), version 7.4.7 (released 2026-11-05); [shadcn/ui](https://ui.shadcn.com/) CLI 4.23.0 with `@astrojs/react` 7.1.4, React 19.1.10, and Tailwind CSS 4.3.5.

## Revisit if

- The site needs pages that change per visitor, such as accounts or checkout. Those belong in `apps/platform` (0001), not here.
- Astro's static output or its asset handling starts resampling or inlining pixel art in a way we cannot turn off.
