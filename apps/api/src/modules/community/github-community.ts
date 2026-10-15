import type { CommunityStandardItem, CommunityStandards } from "@yugotool/contracts";
import { z } from "zod";
import type { RepoSlug } from "../pull-requests/github/repo-slug";

/** A file entry in community/profile: the object (with `html_url`), or null when absent. */
const fileRefSchema = z.object({ html_url: z.string().nullable().optional() }).nullable();

/** The subset of GitHub's `GET /repos/{o}/{r}/community/profile` we read. */
export const communityProfileSchema = z.object({
  health_percentage: z.number(),
  description: z.string().nullable(),
  updated_at: z.string().nullable().optional(),
  files: z.object({
    code_of_conduct: fileRefSchema.optional(),
    contributing: fileRefSchema.optional(),
    issue_template: fileRefSchema.optional(),
    pull_request_template: fileRefSchema.optional(),
    license: fileRefSchema.optional(),
    readme: fileRefSchema.optional(),
  }),
});
export type CommunityProfile = z.infer<typeof communityProfileSchema>;

/** community/profile omits the security policy; the service probes for it separately. */
export interface SecurityPolicy {
  present: boolean;
  url: string | null;
}

type FileRef = { html_url?: string | null | undefined } | null | undefined;

function present(ref: FileRef): boolean {
  return ref != null;
}

/**
 * GitHub's community/profile (plus a separate security-policy probe) turned into
 * the checklist from the Community Standards page, in its display order. Pure.
 */
export function toCommunityStandards(
  profile: CommunityProfile,
  security: SecurityPolicy,
  slug: RepoSlug,
): CommunityStandards {
  const repoUrl = `https://github.com/${slug.owner}/${slug.name}`;
  const communityPage = `${repoUrl}/community`;
  const files = profile.files;

  const row = (
    key: CommunityStandardItem["key"],
    isPresent: boolean,
    url: string | null,
  ): CommunityStandardItem => ({
    key,
    present: isPresent,
    // Present → the file (fall back to the repo); missing → GitHub's add flow.
    url: isPresent ? (url ?? repoUrl) : communityPage,
  });

  const items: CommunityStandardItem[] = [
    row("description", (profile.description ?? "").trim().length > 0, repoUrl),
    row("readme", present(files.readme), files.readme?.html_url ?? null),
    row("code_of_conduct", present(files.code_of_conduct), files.code_of_conduct?.html_url ?? null),
    row("contributing", present(files.contributing), files.contributing?.html_url ?? null),
    row("license", present(files.license), files.license?.html_url ?? null),
    row("security_policy", security.present, security.url),
    row("issue_template", present(files.issue_template), files.issue_template?.html_url ?? null),
    row(
      "pull_request_template",
      present(files.pull_request_template),
      files.pull_request_template?.html_url ?? null,
    ),
  ];

  const health = Math.max(0, Math.min(100, Math.round(profile.health_percentage)));
  return {
    slug: `${slug.owner}/${slug.name}`,
    healthPercentage: health,
    items,
    updatedAt: profile.updated_at ?? null,
  };
}
