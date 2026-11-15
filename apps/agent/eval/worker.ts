import { Effect, Schema } from "effect";

import { edge } from "../src/edge/edge.ts";
import { bearerToken, matchesSecret } from "../src/edge/secret.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import {
  evalRoutes,
  JudgeRequestSchema,
  ObservationRequestSchema,
  SeedRequestSchema,
} from "./eval-contract.ts";
import { judgeExchanges } from "./eval-judge.ts";
import { evalPersonalAgentFor } from "./eval-personal-agent.ts";

export { EvalPersonalAgent as PersonalAgent } from "./eval-personal-agent.ts";

const readBody = <Body>(
  request: Request,
  schema: Schema.Codec<Body, unknown>
) =>
  Effect.tryPromise(() => request.json<unknown>()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema))
  );

const evalHandlers: Record<
  string,
  (request: Request, env: Env) => Effect.Effect<unknown, unknown>
> = {
  [evalRoutes.seed]: (request, env) =>
    readBody(request, SeedRequestSchema).pipe(
      Effect.flatMap((seed) =>
        Effect.promise(async () => {
          const agent = await evalPersonalAgentFor(
            env,
            OwnerIdSchema.make(seed.ownerId)
          );
          return agent.seed(seed);
        })
      )
    ),
  [evalRoutes.observation]: (request, env) =>
    readBody(request, ObservationRequestSchema).pipe(
      Effect.flatMap(({ ownerId }) =>
        Effect.promise(async () => {
          const agent = await evalPersonalAgentFor(
            env,
            OwnerIdSchema.make(ownerId)
          );
          return agent.observe();
        })
      )
    ),
  [evalRoutes.judge]: (request, env) =>
    readBody(request, JudgeRequestSchema).pipe(
      Effect.flatMap((judgeRequest) =>
        judgeExchanges(
          env,
          OwnerIdSchema.make(judgeRequest.ownerId),
          judgeRequest
        )
      )
    ),
};

const handleEvalRequest = (request: Request, env: Env) => {
  const handler = evalHandlers[new URL(request.url).pathname];
  if (request.method !== "POST" || handler === undefined) {
    return;
  }
  if (!matchesSecret(bearerToken(request), env.OPERATOR_TOKEN)) {
    return Promise.resolve(new Response(null, { status: 401 }));
  }
  return Effect.runPromise(
    handler(request, env).pipe(
      Effect.map((body) => Response.json(body)),
      Effect.catchCause((cause) =>
        Effect.succeed(Response.json({ error: String(cause) }, { status: 500 }))
      )
    )
  );
};

export default {
  fetch: (request, env, context) =>
    handleEvalRequest(request, env) ?? edge.fetch(request, env, context),
} satisfies ExportedHandler<Env>;
