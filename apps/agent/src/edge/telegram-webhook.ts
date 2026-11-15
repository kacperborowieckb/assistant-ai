import { Clock, Effect, Option } from "effect";

import { textMessageFrom } from "../channels/telegram/update.ts";
import { telegramIdentity } from "../directory/channel-identity.ts";
import { Directory } from "../directory/directory.ts";
import type { OwnerId } from "../owner-id.ts";
import { personalAgentFor } from "../personal-agent/personal-agent.ts";
import { OperatorMetrics } from "../tracing/operator-metrics.ts";
import type { OperatorMetric } from "../tracing/operator-metrics.ts";
import { matchesSecret } from "./secret.ts";

const telegramSecretHeader = "X-Telegram-Bot-Api-Secret-Token";

const accepted = () => new Response(null, { status: 200 });

const readJson = (request: Request) =>
  Effect.tryPromise(() => request.json<unknown>()).pipe(Effect.option);

const recordRefusal = (
  result: Extract<OperatorMetric, { kind: "refused" }>["result"],
  ownerId: OwnerId | undefined,
  startedAt: number
) =>
  Effect.gen(function* recordRefusalEffect() {
    const metrics = yield* OperatorMetrics;
    const now = yield* Clock.currentTimeMillis;
    yield* metrics.record({
      kind: "refused",
      ownerId,
      result,
      latencyMillis: now - startedAt,
    });
  });

export const handleTelegramUpdate = (request: Request, env: Env) =>
  Effect.gen(function* handleTelegramUpdateEffect() {
    const startedAt = yield* Clock.currentTimeMillis;
    if (
      !matchesSecret(
        request.headers.get(telegramSecretHeader),
        env.TELEGRAM_WEBHOOK_SECRET
      )
    ) {
      yield* recordRefusal("bad_secret_token", undefined, startedAt);
      return new Response(null, { status: 401 });
    }
    const body = yield* readJson(request);
    const textMessage = body.pipe(Option.flatMap(textMessageFrom));
    if (Option.isNone(textMessage)) {
      return accepted();
    }
    const directory = yield* Directory;
    const owner = yield* directory.findOwner(
      telegramIdentity(textMessage.value.senderId)
    );
    if (Option.isNone(owner)) {
      yield* recordRefusal("unknown_sender", undefined, startedAt);
      return accepted();
    }
    if (owner.value.status !== "active") {
      yield* recordRefusal("owner_not_active", owner.value.ownerId, startedAt);
      return accepted();
    }
    const personalAgent = yield* Effect.tryPromise(() =>
      personalAgentFor(env.PERSONAL_AGENT, owner.value.ownerId)
    );
    yield* Effect.tryPromise(() =>
      personalAgent.receive(textMessage.value.message)
    );
    return accepted();
  });
