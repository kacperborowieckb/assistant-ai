# Tokens verification

Run `pnpm --filter @repo/tokens verify`. It first runs `node build.mjs --check`, which fails when `tokens.css` or `theme.json` no longer matches `tokens.json`. Then the tests read the outputs through the package interface and check:

- Every pair in `contrast.pairs` meets its WCAG AA minimum in every theme, and a token change that breaks a pair fails the build.
- Color aliases resolve in each theme, and a missing alias, an alias loop, a named color, a duplicate name, or a token with no usage note is refused.
- The stylesheet has the light values on `:root`, the dark values under `prefers-color-scheme: dark` and `data-theme="dark"`, and zero durations under `prefers-reduced-motion: reduce`.
- The native theme has a hex color for every token in every theme, point values, Dynamic Type styles, shadow layers, and easing parameters.

The tests use only the checked-in files and need no credentials or network access.

After a change to `tokens.json`, run `pnpm --filter @repo/tokens build` and commit the outputs with it. Then sync the Billy design system from `tokens.json`.
