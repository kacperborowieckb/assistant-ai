# Site verification

Run `pnpm --filter @repo/site verify`. It runs `astro check` (types and Astro diagnostics), builds the static site into `apps/site/dist`, and then runs the tests in `apps/site/test` against the build. The tests check:

- The build has exactly the expected pages: `index.html` and `404.html`. Adding or removing a page fails until the test's list changes with it.
- Each page has one `h1`, `lang="en"`, a title, and a description.
- Every image has an `alt` attribute (empty for decoration) and its file exists in the build.
- Every in-page link (`#id`), home-page link (`/#id`), and `aria-labelledby` points at an element that exists.
- Every custom property the CSS reads (`var(--…)`) is defined, so a mistyped or removed token fails the build.
- No color is written by hand in `apps/site/src`: colors come from `@repo/tokens`.

The tests use only the checked-in files and need no credentials or network access.

## Look at it

Run `pnpm --filter @repo/site dev` and open the printed local address, or `pnpm --filter @repo/site build && pnpm --filter @repo/site preview` for the production build. Check the page at 1440px and 390px wide in light and dark, with no sideways scroll. Turn on reduced motion and check that Billy does not move when the page opens.

Deploying (`wrangler deploy` from `apps/site` after a build) changes a public site and needs the repository owner's approval ([decision 0002](../decisions/0002-agent-authority.md)). Verification never deploys.
