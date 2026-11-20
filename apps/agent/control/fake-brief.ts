import { Option, Schema } from "effect";

import { briefPrompt } from "../src/schedule/brief-prompt.ts";
import { nextLocalMinute } from "./fake-schedule.ts";

export const fakeBriefMoveMessageText = "brief soon";

export const fakeBriefPrefix = "Brief: ";

const ListedSchedulesSchema = Schema.fromJsonString(
  Schema.Struct({
    schedules: Schema.Array(
      Schema.Struct({
        scheduleId: Schema.String,
        action: Schema.Struct({ prompt: Schema.optionalKey(Schema.String) }),
      })
    ),
  })
);

const MovedScheduleSchema = Schema.fromJsonString(
  Schema.Struct({ due: Schema.String })
);

const decodeListed = Schema.decodeUnknownOption(ListedSchedulesSchema);
const decodeMoved = Schema.decodeUnknownOption(MovedScheduleSchema);

const toolCall = (id: string, name: string, input: unknown) => ({
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(input) },
    },
  ],
});

export const isFakeBriefMove = (ownerText: string) =>
  ownerText === fakeBriefMoveMessageText;

export const fakeBriefMoveMessage = (
  toolResult: string | undefined,
  systemText: string
) => {
  if (toolResult === undefined) {
    return toolCall("call-brief-list-1", "list_schedules", {});
  }
  const brief = decodeListed(toolResult).pipe(
    Option.flatMapNullishOr(({ schedules }) =>
      schedules.find(({ action }) => action.prompt === briefPrompt)
    )
  );
  if (Option.isSome(brief)) {
    const time = Option.getOrElse(nextLocalMinute(systemText), () => "");
    return toolCall("call-brief-change-1", "change_schedule", {
      scheduleId: brief.value.scheduleId,
      repeat: { _tag: "Daily", time: time.slice(-5) },
    });
  }
  const moved = decodeMoved(toolResult);
  return {
    role: "assistant",
    content: Option.isSome(moved)
      ? `Brief moved to ${moved.value.due}`
      : "Sorry, I could not move the Brief.",
  };
};

export const fakeBriefMessage = (systemText: string) => ({
  role: "assistant",
  content: `${fakeBriefPrefix}${systemText.split("\n").filter((line) => /^- \S+ \(/u.test(line)).length} open Open Loops`,
});
