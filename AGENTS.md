# Agent task map

- Setup, verification, PRs, and issue triage: [CONTRIBUTING.md](CONTRIBUTING.md). Run `pnpm verify` before handoff; CI and local Git hooks use the same command.
- Toolchain changes: [workspace tooling decision](docs/decisions/0001-workspace-tooling.md) and `.agents/skills/turborepo/SKILL.md`.
- External actions or approval questions: [agent authority decision](docs/decisions/0002-agent-authority.md).
- JavaScript, TypeScript, lint, and format changes: `.agents/skills/ultracite/SKILL.md`.
- Future shadcn UI work: `.agents/skills/shadcn/SKILL.md`.
- Adding, changing, or removing a workspace or primitive, or adding or superseding a decision: update [the primitives catalog](docs/primitives/README.md) and [verification targets](docs/verification/README.md) in the same change. Add real control CLI proof and generated route maps with the first application that needs them.
