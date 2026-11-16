import { eq } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";

import { Journal } from "../journal/journal.ts";
import { AgentStorage } from "../personal-agent/agent-storage.ts";
import { ownerPreferences } from "../personal-agent/storage-schema.ts";
import { namedTimeZone, TimeZoneNameSchema } from "../time/time-zone.ts";
import { InvalidTimeZone } from "./invalid-time-zone.ts";

export const OwnerPreferenceSchemas = {
  time_zone: TimeZoneNameSchema,
} as const;

export type OwnerPreferenceKey = keyof typeof OwnerPreferenceSchemas;

export type OwnerPreferenceValue<Key extends OwnerPreferenceKey> =
  (typeof OwnerPreferenceSchemas)[Key]["Type"];

export interface TimeZoneChange {
  readonly timeZone: string;
  readonly changed: boolean;
}

const makeOwnerPreferences = Effect.gen(function* makeOwnerPreferencesEffect() {
  const { database } = yield* AgentStorage;
  const journal = yield* Journal;

  const read = Effect.fnUntraced(function* read<Key extends OwnerPreferenceKey>(
    key: Key
  ) {
    const [row] = yield* database
      .select()
      .from(ownerPreferences)
      .where(eq(ownerPreferences.key, key));
    if (row === undefined) {
      return Option.none<OwnerPreferenceValue<Key>>();
    }
    const value = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(OwnerPreferenceSchemas[key])
    )(row.value).pipe(Effect.orDie);
    return Option.some(value as OwnerPreferenceValue<Key>);
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
    const value = Schema.encodeSync(
      Schema.fromJsonString(OwnerPreferenceSchemas.time_zone)
    )(normalized);
    const changedAt = DateTime.formatIso(yield* DateTime.now);
    yield* database
      .insert(ownerPreferences)
      .values({
        key: "time_zone",
        value,
        sourceEventId: eventId,
        changedAt,
      })
      .onConflictDoUpdate({
        target: ownerPreferences.key,
        set: { value, sourceEventId: eventId, changedAt },
      });
    yield* journal.append({
      _tag: "OwnerPreferenceChanged",
      eventId,
      preference: "time_zone",
      value: normalized,
    });
    return { timeZone: normalized, changed: true } satisfies TimeZoneChange;
  });

  const setTimeZone = (name: string, eventId: string) =>
    database.transaction(() => writeTimeZone(name, eventId));

  return { timeZone, setTimeZone };
});

export class OwnerPreferences extends Context.Service<
  OwnerPreferences,
  Effect.Success<typeof makeOwnerPreferences>
>()("OwnerPreferences") {
  static readonly layer = Layer.effect(OwnerPreferences, makeOwnerPreferences);
}
