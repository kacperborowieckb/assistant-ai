# 0005: Model transport and billing

Status: accepted

Date: 2026-11-13

Supersedes the Model Credentials paragraph of [0003](0003-runtime-and-model-stack.md) ("A self-host Instance uses the Operator's own provider key, stored as a Worker secret").

## Decision

### Transport

All model calls go through Cloudflare AI Gateway. The AI SDK provider is configured with an explicit gateway base URL. Do not rely on a default gateway of the AI SDK.

AI Gateway is the transport only. Our Model Gateway still owns these jobs:

- It selects the model for each task type.
- It resolves the Model Credentials for the Owner.
- It records Usage for each Owner in our own storage. AI Gateway logs and analytics are not the source of truth for Usage.

Each request sends the Owner Id as AI Gateway custom metadata, so gateway analytics and spend limits can be scoped to one Owner.

### Billing

- **Default: Unified Billing.** The Operator buys Cloudflare credits. No provider account or provider key is necessary. Setup creates the gateway and its token after one Cloudflare login.
- **Option: BYOK.** The Operator stores their own provider key in AI Gateway. Setup offers this as an alternative.
- **Hosted product:** the platform uses Unified Billing with its own credits and bills each Owner's Usage.

Model Credentials for an Owner are the AI Gateway token and the billing mode (Unified Billing or a BYOK key alias). Changing the billing mode changes only Model Credentials, not the model path.

## Why

Unified Billing gives the easiest setup for the Operator: one account, one bill, and no key to copy. It is the same path that the hosted product needs, so self-hosting stays the hosted product with one Owner (vision principle 7). Zero data retention is available only with Unified Billing. The cost is a 5% fee on credits; provider prices pass through.

BYOK stays an option because many Operators already have a provider key with credits. It is not the default because it adds an account and a secret to setup, and it is in beta.

OpenRouter as the main path was rejected: it adds an account and a third party in the data path, and its default routing allows data collection. AI Gateway can route to it later if its model catalog becomes necessary.

## Revisit if

- Unified Billing stops covering a model that the agent needs, needs a paid plan, or its fee changes the cost of self-hosting.
- AI Gateway adds latency or failures that a direct provider call would avoid.
- BYOK leaves beta and Operators prefer it, or the hosted product needs a different billing model.
