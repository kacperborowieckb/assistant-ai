import { Effect } from "effect";

import { Directory } from "../directory/directory.ts";
import { OperatorMetrics } from "../tracing/operator-metrics.ts";
import { handleAddOwner } from "./operator-routes.ts";
import type { EdgeRouteKey } from "./routes.ts";
import { handleTelegramUpdate } from "./telegram-webhook.ts";

const handlers: Record<
  EdgeRouteKey,
  (
    request: Request,
    env: Env
  ) => Effect.Effect<Response, unknown, Directory | OperatorMetrics>
> = {
  "POST /telegram/webhook": handleTelegramUpdate,
  "POST /operator/owners": handleAddOwner,
};

const isRouteKey = (key: string): key is EdgeRouteKey =>
  Object.hasOwn(handlers, key);

const handleRequest: ExportedHandlerFetchHandler<Env> = (request, env) => {
  const key = `${request.method} ${new URL(request.url).pathname}`;
  if (!isRouteKey(key)) {
    return new Response("Not Found", { status: 404 });
  }
  return Effect.runPromise(
    handlers[key](request, env).pipe(
      Effect.provide(Directory.layer(env.DIRECTORY)),
      Effect.provide(OperatorMetrics.layer(env.OPERATOR_METRICS)),
      Effect.catchCause((cause) =>
        Effect.as(
          Effect.logError("The Edge could not handle a request", cause),
          new Response(null, { status: 500 })
        )
      )
    )
  );
};

export const edge = {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
