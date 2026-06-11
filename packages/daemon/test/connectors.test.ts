import { connectorManifestSchema } from '@amrita/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONNECTOR_MANIFESTS, connectorStatuses } from '../src/connectors.ts';
import { GithubError, fetchGithubIssues } from '../src/github.ts';
import { AmritaKernel, dispatch, isErrorResponse } from '../src/index.ts';
import type { FetchLike, FetchResponseLike } from '../src/provider.ts';

// Clearly fake — never a real credential. Set/removed around each test.
const FAKE_TOKEN = 'fake-github-token-for-tests';
const GH_ENV = 'GITHUB_TOKEN';

let savedToken: string | undefined;
beforeEach(() => {
  savedToken = process.env[GH_ENV];
  delete process.env[GH_ENV];
});
afterEach(() => {
  if (savedToken !== undefined) process.env[GH_ENV] = savedToken;
  else delete process.env[GH_ENV];
});

function jsonResponse(status: number, body: unknown): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** A scripted fake Bot-API-style fetch: route by URL substring. */
function fakeFetch(routes: Record<string, () => FetchResponseLike>): FetchLike & {
  calls: { url: string; auth: string | undefined }[];
} {
  const calls: { url: string; auth: string | undefined }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    for (const [needle, make] of Object.entries(routes)) {
      if (url.includes(needle)) return make();
    }
    throw new Error(`fake fetch: unrouted url ${url}`);
  };
  return Object.assign(impl, { calls });
}

const ISSUES = [
  { number: 7, title: 'Crash on save', html_url: 'https://github.com/o/r/issues/7', state: 'open' },
  {
    number: 9,
    title: 'A pull request, not an issue',
    html_url: 'https://github.com/o/r/pull/9',
    state: 'open',
    pull_request: { url: 'https://api.github.com/repos/o/r/pulls/9' },
  },
  { number: 12, title: 'Dark mode', html_url: 'https://github.com/o/r/issues/12', state: 'open' },
];

describe('connector manifests (ADR-0022)', () => {
  it('every registered manifest is schema-valid with env NAMES only', () => {
    expect(CONNECTOR_MANIFESTS.length).toBeGreaterThan(0);
    for (const m of CONNECTOR_MANIFESTS) {
      expect(() => connectorManifestSchema.parse(m)).not.toThrow();
      for (const env of [...m.requiredEnv, ...(m.optionalEnv ?? [])]) {
        expect(env).toMatch(/^[A-Z][A-Z0-9_]*$/); // a NAME, never a value
      }
    }
  });

  it('rejects manifests with secret-shaped or lowercase env entries', () => {
    const bad = {
      slug: 'bad',
      kind: 'source',
      title: 'Bad',
      description: 'x',
      capabilities: [],
      requiredEnv: ['ghp_notAnEnvName123'],
      setupCommands: [],
    };
    expect(connectorManifestSchema.safeParse(bad).success).toBe(false);
  });

  it('github: needs_setup with missing env NAMES when the token is absent', async () => {
    const f = fakeFetch({});
    const [gh] = await connectorStatuses(f);
    expect(gh?.state).toBe('needs_setup');
    expect(gh?.missingEnv).toEqual(['GITHUB_TOKEN']);
    expect(gh?.nextCommand).toContain('export GITHUB_TOKEN=');
    expect(f.calls).toHaveLength(0); // no probe without config
  });

  it('github: connected ONLY on a live 200 probe; 401 is configured_but_failing; network error is status_unknown', async () => {
    process.env.GITHUB_TOKEN = FAKE_TOKEN;

    const ok = await connectorStatuses(fakeFetch({ '/rate_limit': () => jsonResponse(200, {}) }));
    expect(ok[0]?.state).toBe('connected');

    const rejected = await connectorStatuses(
      fakeFetch({ '/rate_limit': () => jsonResponse(401, { message: 'Bad credentials' }) }),
    );
    expect(rejected[0]?.state).toBe('configured_but_failing');
    expect(rejected[0]?.detail).toContain('rejected');

    const down: FetchLike = async () => {
      throw new Error('network down');
    };
    const unknown = await connectorStatuses(down);
    expect(unknown[0]?.state).toBe('status_unknown');
    expect(unknown[0]?.detail).toContain('not claiming connected');

    // no report ever carries the token value
    for (const reports of [ok, rejected, unknown]) {
      expect(JSON.stringify(reports)).not.toContain(FAKE_TOKEN);
    }
  });
});

describe('github issue import (ADR-0022)', () => {
  let kernel: AmritaKernel;
  let fetchImpl: ReturnType<typeof fakeFetch>;

  function ctx(): { projectId: string; conversationId: string } {
    const projectId = kernel.ensureProject({ slug: 'imp', name: 'Import' }).id;
    const conversationId = kernel.createConversation({ projectId }).id;
    return { projectId, conversationId };
  }

  beforeEach(() => {
    fetchImpl = fakeFetch({ '/repos/o/r/issues': () => jsonResponse(200, ISSUES) });
    kernel = AmritaKernel.open({ dbPath: ':memory:', fetchImpl });
  });
  afterEach(() => {
    kernel.close();
  });

  it('without a token: a structured needs_setup error naming the env var, value-free', async () => {
    await expect(fetchGithubIssues(fetchImpl, { repo: 'o/r' })).rejects.toMatchObject({
      code: 'needs_setup',
    });
    const { projectId, conversationId } = ctx();
    const r = await dispatch(kernel, {
      id: 1,
      method: 'github.importIssues',
      params: { projectId, conversationId, repo: 'o/r' },
    });
    expect(isErrorResponse(r)).toBe(true);
    if (isErrorResponse(r)) {
      expect(r.error.code).toBe('missing_env_value');
      expect(r.error.message).toContain('GITHUB_TOKEN');
    }
  });

  it('imports issues as tasks with provenance, excludes PRs, and re-import is idempotent', async () => {
    process.env.GITHUB_TOKEN = FAKE_TOKEN;
    const { projectId, conversationId } = ctx();

    const first = await kernel.importGithubIssues({ projectId, conversationId, repo: 'o/r' });
    expect(first).toMatchObject({ repo: 'o/r', imported: 2, skipped: 0, total: 2 }); // PR excluded
    expect(first.tasks.map((t) => t.externalRef)).toEqual(['github:o/r#7', 'github:o/r#12']);

    const tasks = kernel.listTasks({ projectId });
    expect(tasks).toHaveLength(2);
    const crash = tasks.find((t) => t.externalRef === 'github:o/r#7');
    expect(crash?.title).toBe('#7 · Crash on save');
    expect(crash?.body).toContain('https://github.com/o/r/issues/7');

    // idempotent: same fetch result → everything skipped, nothing duplicated
    const second = await kernel.importGithubIssues({ projectId, conversationId, repo: 'o/r' });
    expect(second).toMatchObject({ imported: 0, skipped: 2, total: 2 });
    expect(kernel.listTasks({ projectId })).toHaveLength(2);

    // the audit trail: task.created events carry externalRef, never the token
    const evs = kernel.listEvents(conversationId);
    const created = evs.filter((e) => e.type === 'task.created');
    expect(created).toHaveLength(2);
    expect(JSON.stringify(evs)).not.toContain(FAKE_TOKEN);

    // the probe header used the token, but only inside the adapter call
    expect(fetchImpl.calls.every((c) => c.url.includes('api.github.com'))).toBe(true);
  });

  it('maps GitHub failures to structured value-free RPC errors', async () => {
    process.env.GITHUB_TOKEN = FAKE_TOKEN;
    const k401 = AmritaKernel.open({
      dbPath: ':memory:',
      fetchImpl: fakeFetch({ '/issues': () => jsonResponse(401, { message: 'Bad credentials' }) }),
    });
    const projectId = k401.ensureProject({ slug: 'e', name: 'E' }).id;
    const conversationId = k401.createConversation({ projectId }).id;
    const r = await dispatch(k401, {
      id: 1,
      method: 'github.importIssues',
      params: { projectId, conversationId, repo: 'o/r' },
    });
    expect(isErrorResponse(r)).toBe(true);
    if (isErrorResponse(r)) {
      expect(r.error.code).toBe('provider_error');
      expect(JSON.stringify(r)).not.toContain(FAKE_TOKEN);
    }
    k401.close();

    await expect(
      fetchGithubIssues(fakeFetch({ '/issues': () => jsonResponse(404, {}) }), { repo: 'o/r' }),
    ).rejects.toSatisfy((e: unknown) => e instanceof GithubError && e.code === 'not_found');
  });

  it('rejects a malformed repo before any network call', async () => {
    process.env.GITHUB_TOKEN = FAKE_TOKEN;
    const { projectId, conversationId } = ctx();
    const r = await dispatch(kernel, {
      id: 1,
      method: 'github.importIssues',
      params: { projectId, conversationId, repo: 'not a repo' },
    });
    expect(isErrorResponse(r)).toBe(true);
    if (isErrorResponse(r)) expect(r.error.code).toBe('invalid_params');
    expect(fetchImpl.calls).toHaveLength(0);
  });
});
