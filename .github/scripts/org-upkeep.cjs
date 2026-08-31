'use strict';

const keepPullRequestsCurrent = require('./pr-upkeep.cjs');

function parseList(value) {
  return String(value ?? '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function listInstallationRepositories(github) {
  const excluded = new Set(
    parseList(process.env.PR_UPKEEP_EXCLUDE_REPOS).map((item) =>
      item.toLowerCase(),
    ),
  );
  const repositories = await github.paginate(
    'GET /installation/repositories',
    { per_page: 100 },
    (response) => response.data.repositories,
  );

  return repositories
    .filter((repository) => !repository.archived && !repository.disabled)
    .filter(
      (repository) => !excluded.has(repository.full_name.toLowerCase()),
    )
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

async function listOpenPullRequests(github, owner, repo) {
  return github.paginate(
    github.rest.pulls.list,
    {
      owner,
      repo,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    },
  );
}

function cell(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|');
}

function renderOpenPrTable(rows) {
  if (rows.length === 0) return 'No open pull requests. 🎉';
  return [
    '| Repository | PR | Title | Author | State | Updated |',
    '| --- | ---: | --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| ${cell(row.repository)} | [#${row.number}](${row.url}) | ${cell(row.title)} | @${cell(row.author)} | ${row.draft ? 'draft' : 'ready'} | ${row.updated.slice(0, 10)} |`,
    ),
  ].join('\n');
}

module.exports = async function runOrgUpkeep({ github, core }) {
  const repositories = await listInstallationRepositories(github);
  const failures = [];
  const rows = [];

  core.info(
    `GPTomek installation exposes ${repositories.length} repository/repositories.`,
  );

  for (const repository of repositories) {
    const [owner, repo] = repository.full_name.split('/');
    core.startGroup(`Update ${repository.full_name}`);
    try {
      const result = await keepPullRequestsCurrent({
        github,
        context: { repo: { owner, repo } },
        core,
      });
      failures.push(
        ...(result.failures ?? []).map(
          (failure) => `${repository.full_name}: ${failure}`,
        ),
      );

      const pullRequests = await listOpenPullRequests(github, owner, repo);
      for (const pullRequest of pullRequests) {
        rows.push({
          author: pullRequest.user?.login ?? 'unknown',
          draft: pullRequest.draft,
          number: pullRequest.number,
          repository: repository.full_name,
          title: pullRequest.title,
          updated: pullRequest.updated_at,
          url: pullRequest.html_url,
        });
      }
    } catch (error) {
      const message = `${repository.full_name}: ${error.message}`;
      failures.push(message);
      core.error(message);
    } finally {
      core.endGroup();
    }
  }

  rows.sort(
    (a, b) =>
      a.repository.localeCompare(b.repository) || a.number - b.number,
  );
  await core.summary
    .addRaw(
      `## Organization upkeep\n\nRepositories: ${repositories.length}\n\n` +
        `### Open pull requests (${rows.length})\n\n${renderOpenPrTable(rows)}`,
    )
    .write();

  if (failures.length > 0) core.setFailed(failures.join('\n'));
  return { failures, repositories: repositories.length, rows };
};

module.exports._test = { parseList, renderOpenPrTable };
