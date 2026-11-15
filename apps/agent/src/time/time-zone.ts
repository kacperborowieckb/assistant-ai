import { DateTime, Option, Schema } from "effect";

export const normalizeTimeZoneName = (name: string): Option.Option<string> =>
  namedTimeZone(name).pipe(Option.map(DateTime.zoneToString));

export const TimeZoneNameSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (name) =>
        normalizeTimeZoneName(name).pipe(Option.contains(name)) ||
        "Expected an IANA time zone name such as Europe/Warsaw"
    )
  )
);

export const namedTimeZone = (name: string) =>
  DateTime.zoneMakeNamed(name.trim());
