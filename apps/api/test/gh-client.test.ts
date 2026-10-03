import { describe, expect, it } from "vitest";
import { ghFailureError } from "../src/modules/pull-requests/github/gh-client";
import {
  GhMissingError,
  GhNotLoggedInError,
  GithubError,
} from "../src/modules/pull-requests/pull-requests.errors";

describe("ghFailureError", () => {
  it("maps a missing gh binary", () => {
    expect(ghFailureError({ code: "ENOENT", stdout: "", stderr: "" })).toBeInstanceOf(
      GhMissingError,
    );
  });

  it("maps a logged-out gh", () => {
    const error = ghFailureError({
      code: 4,
      stdout: "",
      stderr: "To get started with GitHub CLI, please run:  gh auth login",
    });
    expect(error).toBeInstanceOf(GhNotLoggedInError);
    expect(error).toMatchObject({ code: "pull_requests_unavailable", kind: "unprocessable" });
  });

  it("takes GitHub's message and status from a REST error", () => {
    const error = ghFailureError({
      code: 1,
      stdout: '{"message":"Not Found","status":"404"}',
      stderr: "gh: Not Found (HTTP 404)",
    });
    expect(error).toBeInstanceOf(GithubError);
    expect(error).toMatchObject({ message: "Not Found", httpStatus: 404, kind: "bad_gateway" });
  });

  it("treats a GraphQL NOT_FOUND as 404", () => {
    const error = ghFailureError({
      code: 1,
      stdout: JSON.stringify({
        data: { repository: { pullRequest: null } },
        errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest" }],
      }),
      stderr: "gh: Could not resolve to a PullRequest",
    });
    expect(error).toMatchObject({ message: "Could not resolve to a PullRequest", httpStatus: 404 });
  });

  it("falls back to stderr when there is no JSON body", () => {
    expect(ghFailureError({ code: 1, stdout: "", stderr: "gh: connection refused" })).toMatchObject(
      { message: "connection refused", httpStatus: null },
    );
  });
});
