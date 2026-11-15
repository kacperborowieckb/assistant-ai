import { Schema } from "effect";

import {
  NonEmptyString,
  SeedNoteSchema,
  SeedProfileEntrySchema,
} from "../../eval/eval-contract.ts";
import { EvalCheckSchema } from "./eval-checks.ts";
import { OwnerLabelSchema } from "./owner-label.ts";

export const OwnerEventSchema = Schema.Struct({
  text: NonEmptyString,
  forwardedFrom: Schema.optionalKey(NonEmptyString),
  owner: Schema.optionalKey(OwnerLabelSchema),
});

export type OwnerEvent = typeof OwnerEventSchema.Type;

export const EvalCaseSchema = Schema.Struct({
  description: NonEmptyString,
  seed: Schema.optionalKey(
    Schema.Struct({
      notes: Schema.optionalKey(Schema.Array(SeedNoteSchema)),
      profile: Schema.optionalKey(Schema.Array(SeedProfileEntrySchema)),
    })
  ),
  events: Schema.Array(OwnerEventSchema).pipe(
    Schema.check(Schema.isMinLength(1))
  ),
  checks: Schema.Array(EvalCheckSchema).pipe(
    Schema.check(Schema.isMinLength(1))
  ),
});

export type EvalCaseFile = typeof EvalCaseSchema.Encoded;

export interface EvalCase extends Readonly<typeof EvalCaseSchema.Type> {
  readonly name: string;
}
