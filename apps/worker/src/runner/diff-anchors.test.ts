import type { ReviewFinding } from "@yugotool/contracts";
import { describe, expect, it } from "vitest";
import { anchorFindings, parseHunks } from "./diff-anchors";

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,6 +10,8 @@ export function a() {
 context
+added
+added
 context
@@ -40,3 +42,3 @@
-old
+new
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-x
-y
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+one
+two
+three
`;

const f = (patch: Partial<ReviewFinding>): ReviewFinding => ({
  id: "f1",
  severity: "important",
  category: "bug",
  file: "src/a.ts",
  side: "RIGHT",
  startLine: null,
  line: 12,
  title: "t",
  body: "b",
  suggestion: null,
  confidence: "high",
  ...patch,
});

describe("parseHunks", () => {
  it("reads both sides of every hunk", () => {
    const hunks = parseHunks(PATCH);
    expect(hunks.get("src/a.ts")).toEqual({
      RIGHT: [
        { start: 10, end: 17 },
        { start: 42, end: 44 },
      ],
      LEFT: [
        { start: 10, end: 15 },
        { start: 40, end: 42 },
      ],
    });
    expect(hunks.get("src/new.ts")).toEqual({ RIGHT: [{ start: 1, end: 3 }], LEFT: [] });
    expect(hunks.has("src/gone.ts")).toBe(false);
  });
});

describe("anchorFindings", () => {
  const hunks = parseHunks(PATCH);

  it("keeps lines inside a hunk, context lines included", () => {
    expect(anchorFindings([f({ line: 10 }), f({ line: 43 })], hunks).map((x) => x.line)).toEqual([
      10, 43,
    ]);
  });

  it("drops the line outside every hunk but keeps the file", () => {
    const [out] = anchorFindings([f({ line: 30, suggestion: "fixed()" })], hunks);
    expect(out).toMatchObject({ file: "src/a.ts", line: null, suggestion: null });
    expect(out?.body).toContain("Suggested change:\n\n```\nfixed()\n```");
  });

  it("drops the file when it is not in the diff", () => {
    expect(anchorFindings([f({ file: "src/other.ts" })], hunks)[0]).toMatchObject({
      file: null,
      line: null,
    });
  });

  it("checks LEFT lines against the old side", () => {
    const [kept, dropped] = anchorFindings(
      [f({ side: "LEFT", line: 41 }), f({ side: "LEFT", line: 17 })],
      hunks,
    );
    expect(kept?.line).toBe(41);
    expect(dropped?.line).toBeNull();
  });

  it("keeps a range inside one hunk and shrinks one that crosses hunks", () => {
    const [inside, crossing] = anchorFindings(
      [f({ startLine: 11, line: 13 }), f({ startLine: 16, line: 43, suggestion: "x" })],
      hunks,
    );
    expect(inside).toMatchObject({ startLine: 11, line: 13 });
    expect(crossing).toMatchObject({ startLine: null, line: 43, suggestion: null });
  });

  it("leaves findings about the PR as a whole alone", () => {
    const whole = f({ file: null, line: null });
    expect(anchorFindings([whole], hunks)[0]).toBe(whole);
  });
});
