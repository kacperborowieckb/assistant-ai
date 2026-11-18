const namedPromptLength = 80;

export const nameOfPrompt = (prompt: string) => {
  const oneLine = prompt.replaceAll(/\s+/gu, " ").trim();
  return oneLine.length > namedPromptLength
    ? `${oneLine.slice(0, namedPromptLength)}...`
    : oneLine;
};
