import * as os from "os";
import { ReviewDetail, ReviewRequest } from "../../types";
import { countUnresolved, mapRollup } from "../pr/facts";
import { execRunner, GH_TIMEOUT_MS, Locate, Runner, THREADS_QUERY } from "../pr/provider";
import { resolveBin } from "../pr/which";
import { REVIEW_SEARCH_LIMIT, REVIEW_SEARCH_Q, REVIEW_SEARCH_QUERY, parseSearch } from "./search";

const locateGh: Locate = () => resolveBin("gh");

export interface ReviewProvider {
  search(): Promise<{ issueCount: number; requests: ReviewRequest[] } | null>;
  detail(repo: string, number: number): Promise<ReviewDetail | null>;
}

/** Every call here is repo-independent: a PR requesting your review may live in a
 * repository you have never cloned. `--repo owner/name` carries the target, and
 * the home directory is only somewhere that exists for `gh` to run in. */
export class GhReviewProvider implements ReviewProvider {
  constructor(
    private readonly run: Runner = execRunner,
    private readonly locate: Locate = locateGh,
  ) {}

  private gh(): string {
    return this.locate() ?? "gh";
  }

  private exec(args: string[]): Promise<string> {
    return this.run(this.gh(), args, { cwd: os.homedir(), timeoutMs: GH_TIMEOUT_MS });
  }

  /** Null means the attempt failed — never "you owe nobody a review". The caller
   * keeps its cached list and flags it stale rather than emptying the strip. */
  async search(): Promise<{ issueCount: number; requests: ReviewRequest[] } | null> {
    try {
      const out = await this.exec([
        "api", "graphql",
        "-f", `query=${REVIEW_SEARCH_QUERY}`,
        "-f", `q=${REVIEW_SEARCH_Q}`,
        "-F", `n=${REVIEW_SEARCH_LIMIT}`,
      ]);
      return parseSearch(JSON.parse(out) as unknown);
    } catch {
      return null;
    }
  }

  /** The two things the search cannot return: which checks failed, and how many
   * review threads are still open. A thread-call failure degrades to `null`
   * rather than discarding the checks we did get. */
  async detail(repo: string, number: number): Promise<ReviewDetail | null> {
    let failing: ReviewDetail["failing"];
    try {
      const out = await this.exec(["pr", "view", String(number), "--repo", repo, "--json", "statusCheckRollup"]);
      const parsed = JSON.parse(out) as { statusCheckRollup?: Parameters<typeof mapRollup>[0] };
      failing = mapRollup(parsed.statusCheckRollup).failing;
    } catch {
      return null;
    }
    const [owner, name] = repo.split("/");
    let unresolved: number | null = null;
    if (owner && name) {
      try {
        const out = await this.exec([
          "api", "graphql", "-f", `query=${THREADS_QUERY}`,
          "-F", `o=${owner}`, "-F", `r=${name}`, "-F", `n=${number}`,
        ]);
        unresolved = countUnresolved(JSON.parse(out) as unknown);
      } catch {
        unresolved = null;
      }
    }
    return { failing, unresolved };
  }
}
