import { Effect } from "effect";

import { Directory } from "../directory/directory.ts";
import { handleAddOwner } from "./operator-routes.ts";
import { handleTelegramUpdate } from "./telegram-webhook.ts";

const telegramWebhookPath = "/telegram/webhook";
const operatorOwnersPath = "/operator/owners";

const routes: Record<
  string,
  (request: Request, env: Env) => Effect.Effect<Response, unknown, Directory>
> = {
  [`POST ${telegramWebhookPath}`]: handleTelegramUpdate,
  [`POST ${operatorOwnersPath}`]: handleAddOwner,
};

const handleRequest: ExportedHandlerFetchHandler<Env> = (request, env) => {
  const route = routes[`${request.method} ${new URL(request.url).pathname}`];
  if (route === undefined) {
    return new Response("Not Found", { status: 404 });
  }
  return Effect.runPromise(
    route(request, env).pipe(
      Effect.provide(Directory.layer(env.DIRECTORY)),
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
