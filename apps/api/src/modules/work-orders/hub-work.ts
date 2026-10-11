// Hub projects (spec 0014): which repo a work order may name, and splitting
// one work order into a chain across repos. Pure.
import type { SplitItem, WorkOrder } from "@yugotool/contracts";

export interface ProjectRepos {
  kind: "repo" | "hub";
  /** The hub's repos, by name (empty for repo projects). */
  repos: string[];
}

/** Null when a work order may carry `repo`; otherwise why not. */
export function repoProblem(project: ProjectRepos, repo: string | null | undefined): string | null {
  if (repo === null || repo === undefined) return null;
  if (project.kind !== "hub") return "only work orders of a hub project choose a repo";
  if (!project.repos.includes(repo)) {
    return `${repo} is not a repo of this hub (${project.repos.join(", ")})`;
  }
  return null;
}

/** Null when the work order can be split; otherwise why not. */
export function splitProblem(
  workOrder: Pick<WorkOrder, "kind" | "status">,
  project: ProjectRepos,
  items: SplitItem[],
): string | null {
  if (project.kind !== "hub") return "only work orders of a hub project can be split";
  if (workOrder.kind !== "build") return "only build work orders can be split";
  if (workOrder.status === "done") return "this work order is already done";
  for (const item of items) {
    const problem = repoProblem(project, item.repo);
    if (problem) return problem;
  }
  return null;
}

/**
 * The follower a split item becomes: in the backlog, on its repo, after the
 * previous work order of the chain.
 */
export function followerOf(
  item: SplitItem,
  previousId: string,
): { title: string; description: string; repo: string; followsId: string } {
  return {
    title: item.title,
    description: item.description,
    repo: item.repo,
    followsId: previousId,
  };
}
