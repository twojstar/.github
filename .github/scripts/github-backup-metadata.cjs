'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'twojstar-github-backup';
const MAX_ATTEMPTS = 5;
const RETRY_BUDGET_MS = 20 * 60_000;

function usage() {
  throw new Error('usage: node github-backup-metadata.cjs OWNER/REPO MIRROR OUTPUT_DIR');
}

const [repository, mirrorPath, outputDir] = process.argv.slice(2);
if (!repository || !mirrorPath || !outputDir || !repository.includes('/')) usage();
const [owner, repo] = repository.split('/', 2);
const token = process.env.GH_TOKEN;
if (!token) throw new Error('GH_TOKEN is required');

function headers(extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': API_VERSION,
    ...extra,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(response, attempt) {
  const retryAfter = response?.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(seconds * 1000, 1000);
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.max(timestamp - Date.now(), 1000);
  }

  const remaining = response?.headers.get('x-ratelimit-remaining');
  const reset = Number(response?.headers.get('x-ratelimit-reset'));
  if (remaining === '0' && Number.isFinite(reset)) {
    return Math.max(reset * 1000 - Date.now() + 1000, 1000);
  }

  return Math.min(1000 * 2 ** attempt, 16_000);
}

async function retryPause(delay, deadline, reason) {
  const boundedDelay = Math.max(Math.ceil(delay), 1000);
  if (Date.now() + boundedDelay > deadline) {
    throw new Error(
      `${reason}; retry delay ${boundedDelay}ms exceeds the remaining request retry budget`,
    );
  }
  console.error(`${reason}; retrying in ${boundedDelay}ms`);
  await sleep(boundedDelay);
}

async function requestJson(url, options = {}, { deadline = Date.now() + RETRY_BUDGET_MS } = {}) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: headers(options.headers),
      });
    } catch (error) {
      if (attempt + 1 >= MAX_ATTEMPTS) throw error;
      await retryPause(
        retryDelayMs(null, attempt),
        deadline,
        `GitHub request network failure for ${url}`,
      );
      continue;
    }

    let body;
    try {
      body = await response.text();
    } catch (error) {
      if (attempt + 1 >= MAX_ATTEMPTS) {
        throw new Error(`GitHub response body read failed for ${url}: ${error.message}`);
      }
      await retryPause(
        retryDelayMs(response, attempt),
        deadline,
        `GitHub response body read failure for ${url}`,
      );
      continue;
    }
    if (response.ok) {
      try {
        return {
          data: body ? JSON.parse(body) : null,
          headers: response.headers,
          status: response.status,
        };
      } catch (error) {
        if (attempt + 1 >= MAX_ATTEMPTS) {
          throw new Error(`Invalid JSON from ${url}: ${error.message}`);
        }
        await retryPause(
          retryDelayMs(response, attempt),
          deadline,
          `Invalid GitHub JSON from ${url}`,
        );
        continue;
      }
    }

    const rateLimited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get('retry-after') ||
          response.headers.get('x-ratelimit-remaining') === '0' ||
          /(?:secondary )?rate limit/i.test(body)));
    const retryable = rateLimited || response.status >= 500;
    if (!retryable || attempt + 1 >= MAX_ATTEMPTS) {
      throw new Error(`${response.status} ${response.statusText} for ${url}: ${body.slice(0, 1000)}`);
    }

    await retryPause(
      retryDelayMs(response, attempt),
      deadline,
      `GitHub request ${response.status} for ${url}`,
    );
  }

  throw new Error(`GitHub request retries exhausted for ${url}`);
}

function retryableGraphqlErrors(errors) {
  return (
    Array.isArray(errors) &&
    errors.length > 0 &&
    errors.every((error) => {
      const signal = [
        error?.type,
        error?.extensions?.code,
        error?.message,
      ]
        .filter(Boolean)
        .join(' ');
      return /rate.?limit|throttl|abuse|secondary/i.test(signal);
    })
  );
}

function graphqlRetryDelayMs(payload, responseHeaders, attempt) {
  const remaining = Number(payload?.data?.rateLimit?.remaining);
  const headerRemaining = responseHeaders?.get('x-ratelimit-remaining');
  const primaryExhausted = remaining === 0 || headerRemaining === '0';

  if (primaryExhausted) {
    const resetAt = Date.parse(payload?.data?.rateLimit?.resetAt ?? '');
    if (Number.isFinite(resetAt)) return Math.max(resetAt - Date.now() + 1000, 1000);
    return retryDelayMs({ headers: responseHeaders }, attempt);
  }

  if (responseHeaders?.get('retry-after')) {
    return retryDelayMs({ headers: responseHeaders }, attempt);
  }

  return Math.min(60_000 * 2 ** attempt, 5 * 60_000);
}

async function requestGraphql(query, variables) {
  const deadline = Date.now() + RETRY_BUDGET_MS;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const { data: payload, headers: responseHeaders } = await requestJson(
      `${API}/graphql`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      },
      { deadline },
    );

    if (!payload?.errors?.length) return payload;
    if (!retryableGraphqlErrors(payload.errors) || attempt + 1 >= MAX_ATTEMPTS) {
      throw new Error(`GraphQL request failed: ${JSON.stringify(payload.errors)}`);
    }

    await retryPause(
      graphqlRetryDelayMs(payload, responseHeaders, attempt),
      deadline,
      `GitHub GraphQL throttled for ${repository}`,
    );
  }

  throw new Error(`GraphQL retries exhausted for ${repository}`);
}

async function paginateRest(endpoint, params = {}, { allowNoContent = false } = {}) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const url = new URL(`${API}${endpoint}`);
    for (const [key, value] of Object.entries({ ...params, per_page: 100, page })) {
      url.searchParams.set(key, String(value));
    }
    const { data, status } = await requestJson(url);
    if (status === 204 && allowNoContent) break;
    if (!Array.isArray(data)) throw new Error(`Expected array from ${endpoint}, got HTTP ${status}`);
    items.push(...data);
    if (data.length < 100) break;
  }
  return items;
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function writeJsonl(file, items) {
  const descriptor = fs.openSync(file, 'w');
  try {
    for (const item of items) fs.writeSync(descriptor, `${JSON.stringify(item)}\n`);
  } finally {
    fs.closeSync(descriptor);
  }
}

function normalizeGraphqlReview(pullNumber, review) {
  return {
    pull_number: pullNumber,
    id: review.databaseId ?? null,
    node_id: review.id ?? null,
    author_login: review.author?.login ?? null,
    author_id: null,
    author_association: review.authorAssociation ?? null,
    state: review.state ?? null,
    body: review.body ?? null,
    submitted_at: review.submittedAt ?? null,
    created_at: review.createdAt ?? null,
    updated_at: review.updatedAt ?? null,
    url: review.url ?? null,
    commit_id: review.commit?.oid ?? null,
    source_api: 'graphql',
  };
}

function normalizeRestReview(pullNumber, review) {
  return {
    pull_number: pullNumber,
    id: review.id ?? null,
    node_id: review.node_id ?? null,
    author_login: review.user?.login ?? null,
    author_id: review.user?.id ?? null,
    author_association: review.author_association ?? null,
    state: review.state ?? null,
    body: review.body ?? null,
    submitted_at: review.submitted_at ?? null,
    created_at: review.created_at ?? null,
    updated_at: review.updated_at ?? null,
    url: review.html_url ?? null,
    commit_id: review.commit_id ?? null,
    source_api: 'rest',
  };
}

async function fetchPullReviews() {
  const query = `
    query($owner:String!, $repo:String!, $cursor:String) {
      repository(owner:$owner, name:$repo) {
        pullRequests(first:50, after:$cursor, orderBy:{field:CREATED_AT, direction:ASC}) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number
            reviews(first:100) {
              totalCount
              pageInfo { hasNextPage }
              nodes {
                id
                databaseId
                author { login }
                authorAssociation
                state
                body
                submittedAt
                createdAt
                updatedAt
                url
                commit { oid }
              }
            }
          }
        }
      }
      rateLimit { remaining resetAt }
    }`;

  const reviews = [];
  let cursor = null;
  do {
    const payload = await requestGraphql(query, { owner, repo, cursor });
    const pulls = payload.data?.repository?.pullRequests;
    if (!pulls) throw new Error(`GraphQL repository not found: ${repository}`);

    for (const pull of pulls.nodes) {
      if (pull.reviews.pageInfo.hasNextPage) {
        const overflow = await paginateRest(`/repos/${owner}/${repo}/pulls/${pull.number}/reviews`);
        reviews.push(...overflow.map((review) => normalizeRestReview(pull.number, review)));
      } else {
        reviews.push(...pull.reviews.nodes.map((review) => normalizeGraphqlReview(pull.number, review)));
      }
    }
    cursor = pulls.pageInfo.hasNextPage ? pulls.pageInfo.endCursor : null;
  } while (cursor);

  return reviews;
}

function wikiGitEnvironment() {
  const gitToken = process.env.GIT_AUTH_TOKEN;
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
  };
  if (process.platform !== 'win32') env.GIT_ASKPASS = '/bin/false';
  if (!gitToken) return env;

  const basic = Buffer.from(`x-access-token:${gitToken}`).toString('base64');
  return {
    ...env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

function backupWiki(repositoryData) {
  if (!repositoryData?.has_wiki) {
    return { enabled: false, backed_up: false, reason: 'disabled', refs: 0 };
  }

  const url = `https://github.com/${repository}.wiki.git`;
  const env = wikiGitEnvironment();
  const probe = spawnSync('git', ['ls-remote', url], {
    encoding: 'utf8',
    env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (probe.status !== 0) {
    const detail = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`.trim();
    if (/repository not found|not found/i.test(detail)) {
      const reason = repositoryData.private && !process.env.GIT_AUTH_TOKEN
        ? 'auth-unavailable'
        : 'uninitialized';
      return { enabled: true, backed_up: false, reason, refs: 0 };
    }
    throw new Error(`Wiki probe failed for ${repository}: ${detail.slice(0, 1000)}`);
  }

  const wikiPath = path.join(outputDir, 'wiki.git');
  if (fs.existsSync(wikiPath)) {
    throw new Error(`Refusing to overwrite existing wiki mirror: ${wikiPath}`);
  }
  execFileSync('git', ['clone', '--mirror', url, wikiPath], { env, stdio: 'inherit' });
  execFileSync('git', ['-C', wikiPath, 'fsck', '--full'], { stdio: 'inherit' });
  const refs = execFileSync(
    'git',
    ['-C', wikiPath, 'for-each-ref', '--format=%(refname)'],
    { encoding: 'utf8' },
  )
    .split(/\r?\n/)
    .filter(Boolean).length;
  return { enabled: true, backed_up: true, reason: null, refs };
}

function gitContributors() {
  const output = execFileSync(
    'git',
    ['-C', mirrorPath, 'log', '--all', '--format=%aN%x00%aE%x00'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const fields = output.split('\0');
  const counts = new Map();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const name = fields[index].replace(/^\r?\n/, '');
    const email = fields[index + 1];
    if (!name && !email) continue;
    const key = JSON.stringify([name, email]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([identity, commits]) => {
      const [name, email] = JSON.parse(identity);
      return { name, email, commits };
    })
    .sort((a, b) =>
      b.commits - a.commits ||
      a.name.localeCompare(b.name) ||
      a.email.localeCompare(b.email),
    );
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const { data: repositoryData } = await requestJson(`${API}/repos/${owner}/${repo}`);
  const pulls = await paginateRest(`/repos/${owner}/${repo}/pulls`, {
    state: 'all',
    sort: 'created',
    direction: 'asc',
  });
  const issuesRaw = await paginateRest(`/repos/${owner}/${repo}/issues`, {
    state: 'all',
    sort: 'created',
    direction: 'asc',
  });
  const issues = issuesRaw.filter((issue) => !issue.pull_request);
  const conversationComments = await paginateRest(`/repos/${owner}/${repo}/issues/comments`, {
    sort: 'created',
    direction: 'asc',
  });
  const reviewComments = await paginateRest(`/repos/${owner}/${repo}/pulls/comments`, {
    sort: 'created',
    direction: 'asc',
  });
  const issueEvents = await paginateRest(`/repos/${owner}/${repo}/issues/events`);
  const contributors = await paginateRest(
    `/repos/${owner}/${repo}/contributors`,
    { anon: '1' },
    { allowNoContent: true },
  );
  const pullReviews = await fetchPullReviews();
  const gitAuthors = gitContributors();
  const wiki = backupWiki(repositoryData);

  writeJson(path.join(outputDir, 'repository.json'), repositoryData);
  writeJsonl(path.join(outputDir, 'pulls.jsonl'), pulls);
  writeJsonl(path.join(outputDir, 'pull-reviews.jsonl'), pullReviews);
  writeJsonl(path.join(outputDir, 'conversation-comments.jsonl'), conversationComments);
  writeJsonl(path.join(outputDir, 'review-comments.jsonl'), reviewComments);
  writeJsonl(path.join(outputDir, 'issues.jsonl'), issues);
  writeJsonl(path.join(outputDir, 'issue-events.jsonl'), issueEvents);
  writeJson(path.join(outputDir, 'contributors.json'), contributors);
  writeJson(path.join(outputDir, 'git-contributors.json'), gitAuthors);

  const counts = {
    pulls: pulls.length,
    pull_reviews: pullReviews.length,
    conversation_comments: conversationComments.length,
    review_comments: reviewComments.length,
    issues: issues.length,
    issue_events: issueEvents.length,
    github_contributors: contributors.length,
    git_contributors: gitAuthors.length,
    wiki_backed_up: wiki.backed_up ? 1 : 0,
    wiki_refs: wiki.refs,
  };
  writeJson(path.join(outputDir, 'EXPORT.json'), {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    repository,
    counts,
    wiki,
    notes: [
      'JSON and JSONL files preserve GitHub API identifiers, authors, timestamps, states, and URLs.',
      'Binary attachments, Actions artifacts, releases, packages, and repository settings are not included.',
      'git-contributors.json is derived from commit authors in the mirrored Git history.',
      'When GitHub Wiki exists, wiki.git is a verified full Git mirror stored inside this metadata archive.',
    ],
  });
  process.stdout.write(`${repository}: ${JSON.stringify(counts)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});