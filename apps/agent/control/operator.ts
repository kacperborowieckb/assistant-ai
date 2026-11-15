import { Data, Effect, Option, Schema } from "effect";

import { AddOwnerResponseSchema } from "../src/edge/operator-contract.ts";
import type { AddOwnerResponse } from "../src/edge/operator-contract.ts";
import { localValue } from "./local-values.ts";
import { OperatorTokenMissing } from "./operator-token-missing.ts";

export const localWorkerUrl = "http://localhost:8787";

export class OwnerNotAdded extends Data.TaggedError("OwnerNotAdded")<{
  readonly status: number;
  readonly detail: string;
}> {
  override get message() {
    return `The Worker did not add the Owner (${this.status}): ${this.detail}`;
  }
}

export const operatorToken = Effect.suspend(() => {
  const token = localValue("OPERATOR_TOKEN");
  return Option.isSome(token)
    ? Effect.succeed(token.value)
    : Effect.fail(
        new OperatorTokenMissing({
          message:
            "Set OPERATOR_TOKEN in the environment, or in .dev.vars for a local Worker.",
        })
      );
});

export const addOwner = Effect.fnUntraced(function* addOwner({
  workerUrl,
  token,
  telegramUserId,
}: {
  readonly workerUrl: string;
  readonly token: string;
  readonly telegramUserId: number;
}) {
  const response = yield* Effect.promise(() =>
    fetch(new URL("/operator/owners", workerUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ telegramUserId }),
    })
  );
  const body = yield* Effect.promise(() => response.text());
  if (response.status !== 201) {
    return yield* new OwnerNotAdded({ status: response.status, detail: body });
  }
  return Schema.decodeUnknownSync(
    Schema.fromJsonString(AddOwnerResponseSchema)
  )(body);
});

export const renderAddedOwner = (owner: AddOwnerResponse) =>
  [
    `Added Owner ${owner.ownerId} for ${owner.channelIdentity} through the Directory.`,
    `Registration: ${owner.registration}`,
  ].join("\n");
