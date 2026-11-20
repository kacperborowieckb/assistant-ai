import { Schema } from "effect";

import { effectInputSchema, outcomeTool } from "../model-gateway/agent-tool.ts";

export const staySilentToolName = "stay_silent";

export const silenceAfterChangeMessage =
  "Silence refused: this Turn changed Owner data. Answer the Owner with a short text that says what you did, or react with one emoji.";

export const silenceAfterFailureMessage =
  "Silence refused: a tool call that changes Owner data failed in this Turn. Answer the Owner with a text that says what did not work.";

export const silenceAcceptedOutput = { outcome: "silent" } as const;

export const staySilentTool = outcomeTool({
  description:
    'End the Turn without sending anything. Use it only for small talk that needs no answer, such as "ok", "thanks", or a thumbs up. Never use it when you changed something in this Turn, when something failed, or when the Owner asked a question or asked for something. Code refuses it in those cases, and then you answer with a text or a reaction.',
  inputSchema: effectInputSchema(Schema.Struct({})),
});

export const staySilentSection = `When a message of the Owner is only small talk that needs no answer, such as "ok", "thanks", "got it", or a thumbs up, call ${staySilentToolName} instead of writing a reply, and write nothing else. Do not reply just to reply. Never call ${staySilentToolName} when you changed or tried to change something in this Turn, when the Owner asked a question or asked for something, or when something failed: then answer with a text or a reaction.`;
