import { describe, expect, it } from "vitest";
import { planDispatch } from "../src/modules/dispatcher/dispatcher.service";

const queue = [
  { id: "w1", account: "personal" },
  { id: "w2", account: "work" },
  { id: "w3", account: "personal" },
  { id: "w4", account: "work" },
];

describe("planDispatch: headroom per account (spec 0016)", () => {
  it("starts in queue order up to the free slots when no account is full", () => {
    expect(
      planDispatch(
        queue,
        new Map([
          ["personal", false],
          ["work", false],
        ]),
        3,
      ),
    ).toEqual({
      start: ["w1", "w2", "w3"],
      blocked: [],
    });
  });

  it("a full account holds back only its own orders", () => {
    expect(
      planDispatch(
        queue,
        new Map([
          ["personal", true],
          ["work", false],
        ]),
        3,
      ),
    ).toEqual({
      start: ["w2", "w4"],
      blocked: ["personal"],
    });
  });

  it("starts nothing when every account with queued work is full", () => {
    expect(
      planDispatch(
        queue,
        new Map([
          ["personal", true],
          ["work", true],
        ]),
        2,
      ),
    ).toEqual({
      start: [],
      blocked: ["personal", "work"],
    });
  });

  it("one account (no accounts set up) behaves as before: full means nothing starts", () => {
    const single = [
      { id: "a", account: "env" },
      { id: "b", account: "env" },
    ];
    expect(planDispatch(single, new Map([["env", false]]), 1)).toEqual({
      start: ["a"],
      blocked: [],
    });
    expect(planDispatch(single, new Map([["env", true]]), 1)).toEqual({
      start: [],
      blocked: ["env"],
    });
  });

  it("no free slot starts nothing but still reports a full account", () => {
    expect(
      planDispatch(
        queue,
        new Map([
          ["personal", true],
          ["work", false],
        ]),
        0,
      ),
    ).toEqual({
      start: [],
      blocked: ["personal"],
    });
  });
});
