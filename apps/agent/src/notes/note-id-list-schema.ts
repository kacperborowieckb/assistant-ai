import { Schema } from "effect";

export const maxLinkedNotes = 20;

export const noteIdListSchema = (description: string) =>
  Schema.Array(Schema.String.pipe(Schema.check(Schema.isPattern(/\S/u)))).pipe(
    Schema.check(Schema.isMaxLength(maxLinkedNotes)),
    Schema.annotate({ description })
  );
