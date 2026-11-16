import { Schema, SchemaTransformation } from "effect";

export const SendTextSchema = Schema.Struct({
  _tag: Schema.Literal("SendText"),
  text: Schema.String,
});

export const RunPromptSchema = Schema.Struct({
  _tag: Schema.Literal("RunPrompt"),
  prompt: Schema.String,
});

export const ScheduleActionSchema = Schema.Union([
  SendTextSchema,
  RunPromptSchema,
]);

export type SendText = typeof SendTextSchema.Type;
export type RunPrompt = typeof RunPromptSchema.Type;
export type ScheduleAction = typeof ScheduleActionSchema.Type;
export type ScheduleActionTag = ScheduleAction["_tag"];

const SendTextColumnsSchema = Schema.Struct({
  action: Schema.Literal("send_text"),
  text: Schema.String,
}).pipe(
  Schema.decodeTo(
    SendTextSchema,
    SchemaTransformation.transform({
      decode: ({ text }) => ({ _tag: "SendText" as const, text }),
      encode: ({ text }) => ({ action: "send_text" as const, text }),
    })
  )
);

const RunPromptColumnsSchema = Schema.Struct({
  action: Schema.Literal("run_prompt"),
  text: Schema.String,
}).pipe(
  Schema.decodeTo(
    RunPromptSchema,
    SchemaTransformation.transform({
      decode: ({ text }) => ({ _tag: "RunPrompt" as const, prompt: text }),
      encode: ({ prompt }) => ({ action: "run_prompt" as const, text: prompt }),
    })
  )
);

const ScheduleActionColumnsSchema = Schema.Union([
  SendTextColumnsSchema,
  RunPromptColumnsSchema,
]);

export const actionOfColumns = Schema.decodeUnknownSync(
  ScheduleActionColumnsSchema
);

export const columnsOfAction = Schema.encodeSync(ScheduleActionColumnsSchema);

export const actionColumnOfTag = (tag: ScheduleActionTag) =>
  tag === "SendText" ? ("send_text" as const) : ("run_prompt" as const);

export const textOfAction = (action: ScheduleAction) =>
  action._tag === "SendText" ? action.text : action.prompt;
