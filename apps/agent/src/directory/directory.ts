import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Context, Effect, Layer, Option, Schema } from "effect";

import { OwnerIdSchema } from "../owner-id.ts";
import type { OwnerId } from "../owner-id.ts";
import { ChannelIdentityTaken } from "./channel-identity-taken.ts";
import type { ChannelIdentity } from "./channel-identity.ts";
import { channelIdentities, owners, registration } from "./directory-schema.ts";
import { DirectoryUnavailable } from "./directory-unavailable.ts";

export const OwnerStatusSchema = Schema.Literals(["active", "suspended"]);

export type OwnerStatus = typeof OwnerStatusSchema.Type;

export const RegistrationStateSchema = Schema.Literals(["open", "closed"]);

export type RegistrationState = typeof RegistrationStateSchema.Type;

export interface DirectoryOwner {
  readonly ownerId: OwnerId;
  readonly status: OwnerStatus;
}

const query = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new DirectoryUnavailable({ cause }),
  });

const isTakenIdentity = (cause: unknown) =>
  cause instanceof Error &&
  cause.message.includes(
    "UNIQUE constraint failed: channel_identities.channel_identity"
  );

const sessionDatabase = (session: D1DatabaseSession) =>
  drizzle(session as unknown as D1Database);

const findOwnerIn = (
  session: D1DatabaseSession,
  channelIdentity: ChannelIdentity
) =>
  query(() =>
    sessionDatabase(session)
      .select({ ownerId: owners.ownerId, status: owners.status })
      .from(channelIdentities)
      .innerJoin(owners, eq(owners.ownerId, channelIdentities.ownerId))
      .where(eq(channelIdentities.channelIdentity, channelIdentity))
      .get()
  );

const makeDirectory = (database: D1Database) => {
  const findOwner = (channelIdentity: ChannelIdentity) =>
    Effect.gen(function* findOwnerEffect() {
      const replicaOwner = yield* findOwnerIn(
        database.withSession("first-unconstrained"),
        channelIdentity
      );
      const owner =
        replicaOwner ??
        (yield* findOwnerIn(
          database.withSession("first-primary"),
          channelIdentity
        ));
      return Option.fromNullishOr(owner);
    });

  const addOwner = (channelIdentity: ChannelIdentity) =>
    Effect.gen(function* addOwnerEffect() {
      const ownerId = OwnerIdSchema.make(crypto.randomUUID());
      const db = drizzle(database);
      yield* Effect.tryPromise({
        try: () =>
          db.batch([
            db.insert(owners).values({
              ownerId,
              status: "active",
              createdAt: new Date().toISOString(),
            }),
            db.insert(channelIdentities).values({ channelIdentity, ownerId }),
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
      drizzle(database)
        .select({ state: registration.state })
        .from(registration)
        .where(eq(registration.singleton, 1))
        .get()
    );
    if (row === undefined) {
      return yield* new DirectoryUnavailable({
        cause: "The registration row is missing",
      });
    }
    return row.state;
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
