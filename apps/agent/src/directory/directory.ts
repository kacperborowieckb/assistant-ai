import { D1Client } from "@effect/sql-d1";
import { eq } from "drizzle-orm";
import { makeWithDefaults } from "drizzle-orm/effect-d1";
import { Context, Effect, Layer, Option, Schema } from "effect";

import { OwnerIdSchema } from "../owner-id.ts";
import type { OwnerId } from "../owner-id.ts";
import { ChannelIdentityTaken } from "./channel-identity-taken.ts";
import type { ChannelIdentity } from "./channel-identity.ts";
import {
  channelIdentities,
  ownerStatuses,
  owners,
  registration,
  registrationStates,
} from "./directory-schema.ts";
import { DirectoryUnavailable } from "./directory-unavailable.ts";

export const OwnerStatusSchema = Schema.Literals(ownerStatuses);

export type OwnerStatus = typeof OwnerStatusSchema.Type;

export const RegistrationStateSchema = Schema.Literals(registrationStates);

export type RegistrationState = typeof RegistrationStateSchema.Type;

export interface DirectoryOwner {
  readonly ownerId: OwnerId;
  readonly status: OwnerStatus;
}

const takenIdentityMessage =
  "UNIQUE constraint failed: channel_identities.channel_identity";

const isTakenIdentity = (cause: unknown): boolean =>
  cause instanceof Error &&
  (cause.message.includes(takenIdentityMessage) ||
    isTakenIdentity(cause.cause));

const unavailable = (cause: unknown) => new DirectoryUnavailable({ cause });

const sessionClient = (session: D1DatabaseSession) =>
  D1Client.layer({ db: session as unknown as D1Database });

const openDatabase = (session: D1DatabaseSession) =>
  makeWithDefaults({}).pipe(
    Effect.provide(sessionClient(session)),
    Effect.mapError(unavailable)
  );

const findOwnerIn = (
  session: D1DatabaseSession,
  channelIdentity: ChannelIdentity
) =>
  Effect.gen(function* findOwnerInEffect() {
    const database = yield* openDatabase(session);
    const rows = yield* database
      .select({ ownerId: owners.ownerId, status: owners.status })
      .from(channelIdentities)
      .innerJoin(owners, eq(owners.ownerId, channelIdentities.ownerId))
      .where(eq(channelIdentities.channelIdentity, channelIdentity))
      .pipe(Effect.mapError(unavailable));
    return rows.at(0);
  });

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
      const session = database.withSession("first-primary");
      const db = yield* openDatabase(session);
      const insertOwner = db.insert(owners).values({
        ownerId,
        status: "active",
        createdAt: new Date().toISOString(),
      });
      const insertIdentity = db
        .insert(channelIdentities)
        .values({ channelIdentity, ownerId });
      const client = db.$client;
      const statements = [insertOwner, insertIdentity].map((query) => {
        const { sql, params } = query.toSQL();
        return client.unsafe(sql, params);
      });
      yield* client
        .batch(statements)
        .pipe(
          Effect.mapError((cause) =>
            isTakenIdentity(cause)
              ? new ChannelIdentityTaken({ channelIdentity })
              : unavailable(cause)
          )
        );
      return ownerId;
    });

  const registrationState = Effect.gen(function* registrationStateEffect() {
    const db = yield* openDatabase(database.withSession("first-primary"));
    const rows = yield* db
      .select({ state: registration.state })
      .from(registration)
      .where(eq(registration.singleton, 1))
      .pipe(Effect.mapError(unavailable));
    const row = rows.at(0);
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
