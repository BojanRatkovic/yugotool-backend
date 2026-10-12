import { describe, expect, it } from "vitest";
import { contextTokensOf } from "./context-tokens";

describe("contextTokensOf", () => {
  it("adds fresh input, cache reads and cache writes", () => {
    expect(
      contextTokensOf({
        input_tokens: 10,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 300,
      }),
    ).toBe(2310);
  });

  it("treats missing cache counts as zero", () => {
    expect(contextTokensOf({ input_tokens: 7, cache_read_input_tokens: null })).toBe(7);
  });
});
