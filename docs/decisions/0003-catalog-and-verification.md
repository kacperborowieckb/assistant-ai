# 0003: Keep catalog and verification updates with implementation

Status: accepted

Date: 2026-11-13

## Decision

Maintain a primitives catalog and a workspace verification registry. Require catalog coverage, current decision links, a verification guide, and a local verify script when a workspace is added. Run structural checks and workspace scripts from the root verification command and existing Git hooks.

The implementing agent updates the records in the same change as the code. Add real control commands with the first runnable application and a generated Feature Map when routes exist. Until then, empty registries are correct. No background maintenance agent is configured.

## Why

Future agents need a reliable map of implementation and a way to prove their work. Structural checks can catch missing records now without inventing product primitives or runtime proof. Code review still must check semantic accuracy and behavior coverage.

## Revisit if

The first runtime needs additional proof commands, a framework supplies a route generator, workspace layout changes beyond apps and packages, or repeated failures show that manual semantic review needs a stronger automated check.
