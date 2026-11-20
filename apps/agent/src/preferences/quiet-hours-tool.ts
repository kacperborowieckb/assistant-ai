import { Effect, Option, Schema } from "effect";

import type { Journal } from "../journal/journal.ts";
import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { recordedTool } from "../personal-agent/recorded-tool.ts";
import type { TurnProgress } from "../personal-agent/turn-progress.ts";
import { moveBriefToNewQuietHoursEnd } from "../schedule/brief.ts";
import type { Schedules } from "../schedule/schedules.ts";
import { QuietHoursSchema } from "../time/quiet-hours.ts";
import type { QuietHours } from "../time/quiet-hours.ts";
import { LocalClockTimeSchema } from "../time/recurrence-rule.ts";
import type { Redactor } from "../tracing/redactor.ts";
import type { OwnerPreferences } from "./owner-preferences.ts";

export const quietHoursToolName = "quiet_hours";

export const quietHoursNotChangedMessage =
  "The Quiet Hours were not changed. Tell the Owner that you could not change them.";

export const invalidQuietHoursMessage =
  "The Quiet Hours were not changed. Give both start and end as HH:mm, and make the start differ from the end.";

export interface QuietHoursToolServices {
  readonly preferences: OwnerPreferences["Service"];
  readonly schedules: Schedules["Service"];
  readonly journal: Journal["Service"];
  readonly defaultQuietHours: QuietHours;
  readonly progress: TurnProgress["Service"];
  readonly redactor: Redactor["Service"];
}

const QuietHoursInput = Schema.Struct({
  start: Schema.optionalKey(
    LocalClockTimeSchema.pipe(
      Schema.annotate({
        description:
          "The local time when Quiet Hours start, as HH:mm. Give it together with end to change the Quiet Hours.",
      })
    )
  ),
  end: Schema.optionalKey(
    LocalClockTimeSchema.pipe(
      Schema.annotate({
        description:
          "The local time when Quiet Hours end, as HH:mm. Give it together with start to change the Quiet Hours.",
      })
    )
  ),
});

const requestedQuietHours = ({
  start,
  end,
}: typeof QuietHoursInput.Type): Option.Option<QuietHours> =>
  start === undefined || end === undefined
    ? Option.none()
    : Schema.decodeUnknownOption(QuietHoursSchema)({ start, end });

export const quietHoursTool = (
  {
    preferences,
    schedules,
    journal,
    defaultQuietHours,
    progress,
    redactor,
  }: QuietHoursToolServices,
  eventId: string
) =>
  recordedTool(
    { eventId, progress, redactor },
    {
      name: quietHoursToolName,
      description:
        "Read or change the Quiet Hours of the Owner: the local time when you send no Proactive Message. Call it with no input to read them. To change them, give both start and end as HH:mm in the local time of the Owner. For example, when the Owner says not to message them before 9, keep the start and give end 09:00. The start must differ from the end. Reminders and Scheduled Tasks that the Owner set still arrive in Quiet Hours. It returns the Quiet Hours, their source (owner or default), and whether they changed. A Brief that was at the old end moves to the new end.",
      inputSchema: QuietHoursInput,
      failureMessage: quietHoursNotChangedMessage,
      work: Effect.fnUntraced(function* quietHoursEffect(input) {
        if (input.start === undefined && input.end === undefined) {
          const current = yield* preferences.quietHours(defaultQuietHours);
          return {
            ...current.quietHours,
            source: current.source,
            changed: false,
          };
        }
        const requested = requestedQuietHours(input);
        if (Option.isNone(requested)) {
          return yield* new ToolFailed({ message: invalidQuietHoursMessage });
        }
        const result = yield* preferences.setQuietHours(
          requested.value,
          defaultQuietHours,
          eventId
        );
        const briefMoved = yield* moveBriefToNewQuietHoursEnd(
          { schedules, journal },
          {
            oldEnd: result.previous.end,
            newEnd: result.quietHours.end,
            eventId,
          }
        );
        return {
          ...result.quietHours,
          source: result.source,
          changed: result.changed,
          briefMoved,
        };
      }),
    }
  );
