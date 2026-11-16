import { Schema } from "effect";

const SendTextInputSchema = Schema.Struct({
  _tag: Schema.Literal("SendText"),
  text: Schema.String.pipe(
    Schema.check(Schema.isPattern(/\S/u)),
    Schema.annotate({
      description:
        "The fixed message to send to the Owner at the due time. Write it so that it is clear on its own, for example: Buy the gift for Ana.",
    })
  ),
});

export const ScheduleActionInputSchema = Schema.Union([
  SendTextInputSchema,
]).pipe(
  Schema.annotate({
    description:
      'What the Schedule does at the due time. {"_tag":"SendText","text":"..."} sends fixed words to the Owner with no further work.',
  })
);
