import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import type { OwnerId } from "../owner-id.ts";
import type { ChannelIdentity } from "./channel-identity.ts";

export const owners = sqliteTable(
  "owners",
  {
    ownerId: text("owner_id").$type<OwnerId>().primaryKey().notNull(),
    status: text("status", { enum: ["active", "suspended"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check(
      "owners_status_check",
      sql`${table.status} IN ('active', 'suspended')`
    ),
  ]
);

export const channelIdentities = sqliteTable(
  "channel_identities",
  {
    channelIdentity: text("channel_identity")
      .$type<ChannelIdentity>()
      .primaryKey()
      .notNull(),
    ownerId: text("owner_id")
      .$type<OwnerId>()
      .notNull()
      .references(() => owners.ownerId),
  },
  (table) => [index("channel_identities_owner").on(table.ownerId)]
);

export const registration = sqliteTable(
  "registration",
  {
    singleton: integer("singleton").primaryKey().notNull(),
    state: text("state", { enum: ["open", "closed"] }).notNull(),
  },
  (table) => [
    check("registration_singleton_check", sql`${table.singleton} = 1`),
    check(
      "registration_state_check",
      sql`${table.state} IN ('open', 'closed')`
    ),
  ]
);
