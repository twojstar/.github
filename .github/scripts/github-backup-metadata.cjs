'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'twojstar-github-backup';

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
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 1000), 60_000);
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.min(Math.max(timestamp - Date.now(), 1000), 60_000);
  }

  const remaining = response?.headers.get('x-ratelimit-remaining');
  const reset = Number(response?.headers.get('x-ratelimit-reset'));
  if (remaining === '0' && Number.isFinite(reset)) {
    return Math.min(Math.max(reset * 1000 - Date.now() + 1000, 1000), 60_000);
  }

  return Math.min(1000 * 2 ** attempt, 16_000);
}

async function requestJson(url, options = {}) {
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: headers(options.headers),
      });
    } catch (error) {
      if (attempt + 1 >= maxAttempts) throw error;
      const delay = retryDelayMs(null, attempt);
      console.error(`GitHub request network failure; retrying in ${delay}ms: ${url}`);
      await sleep(delay);
      continue;
    }

    const body = await response.text();
    if (response.ok) {
      try {
        return { data: body ? JSON.parse(body) : null, headers: response.headers };
      } catch (error) {
        if (attempt + 1 >= maxAttempts) {
          throw new Error(`Invalid JSON from ${url}: ${error.message}`);
        }
        const delay = retryDelayMs(response, attempt);
        console.error(`Invalid GitHub JSON; retrying in ${delay}ms: ${url}`);
        await sleep(delay);
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
    if (!retryable || attempt + 1 >= maxAttempts) {
      throw new Error(`${response.status} ${response.statusText} for ${url}: ${body.slice(0, 1000)}`);
    }

    const delay = retryDelayMs(response, attempt);
    console.error(`GitHub request ${response.status}; retrying in ${delay}ms: ${url}`);
    await sleep(delay);
  }

  throw new Error(`GitHub request retries exhausted for ${url}`);
}

async function paginateRest(endpoint, params = {}) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const url = new URL(`${API}${endpoint}`);
    for (const [key, value] of Object.entries({ ...params, per_page: 100, page })) {
      url.searchParams.set(key, String(value));
    }
    const { data } = await requestJson(url);
    if (!Array.isArray(data)) throw new Error(`Expected array from ${endpoint}`);
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
    }`;

  const reviews = [];
  let cursor = null;
  do {
    const { data: payload } = await requestJson(`${API}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { owner, repo, cursor } }),
    });
    if (payload.errors?.length) throw new Error(`GraphQL reviews failed: ${JSON.stringify(payload.errors)}`);
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
  const contributors = await paginateRest(`/repos/${owner}/${repo}/contributors`, { anon: '1' });
  const pullReviews = await fetchPullReviews();
  const gitAuthors = gitContributors();

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
  };
  writeJson(path.join(outputDir, 'EXPORT.json'), {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    repository,
    counts,
    notes: [
      'JSON and JSONL files preserve GitHub API identifiers, authors, timestamps, states, and URLs.',
      'Binary attachments, Actions artifacts, releases, packages, and repository settings are not included.',
      'git-contributors.json is derived from commit authors in the mirrored Git history.',
    ],
  });
  process.stdout.write(`${repository}: ${JSON.stringify(counts)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});