// Shared, minimal GitHub Issues notification helper -- used by all three
// of this project's new scheduled jobs (rebuild failures, new-archive-
// dataset candidates, significant backtest findings) as their one, common
// alerting mechanism. Deliberately a plain fetch() call against GitHub's
// REST API, not the @octokit/rest SDK -- this project has no GitHub API
// dependency today, and a single POST doesn't justify adding one, matching
// the plain-fetch style already used throughout (fetchArcGisFeatures.ts,
// fetchSocrataRecords.ts).
//
// token is GitHub Actions' own auto-provided GITHUB_TOKEN at runtime (no
// new secret needed for this alone) -- passed explicitly rather than read
// from process.env here, so this stays a pure, DI-friendly, directly
// testable function the same as everything else in this project.

export interface GithubRepository {
  owner: string;
  repo: string;
}

// GITHUB_REPOSITORY (auto-set by Actions) is always exactly "owner/repo" --
// a malformed value here would mean something is structurally wrong with
// the environment this is running in, not imprecise-but-real input, so
// this throws rather than guessing at a best-effort split.
export function parseGithubRepository(repository: string): GithubRepository {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    throw new Error(`parseGithubRepository: expected "owner/repo", got "${repository}"`);
  }
  return { owner: parts[0] as string, repo: parts[1] as string };
}

export interface CreateGithubIssueRequest {
  repository: GithubRepository;
  title: string;
  body: string;
  labels?: string[];
}

export interface CreateGithubIssueResult {
  issueNumber: number;
  url: string;
}

interface RawGithubIssueResponse {
  number: number;
  html_url: string;
}

export async function createGithubIssue(token: string, request: CreateGithubIssueRequest): Promise<CreateGithubIssueResult> {
  const url = `https://api.github.com/repos/${request.repository.owner}/${request.repository.repo}/issues`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      // GitHub's REST API rejects requests with no User-Agent header.
      "User-Agent": "parking-app-scheduled-jobs",
    },
    body: JSON.stringify({ title: request.title, body: request.body, labels: request.labels ?? [] }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`createGithubIssue: POST ${url} failed with status ${response.status} ${response.statusText}: ${errorBody}`);
  }

  const data = (await response.json()) as RawGithubIssueResponse;
  return { issueNumber: data.number, url: data.html_url };
}
