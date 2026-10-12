/**
 * Productive task descriptions are HTML (a sanitised subset: p, br, strong,
 * em, a, lists, h1–h3, code, pre, blockquote, tables, img). Agents read
 * Markdown, so this turns that subset into Markdown and everything else into
 * its text. No dependency: the input is small and already sanitised.
 */
export function htmlToMarkdown(html: string): string {
  const state: State = { out: [], lists: [], link: null, pre: false, quote: 0 };
  for (const token of tokenize(html)) {
    if (token.kind === "text") {
      const text = decodeEntities(token.text);
      state.out.push(state.pre ? text : text.replace(/\s+/g, " "));
    } else {
      if (Object.hasOwn(TAGS, token.name)) TAGS[token.name]?.(state, token);
    }
  }
  return tidy(state.out.join(""));
}

interface State {
  out: string[];
  /** Open lists, innermost last: ordered lists keep their counter. */
  lists: { ordered: boolean; n: number }[];
  link: string | null;
  pre: boolean;
  quote: number;
}

type Tag = Extract<Token, { kind: "tag" }>;
type TagHandler = (state: State, tag: Tag) => void;

const block = (state: State) => state.out.push("\n\n");
const mark =
  (text: string): TagHandler =>
  (state) =>
    state.out.push(text);

const paragraph: TagHandler = (state, { closing }) => {
  // Rich editors wrap list items in <p>; inside a list it would break the item.
  if (state.lists.length > 0) return;
  block(state);
  if (!closing && state.quote > 0) state.out.push("> ".repeat(state.quote));
};

const heading: TagHandler = (state, { name, closing }) => {
  block(state);
  if (!closing) state.out.push("#".repeat(Number(name[1])) + " ");
};

const list: TagHandler = (state, { name, closing }) => {
  // Only the outermost list is a block; nested ones continue their item.
  if (closing) state.lists.pop();
  else state.lists.push({ ordered: name === "ol", n: 0 });
  if (state.lists.length === (closing ? 0 : 1)) block(state);
};

const listItem: TagHandler = (state, { closing }) => {
  if (closing) return;
  const current = state.lists.at(-1);
  state.out.push("\n", "  ".repeat(Math.max(0, state.lists.length - 1)));
  if (current?.ordered) {
    current.n += 1;
    state.out.push(`${current.n}. `);
  } else state.out.push("- ");
};

const anchor: TagHandler = (state, { closing, attrs }) => {
  if (closing) {
    if (state.link !== null) state.out.push(`](${state.link})`);
    state.link = null;
    return;
  }
  state.link = safeUrl(attrs.href);
  if (state.link !== null) state.out.push("[");
};

const preformatted: TagHandler = (state, { closing }) => {
  if (closing) {
    state.out.push("\n```");
    block(state);
  } else {
    block(state);
    state.out.push("```\n");
  }
  state.pre = !closing;
};

const blockquote: TagHandler = (state, { closing }) => {
  state.quote = Math.max(0, state.quote + (closing ? -1 : 1));
  block(state);
  if (!closing) state.out.push("> ".repeat(state.quote));
};

const cell: TagHandler = (state, { closing }) => state.out.push(closing ? " " : "| ");

/** What each tag of the sanitised subset writes; any other tag keeps only its text. */
const TAGS: Record<string, TagHandler> = {
  br: (state) => state.out.push(state.quote > 0 ? "\n" + "> ".repeat(state.quote) : "  \n"),
  p: paragraph,
  div: paragraph,
  h1: heading,
  h2: heading,
  h3: heading,
  strong: mark("**"),
  b: mark("**"),
  em: mark("_"),
  i: mark("_"),
  del: mark("~~"),
  code: (state) => {
    if (!state.pre) state.out.push("`");
  },
  pre: preformatted,
  blockquote,
  ul: list,
  ol: list,
  li: listItem,
  a: anchor,
  img: (state, { attrs }) => {
    const src = safeUrl(attrs.src);
    if (src !== null) state.out.push(`![${attrs.alt ?? ""}](${src})`);
  },
  tr: (state, { closing }) => {
    if (!closing) state.out.push("\n");
  },
  td: cell,
  th: cell,
  hr: (state) => {
    block(state);
    state.out.push("---");
    block(state);
  },
};

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
