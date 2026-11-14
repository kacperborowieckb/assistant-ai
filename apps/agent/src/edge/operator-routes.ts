import { Effect, Schema } from "effect";

import { telegramIdentity } from "../directory/channel-identity.ts";
import { Directory } from "../directory/directory.ts";
import { bearerToken, matchesSecret } from "./secret.ts";

export const AddOwnerRequestSchema = Schema.Struct({
  telegramUserId: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
});

export const AddOwnerResponseSchema = Schema.Struct({
  ownerId: Schema.String,
  channelIdentity: Schema.String,
  registration: Schema.Literals(["open", "closed"]),
});

const json = (status: number, body: unknown) => Response.json(body, { status });

export const handleAddOwner = (request: Request, env: Env) =>
  Effect.gen(function* handleAddOwnerEffect() {
    if (!matchesSecret(bearerToken(request), env.OPERATOR_TOKEN)) {
      return new Response(null, { status: 401 });
    }
    const body = yield* Effect.tryPromise(() => request.json<unknown>()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(AddOwnerRequestSchema)),
      Effect.option
    );
    if (body._tag === "None") {
      return json(400, {
        error: "Send a JSON body with a positive integer telegramUserId.",
      });
    }
    const directory = yield* Directory;
    const channelIdentity = telegramIdentity(body.value.telegramUserId);
    return yield* directory.addOwner(channelIdentity).pipe(
      Effect.flatMap((ownerId) =>
        directory.registrationState.pipe(
          Effect.map((registration) =>
            json(201, { ownerId, channelIdentity, registration })
          )
        )
      ),
      Effect.catchTag("ChannelIdentityTaken", () =>
        Effect.succeed(
          json(409, {
            error: `${channelIdentity} already belongs to an Owner.`,
          })
        )
      )
    );
  });
