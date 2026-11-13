# 0003: Runtime and model stack

Status: accepted

Partly superseded: [0005](0005-model-transport-and-billing.md) replaces the Model Credentials paragraph.

Date: 2026-11-13

## Decision

### Runtime

Run the agent on Cloudflare Workers with the Agents SDK. Each Owner has one `PersonalAgent` Durable Object with its own SQLite storage. Use Durable Object alarms for Schedules. Add Workflows, R2, Vectorize, and Queues when a feature needs them.

Self-hosting is a "Deploy to Cloudflare" button or `git clone`, one setup command (`packages/create-assistant`), and `wrangler deploy`. The setup command creates resources, writes the Wrangler config, and asks for secrets.

Containers and the Sandbox SDK are out of scope. No design may depend on a full computer per task.

Pin the Agents SDK version and keep it behind our own interfaces.

### Model loop and services

Use the Vercel AI SDK for the model loop, tool calls, and streaming. Do not use `@effect/ai` or any second model layer.

Use Effect for services, config, typed errors, retries, timeouts, Channel adapters, tool implementations, and schemas. Run each AI SDK tool `execute` through one shared Effect runtime. Build the runtime once for each Durable Object, not for each request.

Measure bundle size and CPU time on the free plan in the first week of implementation.

### Model Gateway

All model providers sit behind one Model Gateway. The Gateway selects the model for each task type, with a main model and a cheaper second model, and resolves the Model Credentials for the Owner.

A self-host Instance uses the Operator's own provider key, stored as a Worker secret. The hosted product uses a platform key and bills the Owner's Usage. The provider can change without changes to the agent core.

## Why

The [feasibility study](../research/2026-11-12-cloudflare-feasibility.md) shows that every core feature has a Cloudflare primitive and that the free plan covers the infrastructure for one Owner. A Durable Object sleeps when idle and wakes on any Event, which fits an always-on, proactive agent at low cost. The same runtime serves many Owners for a hosted product.

The Agents SDK chat agent is built on the AI SDK, so the AI SDK is the natural model layer. Effect gives typed errors, dependency injection, and resource safety for the rest. Two model layers would duplicate the same concern and split the code.

The only real running cost is the model. Bring-your-own-key keeps self-hosting free of platform costs. A provider-neutral interface keeps the product independent of one vendor and allows cheaper models for background work.

## Revisit if

- Effect or the agent loop exceeds the free plan CPU or bundle limits in measurement.
- The Agents SDK blocks a required feature or moves to a different model layer, or `@effect/ai` covers a need that the AI SDK cannot.
- A required capability needs a runtime that Cloudflare cannot provide.
- One provider's features become necessary enough that the neutral interface costs more than it gives, or the hosted product needs a different billing model.
