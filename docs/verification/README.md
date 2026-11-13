# Self-verification

[targets.json](targets.json) maps each workspace to its verification guide. Each entry has `workspace`, the repository-relative workspace directory, and `guide`, the path of an existing Markdown guide. Keep the list empty until workspaces exist.

When an agent adds a workspace, the same change must add its target entry, guide, and `package.json` `verify` script. The root `pnpm verify` checks that these exist and runs workspace verification scripts in dependency order. Workspace scripts must run their own checks, not call the root verification command.

## Libraries and tooling

The guide states what behavior is checked, required local fixtures, and the commands that prove it. TypeScript workspaces include type checks. Libraries test behavior through their public interface. Add dead-code checks when the implementation gives them a useful target. A check must fail when its expected behavior is broken.

## First runnable application

The agent that adds the first runnable application also adds a project control CLI and, when needed, a focused control skill. Implement commands that have real targets: `doctor` for configuration, `dev` for the local runtime, `request --contains` or `execute` for behavior, and `health --sha` when a deployed version exists. Add `login` and `browse --record` when authentication or UI behavior requires them. Never claim a command is implemented before it exercises that behavior.

Use isolated local data and mocked external services by default. Local verification must not send messages, spend money, or change production data. Document any optional live check, required secret names, and approval requirements separately.

For applications with routes, generate a Feature Map from the framework's route list. Add seed and navigation instructions. Include a `map --check` command in the workspace verification script so new or removed routes require a matching map update. Select the framework-specific generator when the framework exists.

## Each change

The implementing agent updates affected catalog entries, decision links, verification guides, and generated maps with the code. It runs `pnpm verify` plus the relevant control CLI proof, and reports commands, results, and checks omitted in the PR. A generic successful health check does not prove a changed feature.

The owner decides product behavior, authorizes protected actions, and reviews the evidence. Routine catalog and guide updates belong to the agent. No background agent maintains them automatically in this local-foundation setup.

The structural check proves that required records exist and link to current files. It cannot prove that a guide is accurate or that a workspace's verification script covers its behavior. Those remain implementation and review duties.

## Required check

`main` requires a pull request and a passing `Verify` check. Run local verification and include its evidence in the PR. If GitHub Actions minutes run out, merges block until the owner restores them. Do not bypass or remove the rule to merge.
