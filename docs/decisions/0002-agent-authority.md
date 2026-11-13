# 0002: Repository owner approval and local foundation scope

Status: accepted

Date: 2026-11-13

## Decision

The current scope is a local development foundation. The repository owner controls PR merges. Automatic merges, Kody, ship processes, scheduled coding agents, deployments, and releases are outside this setup.

Agents must get explicit repository owner approval for public publishing or releases, auth or permission changes, destructive data changes, spending, and external messages. An existing explicit instruction can authorize the named action; it does not authorize unrelated actions. Agents must never expose secrets or bypass checks.

## Why

The project has no application, release target, or operational evidence yet. The repository owner keeps control of external effects and changes that affect security, data, or money while agents perform authorized, reversible local work.

These rules govern development agents in this repository. They do not implement the future personal agent's action policy. That policy must be enforced in application code when the runtime exists.

## Revisit if

The repository owner authorizes a hosted ship process or automatic merges after real checks and review evidence exist, or approves a different boundary for a named operation.
