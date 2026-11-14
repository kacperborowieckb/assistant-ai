import { Effect, Option } from "effect";

import { textMessageFrom } from "../channels/telegram/update.ts";
import { telegramIdentity } from "../directory/channel-identity.ts";
import { Directory } from "../directory/directory.ts";
import { personalAgentFor } from "../personal-agent/personal-agent.ts";
import { matchesSecret } from "./secret.ts";

const telegramSecretHeader = "X-Telegram-Bot-Api-Secret-Token";

const accepted = () => new Response(null, { status: 200 });

const readJson = (request: Request) =>
  Effect.tryPromise(() => request.json<unknown>()).pipe(Effect.option);

export const handleTelegramUpdate = (request: Request, env: Env) =>
  Effect.gen(function* handleTelegramUpdateEffect() {
    if (
      !matchesSecret(
        request.headers.get(telegramSecretHeader),
        env.TELEGRAM_WEBHOOK_SECRET
      )
    ) {
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
    if (Option.isNone(owner) || owner.value.status !== "active") {
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
