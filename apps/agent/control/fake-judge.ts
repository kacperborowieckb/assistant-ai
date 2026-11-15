export const fakeJudgeModel = "fake-judge-model";

export type FakeJudgeVerdict = "pass" | "fail";

export const fakeJudgeMessage = (verdict: FakeJudgeVerdict) => ({
  role: "assistant",
  content: JSON.stringify({
    verdict,
    reason: `The fake judge says ${verdict}.`,
  }),
});
