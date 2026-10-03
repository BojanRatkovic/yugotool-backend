export interface RepoSlug {
  owner: string;
  name: string;
}

/**
 * `owner/name` of a GitHub origin URL (`git@github.com:o/r.git`,
 * `https://github.com/o/r(.git)`, `ssh://git@github.com/o/r`); null when the
 * origin isn't on GitHub. Pure.
 */
export function repoSlug(originUrl: string): RepoSlug | null {
  const match = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(originUrl.trim());
  const [, owner, name] = match ?? [];
  return owner && name ? { owner, name } : null;
}
