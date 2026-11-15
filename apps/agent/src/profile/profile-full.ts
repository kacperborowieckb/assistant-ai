import { Data } from "effect";

export class ProfileFull extends Data.TaggedError("ProfileFull")<{
  readonly charactersUsed: number;
  readonly characterLimit: number;
}> {}
