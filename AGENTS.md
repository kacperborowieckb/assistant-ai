# Agent task map

- Setup, verification, PRs, and issue triage: [CONTRIBUTING.md](CONTRIBUTING.md). Run `pnpm verify` before handoff; CI and local Git hooks use the same command.
- Toolchain changes: [repository foundation decision](docs/decisions/0001-repository-foundation.md) and `.agents/skills/turborepo/SKILL.md`.
- External actions or approval questions: [agent authority decision](docs/decisions/0002-agent-authority.md).
- JavaScript, TypeScript, lint, and format changes: `.agents/skills/ultracite/SKILL.md`.
- shadcn UI (used only in `apps/site`): `.agents/skills/shadcn/SKILL.md`.
- Motion in the Expo app (animations, gestures, sheets, haptics): `.agents/skills/animate-expo/SKILL.md`. Take curves and durations from [@repo/tokens](packages/tokens/README.md): where the skill's tables and a token disagree, the token wins (press feedback is `duration-quick`, not the recipe's 120ms). Spring configs come from the skill.
- Widgets and Live Activities: `expo-widgets` with Expo UI first ([decision 0025](docs/decisions/0025-mobile-app-stack.md)). Hand-written Swift targets and native modules follow `.agents/skills/write-swift/SKILL.md`. Its note that Swift 6.4 has not shipped is out of date (6.4.3 is released): its ⚠ rows are usable when the project's toolchain is Swift 6.4 or later.
- Interaction polish and design review of components we draw: `.agents/skills/emil-design-eng/SKILL.md`, `.agents/skills/apple-design/SKILL.md`. Review motion code with `.agents/skills/review-animations/SKILL.md`.
- Marketing site: [apps/site](apps/site/README.md) and [decision 0026](docs/decisions/0026-marketing-site-stack.md).
- Design tokens, component contracts, and accessibility rules: [design direction](docs/product/design-direction.md), [component contracts](docs/product/components.md), and [@repo/tokens](packages/tokens/README.md).
- Adding, changing, or removing a workspace or primitive, or adding or superseding a decision: update [the primitives catalog](docs/primitives/README.md) and [verification targets](docs/verification/README.md) in the same change. Add real control CLI proof and generated route maps with the first application that needs them.

## Learning more about Effect

This repository uses the Effect TypeScript library.

Before you write Effect code, read all of `node_modules/effect/AGENTS.md`. Follow its links when required.

If the guide does not cover an Effect API or concept, search the source code in `node_modules/effect/src`.
