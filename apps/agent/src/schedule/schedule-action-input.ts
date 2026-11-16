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

const RunPromptInputSchema = Schema.Struct({
  _tag: Schema.Literal("RunPrompt"),
  prompt: Schema.String.pipe(
    Schema.check(Schema.isPattern(/\S/u)),
    Schema.annotate({
      description:
        "The work to do at the due time. Write it so that it is clear on its own. The Owner is not present, and you will see only this prompt. Example: List my open tasks from my Notes.",
    })
  ),
});

export const ScheduleActionInputSchema = Schema.Union([
  SendTextInputSchema,
  RunPromptInputSchema,
]).pipe(
  Schema.annotate({
    description:
      'What the Schedule does at the due time. {"_tag":"SendText","text":"..."} sends fixed words to the Owner with no further work. {"_tag":"RunPrompt","prompt":"..."} makes you do the work of the prompt at the due time. You send the result to the Owner. Example: tell the Owner their open tasks.',
  })
);
