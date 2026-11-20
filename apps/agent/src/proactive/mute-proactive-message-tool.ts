import { Effect, Schema } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";
import type { Note, Notes } from "../notes/notes.ts";
import { textForModel } from "../notes/recalled-note.ts";
import { recordedTool } from "../personal-agent/recorded-tool.ts";
import type { TurnProgress } from "../personal-agent/turn-progress.ts";
import type { OwnerPreferences } from "../preferences/owner-preferences.ts";
import type { Redactor } from "../tracing/redactor.ts";
import type { ProactiveMessages } from "./proactive-messages.ts";
import { normalizeKind } from "./proactive-mutes.ts";
import type { ProactiveMutes } from "./proactive-mutes.ts";

export const muteProactiveMessageToolName = "mute_proactive_message";

export const muteNotChangedMessage =
  "The mute was not changed. Tell the Owner that you could not change it.";

export const nothingToMuteMessage = `No Proactive Message is connected to this message, and no target was given. Ask the Owner which Open Loop or which kind they mean, then call ${muteProactiveMessageToolName} again with openLoopIds or kind. Use ${muteProactiveMessageToolName} with action list to see what is muted.`;

export const unknownOpenLoopsMessage = (noteIds: readonly string[]) =>
  `These ids are not Notes of the Owner: ${noteIds.join(", ")}. Nothing was changed. Use ids from list_open_loops or search_notes.`;

export interface MuteProactiveMessageToolServices {
  readonly preferences: OwnerPreferences["Service"];
  readonly notes: Notes["Service"];
  readonly proactiveMessages: ProactiveMessages["Service"];
  readonly progress: TurnProgress["Service"];
  readonly redactor: Redactor["Service"];
}

const MuteInput = Schema.Struct({
  action: Schema.Literals(["mute", "undo", "list"]).pipe(
    Schema.annotate({
      description:
        "mute: the Owner wants less of this. undo: the Owner wants the mute removed. list: show what is muted.",
    })
  ),
  scope: Schema.optionalKey(
    Schema.Literals(["open_loops", "kind"]).pipe(
      Schema.annotate({
        description:
          "open_loops (default): the Open Loops of the Proactive Message that this message follows, or those in openLoopIds. kind: all Open Loops of their kinds, or of the kind that you give.",
      })
    )
  ),
  openLoopIds: Schema.optionalKey(
    Schema.Array(Schema.String).pipe(
      Schema.annotate({
        description:
          "The Open Loop ids to mute or unmute. Leave them out to use the Open Loops of the Proactive Message that this message follows.",
      })
    )
  ),
  kind: Schema.optionalKey(
    Schema.String.pipe(
      Schema.annotate({
        description:
          "With scope kind: the Open Loop kind, for example task. Leave it out to use the kinds of the Proactive Message that this message follows.",
      })
    )
  ),
});

const kindsOf = (loops: readonly Pick<Note, "openLoop">[]) => [
  ...new Set(
    loops.flatMap(({ openLoop }) =>
      openLoop === undefined ? [] : [normalizeKind(openLoop.kind)]
    )
  ),
];

export const muteProactiveMessageTool = (
  {
    preferences,
    notes,
    proactiveMessages,
    progress,
    redactor,
  }: MuteProactiveMessageToolServices,
  eventId: string
) => {
  const targetsOf = Effect.fnUntraced(function* targetsOf(
    input: typeof MuteInput.Type
  ) {
    const connected = yield* proactiveMessages.connectedTo(eventId);
    const noteIds = input.openLoopIds ?? connected?.openLoopIds ?? [];
    const loops = yield* notes.byIds(noteIds);
    const found = new Set(loops.map(({ noteId }) => noteId));
    const unknown = noteIds.filter((noteId) => !found.has(noteId));
    if (unknown.length > 0) {
      return yield* new ToolFailed({
        message: unknownOpenLoopsMessage(unknown),
      });
    }
    const targets: ProactiveMutes =
      input.scope === "kind"
        ? {
            openLoopIds: [],
            kinds:
              input.kind === undefined
                ? kindsOf(loops)
                : [normalizeKind(input.kind)],
          }
        : { openLoopIds: noteIds, kinds: [] };
    if (targets.openLoopIds.length === 0 && targets.kinds.length === 0) {
      return yield* new ToolFailed({ message: nothingToMuteMessage });
    }
    return targets;
  });

  const withMutedOpenLoopsOfKinds = Effect.fnUntraced(
    function* withMutedOpenLoopsOfKinds(requested: ProactiveMutes) {
      const mutes = yield* preferences.proactiveMutes;
      const mutedLoops = yield* notes.byIds(mutes.openLoopIds);
      const coveredIds = mutedLoops
        .filter(
          ({ openLoop }) =>
            openLoop !== undefined &&
            requested.kinds.includes(normalizeKind(openLoop.kind))
        )
        .map(({ noteId }) => noteId);
      return {
        openLoopIds: [...new Set([...requested.openLoopIds, ...coveredIds])],
        kinds: requested.kinds,
      } satisfies ProactiveMutes;
    }
  );

  return recordedTool(
    { eventId, progress, redactor },
    {
      name: muteProactiveMessageToolName,
      description:
        'Save, undo, or list the Owner\'s request for less of a kind of Proactive Message. Call it with action mute when the Owner says "less of this", "stop nagging me about this", or similar, as a message right after a Proactive Message. The default scope is the Open Loops of that message. When it is not clear whether the Owner means these Open Loops or all Open Loops of their kind, save the default now and ask one short question; call it again with scope kind and the openLoopIds from the first result only if the Owner says all, because a later message is not connected to the Proactive Message. An undo with scope kind also removes the Open Loop mutes of those kinds. A muted Open Loop or kind gets no follow-up of its own and appears only in the Brief. This means less often, not never. When the Owner wants it to stop for good, close the Open Loop or cancel the Schedule with the other tools instead. Call it with action undo when the Owner wants the mute removed. Say that you changed a mute only after the tool succeeded.',
      inputSchema: MuteInput,
      failureMessage: muteNotChangedMessage,
      work: Effect.fnUntraced(function* muteEffect(input) {
        if (input.action === "list") {
          const mutes = yield* preferences.proactiveMutes;
          const loops = yield* notes.byIds(mutes.openLoopIds);
          return {
            kinds: mutes.kinds,
            openLoops: loops.map((note) => ({
              noteId: note.noteId,
              text: textForModel(note),
            })),
          };
        }
        const requested = yield* targetsOf(input);
        const targets =
          input.action === "undo" && input.scope === "kind"
            ? yield* withMutedOpenLoopsOfKinds(requested)
            : requested;
        const result = yield* preferences.changeProactiveMutes(
          {
            change: input.action === "mute" ? "muted" : "unmuted",
            targets,
          },
          eventId
        );
        return {
          action: input.action,
          openLoopIds: targets.openLoopIds,
          kinds: targets.kinds,
          changed: result.changed,
          mutedOpenLoopIds: result.mutes.openLoopIds,
          mutedKinds: result.mutes.kinds,
        };
      }),
    }
  );
};
