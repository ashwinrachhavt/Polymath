/*
 * The three GitHub calls the bug agent makes, over the REST API with a token
 * from the environment. The token needs Issues read/write on one repository
 * and nothing else; it is never logged or echoed in an error.
 */

export type GitHubIssues = {
  /** The open or closed issue already filed for a fingerprint, if any. */
  findByFingerprint(fingerprint: string): Promise<number | null>;
  /** Open agent issues in the same area, newest first. */
  findSimilar(area: string): Promise<number[]>;
  create(issue: { title: string; body: string; labels: string[] }): Promise<number>;
};

const API = "https://api.github.com";
const TIMEOUT_MS = 15_000;

export function gitHubIssues(input: { token: string; repo: string; fetch?: typeof fetch }): GitHubIssues {
  const doFetch = input.fetch ?? fetch;

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await doFetch(`${API}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
        "user-agent": "polymath-bug-agent",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      // Status only: GitHub error bodies can echo the request.
      throw new Error(`GitHub ${init?.method ?? "GET"} ${path.split("?")[0]} failed with ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async function search(query: string, perPage: number): Promise<number[]> {
    const q = encodeURIComponent(`repo:${input.repo} is:issue ${query}`);
    const result = await call<{ items: Array<{ number: number }> }>(
      `/search/issues?q=${q}&per_page=${perPage}&sort=created&order=desc`,
    );
    return result.items.map((item) => item.number);
  }

  return {
    async findByFingerprint(fingerprint) {
      const [number] = await search(`"${fingerprint}" in:body`, 1);
      return number ?? null;
    },
    async findSimilar(area) {
      return search(`is:open label:bug-agent label:"area:${area}"`, 3);
    },
    async create(issue) {
      const created = await call<{ number: number }>(`/repos/${input.repo}/issues`, {
        method: "POST",
        body: JSON.stringify(issue),
      });
      return created.number;
    },
  };
}
