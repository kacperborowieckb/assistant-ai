import { Effect, Schedule, Schema } from "effect";

import {
  AgentObservationSchema,
  evalRoutes,
  JudgeResultSchema,
  SeedResponseSchema,
} from "../../eval/eval-contract.ts";
import type { JudgeRequest, SeedRequest } from "../../eval/eval-contract.ts";
import { EvalWorkerFailed } from "./eval-worker-failed.ts";
import { TurnUnfinished } from "./turn-unfinished.ts";

const observationInterval = "250 millis";

interface JsonPost {
  readonly workerUrl: URL;
  readonly token: string;
  readonly route: string;
  readonly body: unknown;
}

const postJson = ({ workerUrl, token, route, body }: JsonPost) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(new URL(route, workerUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    },
    catch: (cause) => new EvalWorkerFailed({ route, detail: String(cause) }),
  });

const decodedAnswer =
  <Answer>(route: string, schema: Schema.Codec<Answer, unknown>) =>
  ({ status, text }: { readonly status: number; readonly text: string }) =>
    status === 200
      ? Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
          Effect.mapError(
            ({ message }) => new EvalWorkerFailed({ route, detail: message })
          )
        )
      : Effect.fail(
          new EvalWorkerFailed({ route, detail: `${status} ${text}` })
        );

export const evalWorkerClient = ({
  workerUrl,
  operatorToken,
  turnTimeoutMillis,
}: {
  readonly workerUrl: URL;
  readonly operatorToken: string;
  readonly turnTimeoutMillis: number;
}) => {
  const post = <Answer>(
    route: string,
    body: unknown,
    schema: Schema.Codec<Answer, unknown>
  ) =>
    postJson({ workerUrl, token: operatorToken, route, body }).pipe(
      Effect.flatMap(decodedAnswer(route, schema))
    );

  const observe = (ownerId: string) =>
    post(evalRoutes.observation, { ownerId }, AgentObservationSchema);

  const timedOut = (ownerId: string, ownerText: string) =>
    observe(ownerId).pipe(
      Effect.flatMap(({ usage }) =>
        Effect.fail(
          new TurnUnfinished({
            ownerText,
            timeoutMillis: turnTimeoutMillis,
            usage,
          })
        )
      )
    );

  const settled = (ownerId: string, ownerText: string) =>
    observe(ownerId).pipe(
      Effect.repeat({
        schedule: Schedule.spaced(observationInterval),
        until: (observation) => observation.pendingEventCount === 0,
      }),
      Effect.timeoutOrElse({
        duration: turnTimeoutMillis,
        orElse: () => timedOut(ownerId, ownerText),
      })
    );

  return {
    seed: (request: SeedRequest) =>
      post(evalRoutes.seed, request, SeedResponseSchema),
    observe,
    settled,
    judge: (request: JudgeRequest) =>
      post(evalRoutes.judge, request, JudgeResultSchema),
  };
};
