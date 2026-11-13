# 0004: Owners and Channels

Status: accepted

Date: 2026-11-13

## Decision

### Multi-owner by design, single-owner by configuration

Every domain operation runs for exactly one Owner. The Edge resolves the Owner Id once, through the Directory, and passes it in. No code reads a global "current Owner".

- Each Owner has one Personal Agent Durable Object, `idFromName(ownerId)`, which holds all of that Owner's data.
- Other storage is keyed by Owner Id: the R2 prefix `owners/{ownerId}/`, one Vectorize namespace for each Owner, and the Owner Id in every Workflow and Queue payload. Traces and Usage are tagged with the Owner Id.
- The Directory maps Channel Identities to Owner Ids and records Owner status and Registration state.
- Model Credentials are resolved for each Owner.
- Usage is metered for each Owner from the first version.
- Forget-me for an Owner removes that Owner's Personal Agent storage, R2 prefix, and Directory entry.

A self-host Instance has one Owner, added by setup, and closed Registration. The hosted product adds `apps/platform` for accounts, billing, and open Registration, and uses the same agent code.

The MVP does not build sign-up, billing, hosted onboarding, or a Telegram bot shared by many Owners.

### Channels

Telegram is the only Channel in the MVP. The target Channel is a native mobile app with chat as the main screen and settings. The Owner chooses Telegram or the mobile app. Both are Channel adapters around one send action.

There is no web app for Owners. A web site exists only for marketing.

## Why

The product starts as self-hosted and may become a paid hosted product for non-technical Owners. Adding Owners after the code exists would change every query, job, and path. A separate store for each Owner makes isolation structural, so one wrong query cannot leak another Owner's private memory. Export and deletion for one Owner stay simple. On Cloudflare this costs little, because each Durable Object already has its own database.

Rejected: one shared database with an Owner column on each row, because isolation depends on each query. Rejected: a single-owner design without the seam, because a hosted product would need a rewrite of the core. Rejected for now: one Cloudflare deploy for each customer, because it costs more to run and Durable Objects already isolate data.

Telegram gives daily use on a phone with no app to build. The mobile app gives the best experience for non-technical Owners later. A web app would add a third client without a clear need.

## Revisit if

- The hosted product needs data shared between Owners, Directory load needs a different store, or a customer requires isolation of code and not only of data.
- Owners need a desktop client, or a Channel must be added to reach the hosted market.
