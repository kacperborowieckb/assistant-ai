import { Context, Effect, Layer, Option, Schema } from "effect";

import { OwnerIdSchema } from "../owner-id.ts";
import type { OwnerId } from "../owner-id.ts";
import { ChannelIdentityTaken } from "./channel-identity-taken.ts";
import type { ChannelIdentity } from "./channel-identity.ts";
import { DirectoryUnavailable } from "./directory-unavailable.ts";

export const OwnerStatusSchema = Schema.Literals(["active", "suspended"]);

export type OwnerStatus = typeof OwnerStatusSchema.Type;

export const RegistrationStateSchema = Schema.Literals(["open", "closed"]);

export type RegistrationState = typeof RegistrationStateSchema.Type;

export interface DirectoryOwner {
  readonly ownerId: OwnerId;
  readonly status: OwnerStatus;
}

const OwnerRowSchema = Schema.Struct({
  owner_id: OwnerIdSchema,
  status: OwnerStatusSchema,
});

const RegistrationRowSchema = Schema.Struct({
  state: RegistrationStateSchema,
});

const query = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new DirectoryUnavailable({ cause }),
  });

const decodeRow = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  row: unknown
) =>
  Schema.decodeUnknownEffect(schema)(row).pipe(
    Effect.mapError((cause) => new DirectoryUnavailable({ cause }))
  );

const isTakenIdentity = (cause: unknown) =>
  cause instanceof Error &&
  cause.message.includes(
    "UNIQUE constraint failed: channel_identities.channel_identity"
  );

const ownerRow = (
  session: D1DatabaseSession,
  channelIdentity: ChannelIdentity
) =>
  query(() =>
    session
      .prepare(
        `SELECT owners.owner_id, owners.status
         FROM channel_identities
         JOIN owners ON owners.owner_id = channel_identities.owner_id
         WHERE channel_identities.channel_identity = ?`
      )
      .bind(channelIdentity)
      .first()
  );

const makeDirectory = (database: D1Database) => {
  const findOwner = (channelIdentity: ChannelIdentity) =>
    Effect.gen(function* findOwnerEffect() {
      const replicaRow = yield* ownerRow(
        database.withSession("first-unconstrained"),
        channelIdentity
      );
      const row =
        replicaRow ??
        (yield* ownerRow(
          database.withSession("first-primary"),
          channelIdentity
        ));
      if (row === null) {
        return Option.none<DirectoryOwner>();
      }
      const owner = yield* decodeRow(OwnerRowSchema, row);
      return Option.some<DirectoryOwner>({
        ownerId: owner.owner_id,
        status: owner.status,
      });
    });

  const addOwner = (channelIdentity: ChannelIdentity) =>
    Effect.gen(function* addOwnerEffect() {
      const ownerId = OwnerIdSchema.make(crypto.randomUUID());
      yield* Effect.tryPromise({
        try: () =>
          database.batch([
            database
              .prepare(
                "INSERT INTO owners (owner_id, status, created_at) VALUES (?, 'active', ?)"
              )
              .bind(ownerId, new Date().toISOString()),
            database
              .prepare(
                "INSERT INTO channel_identities (channel_identity, owner_id) VALUES (?, ?)"
              )
              .bind(channelIdentity, ownerId),
          ]),
        catch: (cause) =>
          isTakenIdentity(cause)
            ? new ChannelIdentityTaken({ channelIdentity })
            : new DirectoryUnavailable({ cause }),
      });
      return ownerId;
    });

  const registrationState = Effect.gen(function* registrationStateEffect() {
    const row = yield* query(() =>
      database
        .prepare("SELECT state FROM registration WHERE singleton = 1")
        .first()
    );
    const registration = yield* decodeRow(RegistrationRowSchema, row);
    return registration.state;
  });

  return { findOwner, addOwner, registrationState };
};

export class Directory extends Context.Service<
  Directory,
  ReturnType<typeof makeDirectory>
>()("Directory") {
  static readonly layer = (database: D1Database) =>
    Layer.succeed(Directory, makeDirectory(database));
}
