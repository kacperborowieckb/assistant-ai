import { Data, Effect, Option, Schema } from "effect";
import { unstable_getVarsForDev } from "wrangler";

import { OperatorTokenMissing } from "./operator-token-missing.ts";
import { wranglerConfigPath } from "./workspace.ts";

export const localWorkerUrl = "http://localhost:8787";

const AddOwnerResponseSchema = Schema.Struct({
  ownerId: Schema.String,
  channelIdentity: Schema.String,
  registration: Schema.Literals(["open", "closed"]),
});

export type AddedOwner = typeof AddOwnerResponseSchema.Type;

export class OwnerNotAdded extends Data.TaggedError("OwnerNotAdded")<{
  readonly status: number;
  readonly detail: string;
}> {
  override get message() {
    return `The Worker did not add the Owner (${this.status}): ${this.detail}`;
  }
}

const isNonEmpty = (value: string) => value.length > 0;

const DevVarSchema = Schema.Struct({ value: Schema.String });

const operatorTokenFromDevVars = () =>
  Schema.decodeUnknownOption(DevVarSchema)(
    unstable_getVarsForDev(wranglerConfigPath, undefined, {}, undefined, true, {
      required: ["OPERATOR_TOKEN"],
    }).OPERATOR_TOKEN
  ).pipe(Option.map((devVar) => devVar.value));

export const operatorToken = Effect.suspend(() => {
  const token = Option.fromNullishOr(process.env.OPERATOR_TOKEN).pipe(
    Option.filter(isNonEmpty),
    Option.orElse(operatorTokenFromDevVars),
    Option.filter(isNonEmpty)
  );
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

export const renderAddedOwner = (owner: AddedOwner) =>
  [
    `Added Owner ${owner.ownerId} for ${owner.channelIdentity} through the Directory.`,
    `Registration: ${owner.registration}`,
  ].join("\n");
