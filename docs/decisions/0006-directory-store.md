# 0006: Directory store

Status: accepted

Date: 2026-11-13

Closes the open MVP question "How the Directory is stored".

## Decision

Store the Directory in D1. It holds Channel Identities, Owner Ids, Owner status, and Registration state. It holds no other Owner data; that stays in each Personal Agent ([0004](0004-owners-and-channels.md)).

- The Edge reads the Directory on each Channel request through the D1 Sessions API, so reads can use read replicas near the Edge.
- Writes (Registration, status changes) go to the primary.
- `apps/platform` binds the same D1 database when the hosted product starts.
- Code uses the Directory interface only. No module outside `directory` runs SQL against it.
- Setup creates the D1 database and applies its migrations.

## Why

The MVP limits scope, not quality (vision principle 9), so the store must fit the hosted product. In the hosted product, every Channel request for every Owner reads the Directory. One Durable Object is one single-threaded instance in one location and becomes a global hot spot. D1 read replication gives fast reads at no extra cost.

The platform needs queries across Owners for accounts, status, and billing. That is relational work that D1 does well and one Durable Object does not. D1 also gives Time Travel restore.

Rejected: one dedicated Directory Durable Object. It needs no extra resource in setup, but it does not scale with many Owners and makes queries across Owners difficult.

## Revisit if

- Directory reads add measurable latency to Acknowledge, even with read replicas.
- D1 free-plan limits block a self-host Instance.
- The hosted product needs a Directory in more than one jurisdiction.
