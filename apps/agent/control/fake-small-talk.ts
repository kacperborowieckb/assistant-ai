export const fakeSmallTalk = "ok";

export const isFakeSmallTalk = (ownerText: string) =>
  ownerText.trim().toLowerCase() === fakeSmallTalk;

export const fakeSmallTalkMessage = (toolResult: string | undefined) =>
  toolResult === undefined
    ? {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-silent-1",
            type: "function",
            function: { name: "stay_silent", arguments: "{}" },
          },
        ],
      }
    : { role: "assistant", content: "Okay." };
