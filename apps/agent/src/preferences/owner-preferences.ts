import { eq } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";

import { Journal } from "../journal/journal.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { ownerPreferenceSources } from "../personal-agent/storage-values.ts";
import {
  noProactiveMutes,
  ProactiveMutesSchema,
  sameMutes,
  withMutes,
  withoutMutes,
} from "../proactive/proactive-mutes.ts";
import type {
  ProactiveMuteChange,
  ProactiveMutesChange,
} from "../proactive/proactive-mutes.ts";
import {
  QuietHoursSchema,
  quietHoursText,
  sameQuietHours,
} from "../time/quiet-hours.ts";
import type { QuietHours } from "../time/quiet-hours.ts";
import { namedTimeZone, TimeZoneNameSchema } from "../time/time-zone.ts";
import { InvalidTimeZone } from "./invalid-time-zone.ts";
import { ownerPreferences } from "./preferences-schema.ts";
import {
  makeProactiveMessageBudgetPreference,
  ProactiveMessageBudgetSchema,
} from "./proactive-message-budget.ts";

export const OwnerPreferenceSchemas = {
  time_zone: TimeZoneNameSchema,
  quiet_hours: QuietHoursSchema,
  muted_proactive_messages: ProactiveMutesSchema,
  proactive_message_budget: ProactiveMessageBudgetSchema,
} as const;

export type OwnerPreferenceKey = keyof typeof OwnerPreferenceSchemas;

export type OwnerPreferenceValue<Key extends OwnerPreferenceKey> =
  (typeof OwnerPreferenceSchemas)[Key]["Type"];

const OwnerPreferenceSourceSchema = Schema.Literals(ownerPreferenceSources);

export type OwnerPreferenceSource = typeof OwnerPreferenceSourceSchema.Type;

export interface StoredOwnerPreference<Key extends OwnerPreferenceKey> {
  readonly value: OwnerPreferenceValue<Key>;
  readonly source: OwnerPreferenceSource;
}

export interface TimeZoneChange {
  readonly timeZone: string;
  readonly changed: boolean;
}

export interface EffectiveQuietHours {
  readonly quietHours: QuietHours;
  readonly source: OwnerPreferenceSource | "default";
}

export interface QuietHoursChange extends EffectiveQuietHours {
  readonly previous: QuietHours;
  readonly changed: boolean;
}

export interface PreferenceWrite<Key extends OwnerPreferenceKey> {
  readonly key: Key;
  readonly value: OwnerPreferenceValue<Key>;
  readonly journalValue: string | undefined;
  readonly eventId: string;
  readonly source: OwnerPreferenceSource;
}

const makeOwnerPreferences = Effect.gen(function* makeOwnerPreferencesEffect() {
  const { database } = yield* AgentStorage;
  const journal = yield* Journal;

  const readStored = Effect.fnUntraced(function* readStored<
    Key extends OwnerPreferenceKey,
  >(key: Key) {
    const [row] = yield* database
      .select()
      .from(ownerPreferences)
      .where(eq(ownerPreferences.key, key));
    if (row === undefined) {
      return Option.none<StoredOwnerPreference<Key>>();
    }
    const value = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(OwnerPreferenceSchemas[key])
    )(row.value).pipe(Effect.orDie);
    const source = yield* Schema.decodeUnknownEffect(
      OwnerPreferenceSourceSchema
    )(row.source).pipe(Effect.orDie);
    return Option.some<StoredOwnerPreference<Key>>({
      value: value as OwnerPreferenceValue<Key>,
      source,
    });
  });

  const read = <Key extends OwnerPreferenceKey>(key: Key) =>
    readStored(key).pipe(Effect.map(Option.map(({ value }) => value)));

  const write = Effect.fnUntraced(function* write<
    Key extends OwnerPreferenceKey,
  >({ key, value, journalValue, eventId, source }: PreferenceWrite<Key>) {
    const encoded = Schema.encodeSync(
      Schema.fromJsonString(OwnerPreferenceSchemas[key])
    )(value);
    const changedAt = DateTime.formatIso(yield* DateTime.now);
    yield* database
      .insert(ownerPreferences)
      .values({
        key,
        value: encoded,
        source,
        sourceEventId: eventId,
        changedAt,
      })
      .onConflictDoUpdate({
        target: ownerPreferences.key,
        set: {
          value: encoded,
          source,
          sourceEventId: eventId,
          changedAt,
        },
      });
    if (journalValue !== undefined) {
      yield* journal.append({
        _tag: "OwnerPreferenceChanged",
        eventId,
        preference: key,
        value: journalValue,
      });
    }
  });

  const timeZone = read("time_zone");

  const writeTimeZone = Effect.fnUntraced(function* writeTimeZone(
    name: string,
    eventId: string
  ) {
    const zone = namedTimeZone(name);
    if (Option.isNone(zone)) {
      return yield* new InvalidTimeZone({ name });
    }
    const normalized = DateTime.zoneToString(zone.value);
    const current = yield* timeZone;
    if (Option.contains(current, normalized)) {
      return { timeZone: normalized, changed: false } satisfies TimeZoneChange;
    }
    yield* write({
      key: "time_zone",
      value: normalized,
      journalValue: normalized,
      eventId,
      source: "owner",
    });
    return { timeZone: normalized, changed: true } satisfies TimeZoneChange;
  });

  const setTimeZone = (name: string, eventId: string) =>
    database.transaction(() => writeTimeZone(name, eventId));

  const quietHours = (defaults: QuietHours) =>
    readStored("quiet_hours").pipe(
      Effect.map(
        Option.match({
          onNone: (): EffectiveQuietHours => ({
            quietHours: defaults,
            source: "default",
          }),
          onSome: ({ value, source }): EffectiveQuietHours => ({
            quietHours: value,
            source,
          }),
        })
      )
    );

  const writeQuietHours = Effect.fnUntraced(function* writeQuietHours(
    requested: QuietHours,
    defaults: QuietHours,
    eventId: string
  ) {
    const current = yield* quietHours(defaults);
    if (
      current.source !== "default" &&
      sameQuietHours(current.quietHours, requested)
    ) {
      return {
        ...current,
        previous: current.quietHours,
        changed: false,
      } satisfies QuietHoursChange;
    }
    yield* write({
      key: "quiet_hours",
      value: requested,
      journalValue: quietHoursText(requested),
      eventId,
      source: "owner",
    });
    return {
      quietHours: requested,
      source: "owner",
      previous: current.quietHours,
      changed: true,
    } satisfies QuietHoursChange;
  });

  const setQuietHours = (
    requested: QuietHours,
    defaults: QuietHours,
    eventId: string
  ) =>
    database.transaction(() => writeQuietHours(requested, defaults, eventId));

  const proactiveMutes = read("muted_proactive_messages").pipe(
    Effect.map(Option.getOrElse(() => noProactiveMutes))
  );

  const writeProactiveMutes = Effect.fnUntraced(function* writeProactiveMutes(
    change: ProactiveMuteChange,
    eventId: string
  ) {
    const current = yield* proactiveMutes;
    const next =
      change.change === "muted"
        ? withMutes(current, change.targets)
        : withoutMutes(current, change.targets);
    const changed = !sameMutes(current, next);
    if (changed) {
      yield* write({
        key: "muted_proactive_messages",
        value: next,
        journalValue: undefined,
        eventId,
        source: "owner",
      });
    }
    yield* journal.append({
      _tag: "ProactiveMuteChanged",
      eventId,
      change: change.change,
      openLoopIds: change.targets.openLoopIds,
      kinds: change.targets.kinds,
    });
    return { mutes: next, changed } satisfies ProactiveMutesChange;
  });

  const changeProactiveMutes = (change: ProactiveMuteChange, eventId: string) =>
    database.transaction(() => writeProactiveMutes(change, eventId));

  return {
    timeZone,
    setTimeZone,
    quietHours,
    setQuietHours,
    proactiveMutes,
    changeProactiveMutes,
    ...makeProactiveMessageBudgetPreference({ database, readStored, write }),
  };
});

export class OwnerPreferences extends Context.Service<
  OwnerPreferences,
  Effect.Success<typeof makeOwnerPreferences>
>()("OwnerPreferences") {
  static readonly layer = Layer.effect(OwnerPreferences, makeOwnerPreferences);
}
