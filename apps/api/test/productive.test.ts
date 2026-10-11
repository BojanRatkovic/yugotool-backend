import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../src/modules/productive/html-to-markdown";
import { productiveError } from "../src/modules/productive/productive.client";
import {
  ProductiveForbiddenError,
  ProductiveRateLimitedError,
  ProductiveTokenInvalidError,
  ProductiveUnavailableError,
} from "../src/modules/productive/productive.errors";
import { parameterize, taskUrl } from "../src/modules/productive/productive.service";

describe("htmlToMarkdown (spec 0019)", () => {
  it("turns paragraphs, emphasis and links into Markdown", () => {
    expect(
      htmlToMarkdown(
        '<p>Add <strong>invoice</strong> reminders, see <a href="https://x.io/a">the doc</a>.</p><p>Second&nbsp;line &amp; more</p>',
      ),
    ).toBe("Add **invoice** reminders, see [the doc](https://x.io/a).\n\nSecond line & more");
  });

  it("keeps lists, nested lists and list items wrapped in <p>", () => {
    expect(
      htmlToMarkdown(
        "<ul><li><p>One</p></li><li>Two<ol><li>a</li><li>b</li></ol></li></ul><p>After</p>",
      ),
    ).toBe("- One\n- Two\n  1. a\n  2. b\n\nAfter");
  });

  it("keeps headings, code blocks and line breaks", () => {
    expect(htmlToMarkdown("<h2>Steps</h2><pre><code>pnpm  test\nok</code></pre>Line<br>next")).toBe(
      "## Steps\n\n```\npnpm  test\nok\n```\n\nLine  \nnext",
    );
  });

  it("drops unsafe links and unknown tags, keeps their text", () => {
    expect(
      htmlToMarkdown('<a href="javascript:alert(1)">click</a> <span class="m">@Ana</span>'),
    ).toBe("click @Ana");
  });

  it("is empty for empty markup", () => {
    expect(htmlToMarkdown("<p></p><br>")).toBe("");
  });
});

describe("task links", () => {
  it("builds Productive's own task URL from the organization", () => {
    expect(
      taskUrl({ organizationId: "109", organizationName: "Productive Inc." }, "17121511"),
    ).toBe("https://app.productive.io/109-productive-inc/task/17121511");
  });

  it("parameterizes like Rails: ASCII, lowercase, dashes", () => {
    expect(parameterize("Čevapi & Đuveč  d.o.o.")).toBe("cevapi-duvec-d-o-o");
    expect(parameterize("!!!")).toBe("");
  });
});

describe("productiveError", () => {
  it("maps statuses to domain errors with Productive's detail", () => {
    expect(productiveError(401, "")).toBeInstanceOf(ProductiveTokenInvalidError);
    const forbidden = productiveError(403, JSON.stringify({ errors: [{ detail: "no_person" }] }));
    expect(forbidden).toBeInstanceOf(ProductiveForbiddenError);
    expect(forbidden.message).toBe("no_person");
    expect(productiveError(429, "")).toBeInstanceOf(ProductiveRateLimitedError);
    const down = productiveError(500, "<html>");
    expect(down).toBeInstanceOf(ProductiveUnavailableError);
    expect(down.message).toBe("Productive answered 500.");
  });
});
