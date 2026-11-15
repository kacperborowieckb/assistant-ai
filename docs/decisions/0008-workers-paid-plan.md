# 0008: Workers Paid plan

Status: accepted

Date: 2026-11-15

Closes #28. Partly supersedes [0003](0003-runtime-and-model-stack.md): its claim that the free plan covers the infrastructure for one Owner.

## Decision

The supported Cloudflare plan for an Instance is Workers Paid ($5 per month for the account). This applies to self-host Instances and to the hosted product.

- The MVP can run on the Workers Free plan, without a guarantee. The docs say which features need Workers Paid.
- No design may change only to fit a Workers Free limit. Do not split a Turn, move a Helper out of Workflows, or split the Edge into its own Worker only to stay on the free plan.
- The Edge stays thin because a thin Edge gives a fast Acknowledge and holds no Owner data, not because of the 10 ms free-plan limit. The Edge CPU per request is not a release gate.

## Why

The live skeleton measured the Edge request at 3 to 8 ms warm and 21 ms on the first request after idle, against the 10 ms free-plan limit ([measurements](../research/2026-11-15-live-skeleton-measurements.md)). The cold request costs more because the Edge is in the same bundle as the Personal Agent, so more code compiles on the first request. Cloudflare allows "some built-in flexibility" for occasional overruns but gives no number, and stops a Worker that goes over the limit consistently. Each new Channel adds Edge work, for example a MIME message or a webhook signature, so the limit leaves no margin.

The Edge is not the main limit. These Workers Free limits block the direction in the [vision](../product/vision.md) (Cloudflare limits pages, read on 2026-11-15):

| Limit | Free | Paid | What it blocks |
| --- | --- | --- | --- |
| Subrequests per invocation | 50 | 10,000 | Each model step, MCP call, and Channel send is one subrequest. A Turn with 15 to 20 tool steps can use all 50. |
| Workflows CPU per step | 10 ms | 30 s, up to 5 min | Helpers. A Turn with one model call used 12 to 62 ms CPU. |
| Workflows steps | 3,000 per day | 500,000 per month included | Background work for each Owner. |
| Durable Object duration | 13,000 GB-s per day | 400,000 GB-s per month included | About 29 hours of awake time per day at the billed 128 MB. One MCP connection that keeps a Personal Agent awake can use most of it. |
| Edge CPU per request | 10 ms | 30 s default, up to 5 min | Edge work for each new Channel. |

Each Free limit has a workaround: a Turn split across alarms for new subrequest budgets, Helpers as Durable Objects, and a second small Edge Worker. Each one adds design complexity and deploy steps only to save $5 per month. The MVP limits scope, not quality (vision principle 9), so we take the long-term design. The Operator already pays for model credits, and the hosted product runs on Workers Paid in any case.

Rejected: accept the risk on the free plan (option 1 in #28), because the subrequest and Workflows limits block the next features. Rejected: move Edge work into the Durable Object and measure again (option 2), because it changes the design for a limit that the long-term product does not have.

## Revisit if

- Cloudflare raises the Workers Free limits for subrequests or Workflows CPU.
- The $5 per month plan stops self-hosters from trying the agent, and a measured free-plan profile can serve them without design changes.
- Cloudflare changes the Workers Paid price or the included amounts so that one Owner costs more than the minimum plan.
