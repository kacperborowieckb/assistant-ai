import { Data } from "effect";

export class InvalidTimeZone extends Data.TaggedError("InvalidTimeZone")<{
  readonly name: string;
}> {}
