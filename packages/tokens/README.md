# Design tokens

[tokens.json](tokens.json) is the single source for the colors, type, spacing, radii, sizes, shadows, and motion of the marketing site and the iOS app. No hex value, size, or font is written by hand outside it ([design direction](../../docs/product/design-direction.md), principle 2). The file uses the format of the Billy design system, so the two can be synced in both directions.

## Outputs

`pnpm --filter @repo/tokens build` writes two files from `tokens.json`. Both are checked in, and verification fails when they are out of date. Never edit them by hand.

- [tokens.css](tokens.css) for the web: custom properties on `:root`. Dark values apply under `prefers-color-scheme: dark`, and `data-theme="light"` or `data-theme="dark"` on the root element forces a theme. Durations drop to `0ms` under `prefers-reduced-motion: reduce`.
- [theme.json](theme.json) for the app: colors resolved to hex for each theme, and lengths as plain numbers in points. Each text style names the iOS Dynamic Type style it scales with (`iosTextStyle`). Shadows are split into layers, and easings into their parameters. A percentage radius is `{ "percent": n }`. The app turns this file into its native theme when the app's stack is chosen.

```css
@import "@repo/tokens/tokens.css";

.bubble-billy {
  background: var(--color-bubble-billy);
  color: var(--color-ink);
  font: var(--text-body);
  letter-spacing: var(--text-body-tracking);
  border-radius: var(--radius-lg) var(--radius-lg) var(--radius-lg)
    var(--radius-tail);
  padding: var(--space-3) var(--space-4);
}
```

CSS names: colors are `--color-<name>`, families are `--font-<name>`, each text style is `--text-<name>` (a `font` shorthand) and `--text-<name>-tracking`, and every other token keeps its own name (`--space-4`, `--radius-sm`, `--duration-quick`).

## Contrast is checked against the tokens

`contrast.pairs` in `tokens.json` lists every approved pair of foreground and background with its WCAG AA minimum: 4.5:1 for text and 3:1 for control edges and focus rings. The build and the tests check each pair in every theme, so a failing color cannot ship. A pair that is not listed is not approved. When a component needs a new pair, add it to the list in the same change.

## Change a token

1. Edit `tokens.json`. Every token needs a `usage` note that says where it goes.
2. Run `pnpm --filter @repo/tokens build`, then `pnpm --filter @repo/tokens verify`.
3. Sync the Billy design system from the new file, so designers and the code see the same values.

The [component contracts](../../docs/product/components.md) name the tokens each shared component uses. Billy's artwork lives in [@repo/mascot](../mascot/README.md).
