# Contributing

## Setup and verification

Use Node.js 24.15.0 or later and the pnpm version in `package.json`.

Run `pnpm install --frozen-lockfile`. The prepare script installs Lefthook commit and push hooks in a Git checkout.

Run `pnpm verify` before you finish a change. The local hooks and GitHub CI run the same command. It checks lint and formatting across the repository. Run `pnpm fix` to apply automatic fixes, then verify again.

The gate also checks the [primitives catalog](docs/primitives/README.md) and [verification targets](docs/verification/README.md). Then Turborepo runs the `verify` script of each workspace that the branch changed (`turbo run verify --affected`). Each workspace guide in `docs/verification` names its checks. Keep the local and CI verification commands the same.

For tool configuration problems, run `pnpm exec ultracite doctor`.

## Scope and decisions

Create each workspace only at its stage, as [repository foundation](docs/decisions/0001-repository-foundation.md) describes. Read [repository foundation](docs/decisions/0001-repository-foundation.md) before changing the toolchain and [agent authority](docs/decisions/0002-agent-authority.md) before taking an external action.

Add a short decision record for a choice that affects several PRs. Include the decision, reason, and a concrete condition for review. Supersede accepted records instead of changing their history.

## Pull requests

Use the PR template. State the problem, resulting behavior, risk, reversibility, verification results, and cleanup work. Report checks you did not run and failures the change did not cause. Test expectation changes must follow the intended behavior and have an explanation.

Changes reach `main` only through a pull request with a passing `Verify` check. The repository owner controls publishing, releases, and merging. This setup has no automatic merge or ship process.

## Friction, cleanup, and priorities

Search existing issues first. Use the friction form for a recurring, reproducible problem in this repository. Use the cleanup form for deferred work and state a testable Ready when condition. File one problem per issue and keep secrets and personal data out of it.

Give each issue a priority:

- P0: A current failure blocks users or agent work. Work on it first.
- P1: A recurring problem causes substantial work. Address it this week.
- P2: Useful work after higher-priority issues.
- P3: Optional improvement that can wait for related work.

Use `needs-decision` when an issue needs an owner decision. Record the question and wait for the answer before dependent work. Work on the highest-priority unblocked issue first. Record skipped friction and its reason as `friction-skipped`.

The forms record priority and decision status in the issue body. Apply the matching `friction`, `friction-skipped`, `P0` through `P3`, and `needs-decision` labels during triage. Agents file and label issues as part of authorized PR work; the repository owner resolves decision-marked issues. There is no background triage process.
