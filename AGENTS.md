# Project instructions

- Write in ASD-STE100 Simplified Technical English. Use plain hyphens instead of em dashes.
- Start explanations and comparisons with a concise answer. Add a small example when useful.
- Read applicable CONTEXT.md files and use their ubiquitous language.
- Prefer quality, simplicity, robustness, scalability, and long-term maintainability when you make technical decisions. Give development cost little weight.
- Use names, types, and small functions to explain code. Write no code comments or docstrings, except directives that tools read. Keep existing comments unless a change makes them wrong. Put change reasons in commit messages or PR descriptions.
- Verify changes in proportion to their impact and risk. Report checks run, checks omitted, and failures that the change did not cause. Fix unrelated failures only if they block the task or the owner asks.
- Fetch third-party documentation and component examples directly.
- Use the harness question tool when the owner must make a decision or take action. Put the recommended option first.

## Task map

- Setup, verification, PRs, and issue triage: [CONTRIBUTING.md](CONTRIBUTING.md). Run `pnpm verify` before handoff; CI and local Git hooks use the same command.
- Toolchain changes: [workspace tooling decision](docs/decisions/0001-workspace-tooling.md) and `.agents/skills/turborepo/SKILL.md`.
- External actions or approval questions: [agent authority decision](docs/decisions/0002-agent-authority.md).
- JavaScript, TypeScript, lint, and format changes: `.agents/skills/ultracite/SKILL.md`.
- Future shadcn UI work: `.agents/skills/shadcn/SKILL.md`.
- Adding, changing, or removing a workspace or primitive, or adding or superseding a decision: update [the primitives catalog](docs/primitives/README.md) and [verification targets](docs/verification/README.md) in the same change. Add real control CLI proof and generated route maps with the first application that needs them.
