# 0026: Astro for the marketing site

Status: accepted

Date: 2026-11-21

This records how `apps/site` is built. It builds on [0001](0001-repository-foundation.md), which places the static marketing site in `apps/site`, and on the [design direction](../product/design-direction.md).

## Decision

- **Framework.** `apps/site` is an [Astro](https://docs.astro.build/) project with static output. Pages and components are `.astro` files that render to plain HTML and CSS at build time. A component ships JavaScript only when something on the page moves; today that is one small script that plays Billy's greeting once.
- **Design values.** Every color, type style, spacing step, radius, size, shadow, and motion value comes from `@repo/tokens/tokens.css`. Values only the marketing site needs (`sky`, `display-hero`, `display-section`, `lede`, `body-lg`, `label-lg`, `code`, `space-8`, `space-9`, `size-page`, `size-measure`, `size-button-lg`) are tokens too, with a usage note that says "Marketing site only". The site's tests refuse a hand-written color in its source.
- **Artwork.** Billy, his outfits, and his pixel world (hills, water, logs, sun, clouds, sparkles, the frame, and the 12-pixel icons) come from `@repo/mascot`. The site imports them as file URLs, so the build copies them untouched and never resamples pixel art. The world artwork started in the landing mocks of the Billy chat canvas and now lives in the package, so the app can use it for empty states.
- **Components.** The site draws the shared contracts from [the component contracts](../product/components.md) (Button, Bubble, Card) with built-in elements: `<a>` and `<button>`, `<details>` for questions. No component library is installed.
- **Deploy.** The build output in `apps/site/dist` is served as static assets by a Cloudflare Worker with no code (`apps/site/wrangler.jsonc`), the same platform as `apps/agent`. Deploying is a separate, approved action; `verify` never deploys.

## Why

The design direction asks for plain, fast HTML that search engines can read, scripts only where something moves, and no app-style component library on the marketing site (principle 4). Astro renders components to HTML at build time and ships no runtime by default, while still giving us components, scoped styles, and an asset pipeline. The repository is TypeScript throughout, and `astro check` type-checks the components.

Sources, read on 2026-11-21: [Astro documentation](https://docs.astro.build/), version 7.4.7 (released 2026-11-05).

## Revisit if

- The site needs pages that change per visitor, such as accounts or checkout. Those belong in `apps/platform` (0001), not here.
- Astro's static output or its asset handling starts resampling or inlining pixel art in a way we cannot turn off.
