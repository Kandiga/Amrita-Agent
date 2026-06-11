import { z } from 'zod';
import type { FetchLike } from './provider.ts';

/**
 * GitHub issues adapter (ADR-0022): one-way, official REST API only, injected
 * fetch. The token is read from the GITHUB_TOKEN env var at call time, held in
 * a local, and never logged, stored, echoed, or attached to errors.
 */

export const GITHUB_TOKEN_ENV = 'GITHUB_TOKEN';

export const githubRepoSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'expected owner/repo');

/** What we keep from a GitHub issue. Everything else is dropped at the boundary. */
const githubIssueSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().min(1),
    html_url: z.string().url(),
    state: z.string(),
    // present (any shape) iff the "issue" is actually a pull request
    pull_request: z.unknown().optional(),
  })
  .passthrough();

export interface GithubIssueLite {
  number: number;
  title: string;
  url: string;
  state: string;
}

export type GithubErrorCode =
  | 'needs_setup'
  | 'rejected'
  | 'not_found'
  | 'http_error'
  | 'bad_response';

// no parameter properties: the amritad bin runs under Node's strip-only TS mode
export class GithubError extends Error {
  readonly code: GithubErrorCode;
  constructor(code: GithubErrorCode, message: string) {
    super(message);
    this.name = 'GithubError';
    this.code = code;
  }
}

/**
 * Fetch issues (never PRs) from `owner/repo`. `state` follows the GitHub API
 * (`open` default). Throws a structured, value-free GithubError on any failure.
 */
export async function fetchGithubIssues(
  fetchImpl: FetchLike,
  opts: { repo: string; state?: 'open' | 'all'; limit?: number },
): Promise<GithubIssueLite[]> {
  const repo = githubRepoSchema.parse(opts.repo);
  const token = process.env[GITHUB_TOKEN_ENV];
  if (!token) {
    throw new GithubError(
      'needs_setup',
      `GitHub import needs the ${GITHUB_TOKEN_ENV} env var (Amrita stores the name only, never the value)`,
    );
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const url = `https://api.github.com/repos/${repo}/issues?state=${opts.state ?? 'open'}&per_page=${limit}`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'amrita-daemon',
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new GithubError(
      'rejected',
      `api.github.com rejected the ${GITHUB_TOKEN_ENV} credential (HTTP ${res.status}) — token invalid, expired, or lacking access`,
    );
  }
  if (res.status === 404) {
    throw new GithubError('not_found', `repository ${repo} not found (or the token cannot see it)`);
  }
  if (!res.ok) {
    throw new GithubError('http_error', `api.github.com returned HTTP ${res.status}`);
  }
  const body = await res.json();
  const parsed = z.array(githubIssueSchema).safeParse(body);
  if (!parsed.success) {
    throw new GithubError('bad_response', 'api.github.com returned an unexpected issue shape');
  }
  return parsed.data
    .filter((i) => i.pull_request === undefined)
    .map((i) => ({ number: i.number, title: i.title, url: i.html_url, state: i.state }));
}
