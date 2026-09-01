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

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: headers(options.headers),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText} for ${url}: ${body.slice(0, 1000)}`);
  }
  return { data: await response.json(), headers: response.headers };
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
  fs.writeFileSync(file, items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : ''));
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
        reviews.push(...overflow.map((review) => ({ pull_number: pull.number, review })));
      } else {
        reviews.push(...pull.reviews.nodes.map((review) => ({ pull_number: pull.number, review })));
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