import { DateTime } from "effect";
import type { Option } from "effect";

import { setTimeZoneToolName } from "../preferences/set-time-zone-tool.ts";

const weekdayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const twoDigits = (value: number) => String(value).padStart(2, "0");

const localTimeOf = (instant: DateTime.Utc, timeZone: DateTime.TimeZone) => {
  const local = DateTime.setZone(instant, timeZone);
  const { year, month, day, hour, minute, weekDay } = DateTime.toParts(local);
  return `${weekdayNames[weekDay]} ${year}-${twoDigits(month)}-${twoDigits(day)}, ${twoDigits(hour)}:${twoDigits(minute)}`;
};

export const timeZoneNotKnownText = `The time zone of the Owner is not known, so you do not know their local date or time. Before you do anything that depends on it, ask the Owner where they live or for their time zone. When they tell you, call ${setTimeZoneToolName} with the IANA name.`;

export const currentTimeText = (
  instant: DateTime.Utc,
  timeZone: Option.Option<DateTime.TimeZone.Named>
) =>
  timeZone._tag === "None"
    ? timeZoneNotKnownText
    : `Current local time of the Owner: ${localTimeOf(instant, timeZone.value)} (time zone ${DateTime.zoneToString(timeZone.value)}).`;
