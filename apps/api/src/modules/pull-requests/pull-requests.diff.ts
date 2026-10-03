/** Same cap as a run's diff: past it, the UI links to GitHub. */
export const MAX_PATCH_CHARS = 5 * 1024 * 1024;

/** Cuts a patch at the last whole line under `max` characters. Pure. */
export function capPatch(
  patch: string,
  max = MAX_PATCH_CHARS,
): { patch: string; truncated: boolean } {
  if (patch.length <= max) return { patch, truncated: false };
  const cut = patch.lastIndexOf("\n", max);
  return { patch: patch.slice(0, cut === -1 ? max : cut + 1), truncated: true };
}

/** Splits a unified diff into per-file chunks, each starting at `diff --git`. */
function fileChunks(patch: string): { paths: string[]; text: string }[] {
  return patch
    .split(/^(?=diff --git )/m)
    .filter((chunk) => chunk.startsWith("diff --git "))
    .map((text) => {
      const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(text);
      return { paths: header ? [header[1] ?? "", header[2] ?? ""] : [], text };
    });
}

/**
 * Keeps only the chunks of `patch` for files the PR itself changes. A compare
 * from my last review to the head also carries everything merged in from the
 * base branch since; those files aren't the author's changes. Pure.
 */
export function onlyPrFiles(patch: string, prPatch: string): string {
  const prPaths = new Set(fileChunks(prPatch).flatMap((c) => c.paths));
  return fileChunks(patch)
    .filter((chunk) => chunk.paths.some((p) => prPaths.has(p)))
    .map((chunk) => chunk.text)
    .join("");
}
