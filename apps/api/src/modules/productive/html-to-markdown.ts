/**
 * Productive task descriptions are HTML (a sanitised subset: p, br, strong,
 * em, a, lists, h1–h3, code, pre, blockquote, tables, img). Agents read
 * Markdown, so this turns that subset into Markdown and everything else into
 * its text. No dependency: the input is small and already sanitised.
 */
export function htmlToMarkdown(html: string): string {
  const tokens = tokenize(html);
  const out: string[] = [];
  /** Open lists, innermost last: ordered lists keep their counter. */
  const lists: { ordered: boolean; n: number }[] = [];
  let link: string | null = null;
  let pre = false;
  let quote = 0;

  const newline = () => out.push("\n");
  const block = () => out.push("\n\n");

  for (const token of tokens) {
    if (token.kind === "text") {
      const text = decodeEntities(token.text);
      out.push(pre ? text : text.replace(/\s+/g, " "));
      continue;
    }
    const { name, closing, attrs } = token;
    switch (name) {
      case "br":
        out.push(quote > 0 ? "\n" + "> ".repeat(quote) : "  \n");
        break;
      case "p":
      case "div":
        // Rich editors wrap list items in <p>; inside a list it would break the item.
        if (lists.length > 0) break;
        block();
        if (!closing && quote > 0) out.push("> ".repeat(quote));
        break;
      case "h1":
      case "h2":
      case "h3":
        block();
        if (!closing) out.push("#".repeat(Number(name[1])) + " ");
        break;
      case "strong":
      case "b":
        out.push("**");
        break;
      case "em":
      case "i":
        out.push("_");
        break;
      case "del":
        out.push("~~");
        break;
      case "code":
        if (!pre) out.push("`");
        break;
      case "pre":
        if (closing) {
          out.push("\n```");
          block();
        } else {
          block();
          out.push("```\n");
        }
        pre = !closing;
        break;
      case "blockquote":
        quote = Math.max(0, quote + (closing ? -1 : 1));
        block();
        if (!closing) out.push("> ".repeat(quote));
        break;
      case "ul":
      case "ol":
        // Only the outermost list is a block; nested ones continue their item.
        if (closing) lists.pop();
        else lists.push({ ordered: name === "ol", n: 0 });
        if (lists.length === (closing ? 0 : 1)) block();
        break;
      case "li": {
        if (closing) break;
        const list = lists.at(-1);
        newline();
        out.push("  ".repeat(Math.max(0, lists.length - 1)));
        if (list?.ordered) {
          list.n += 1;
          out.push(`${list.n}. `);
        } else out.push("- ");
        break;
      }
      case "a":
        if (closing) {
          if (link !== null) out.push(`](${link})`);
          link = null;
        } else {
          link = safeUrl(attrs.href);
          if (link !== null) out.push("[");
        }
        break;
      case "img": {
        const src = safeUrl(attrs.src);
        if (src !== null) out.push(`![${attrs.alt ?? ""}](${src})`);
        break;
      }
      case "tr":
        if (!closing) newline();
        break;
      case "td":
      case "th":
        if (!closing) out.push("| ");
        else out.push(" ");
        break;
      case "hr":
        block();
        out.push("---");
        block();
        break;
      default:
        break;
    }
  }
  return tidy(out.join(""));
}

type Token =
  | { kind: "text"; text: string }
  | { kind: "tag"; name: string; closing: boolean; attrs: Record<string, string> };

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|<!--[\s\S]*?-->/g;
  let last = 0;
  for (const match of html.matchAll(re)) {
    if (match.index > last) tokens.push({ kind: "text", text: html.slice(last, match.index) });
    last = match.index + match[0].length;
    const name = match[2];
    if (name === undefined) continue; // a comment
    tokens.push({
      kind: "tag",
      name: name.toLowerCase(),
      closing: match[1] === "/",
      attrs: parseAttrs(match[3] ?? ""),
    });
  }
  if (last < html.length) tokens.push({ kind: "text", text: html.slice(last) });
  return tokens;
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(/([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const key = match[1];
    if (key !== undefined)
      attrs[key.toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

/** Only web links survive; `javascript:` and friends become plain text. */
function safeUrl(url: string | undefined): string | null {
  if (url === undefined) return null;
  return /^(https?:|mailto:)/i.test(url.trim())
    ? url.trim().replace(/[()\s]/g, encodeURIComponent)
    : null;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X"))
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** Trims each line's trailing blanks (not a `  ` hard break) and collapses blank runs. */
function tidy(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) =>
      line.endsWith("  ") && line.trim() !== "" ? line.trimEnd() + "  " : line.trimEnd(),
    )
    .map((line) => line.replace(/^(\s*(?:[-*]|\d+\.) ) +/, "$1"))
    .join("\n")
    .replace(/\*\*\s*\*\*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
