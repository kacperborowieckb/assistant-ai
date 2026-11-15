# Live skeleton: deploy steps and free-plan measurements

Date: 2026-11-15

Ticket: #17. Open decision: #28.

## What ran

The Instance ran on a real Cloudflare account with a real Telegram bot. Seven real text messages each got one model reply through AI Gateway with Unified Billing. This record has no tokens, account ids, URLs, or message content.

## Deploy steps that worked

1. Create the gateway `assistant` in the dashboard, turn on Authenticated Gateway, and create a gateway token. The `wrangler` OAuth login has no AI Gateway scope, so this step is manual.
2. Add credits for Unified Billing in the dashboard.
3. Put the four required secrets in a private file (`NAME=value` lines). Make a random value for `TELEGRAM_WEBHOOK_SECRET` and for `OPERATOR_TOKEN`.
4. In `apps/agent`, run `wrangler deploy --secrets-file <file> --var AI_GATEWAY_URL:https://gateway.ai.cloudflare.com/v1/<account id>/assistant/compat`. The first deploy creates the D1 database. A new Worker cannot receive secrets before its first deploy, so the file is required.
5. Run `wrangler d1 migrations apply assistant-directory --remote`.
6. Add the Owner: `pnpm control owner add --telegram-user <id> --url <Worker URL>` with `OPERATOR_TOKEN` in the environment.
7. Call the Telegram `setWebhook` method with the path `/telegram/webhook`, the webhook secret as `secret_token`, and `allowed_updates` set to `["message"]`.

## Measurements

CPU time comes from `wrangler tail`, in whole milliseconds, and applies to the free plan.

| Measure | Result | Free-plan limit | Fits |
| --- | --- | --- | --- |
| Worker bundle size | 4230 KiB (gzip 805 KiB) | 64 MiB | Yes |
| Worker startup time | 64 ms | 1000 ms | Yes |
| Edge request CPU, 7 messages | 10, 6, 21 (cold), 3, 8, 4, 4 ms | 10 ms per request | One request over, see #28 |
| Durable Object `receive` CPU | 7 to 63 ms | 30 s | Yes |
| Turn CPU | 12 to 62 ms | 30 s | Yes |
| Turn wall time | 1.4 to 6.2 s | not limited | Yes |

Cold requests used the most CPU. Warm Edge requests used 3 to 8 ms.
