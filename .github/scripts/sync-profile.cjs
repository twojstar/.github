'use strict';

const OPEN_START = '<!--OPEN_PRS:START-->';
const OPEN_END = '<!--OPEN_PRS:END-->';
const QUOTE_START = '<!--STARTS_HERE_QUOTE_README-->';
const QUOTE_END = '<!--ENDS_HERE_QUOTE_README-->';
const FEED_START = '<!--README_FEED:START-->';
const FEED_END = '<!--README_FEED:END-->';
const PROFILE_LOCALES = {
  'profile/README.md': {
    repository: 'Repository',
    title: 'Title',
    author: 'Author',
    state: 'State',
    updated: 'Updated',
    draft: 'draft',
    ready: 'ready',
    empty: 'No open pull requests. 🎉',
  },
  'profile/README_pl.md': {
    repository: 'Repozytorium',
    title: 'Tytuł',
    author: 'Autor',
    state: 'Stan',
    updated: 'Aktualizacja',
    draft: 'wersja robocza',
    ready: 'gotowy',
    empty: 'Brak otwartych pull requestów. 🎉',
  },
  'profile/README_zh.md': {
    repository: '仓库',
    title: '标题',
    author: '作者',
    state: '状态',
    updated: '更新',
    draft: '草稿',
    ready: '就绪',
    empty: '没有开放的拉取请求。🎉',
  },
};
const TARGET_PATHS = ['README.md', ...Object.keys(PROFILE_LOCALES)];
const SOURCE_URL =
  process.env.PROFILE_DRAWER_SOURCE_URL ||
  'https://raw.githubusercontent.com/trvny/trvny/main/README.md';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function blockPattern(start, end) {
  return new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
}

function extractBlock(content, start, end) {
  const match = content.match(blockPattern(start, end));
  if (!match) throw new Error(`Missing source block: ${start}`);
  return match[0];
}

function replaceBlock(content, start, end, block) {
  const pattern = blockPattern(start, end);
  if (!pattern.test(content)) throw new Error(`Missing target block: ${start}`);
  return content.replace(pattern, block);
}
function cell(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|');
}

function renderOpenPrTable(rows, labels = PROFILE_LOCALES['profile/README.md']) {
  if (rows.length === 0) return labels.empty;
  return [
    `| ${labels.repository} | PR | ${labels.title} | ${labels.author} | ${labels.state} | ${labels.updated} |`,
    '| --- | ---: | --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| ${cell(row.repository)} | [#${row.number}](${row.url}) | ${cell(row.title)} | @${cell(row.author)} | ${row.draft ? labels.draft : labels.ready} | ${row.updated.slice(0, 10)} |`,
    ),
  ].join('\n');
}

async function readRepoFile(github, owner, repo, path) {
  const response = await github.rest.repos.getContent({ owner, repo, path });
  if (Array.isArray(response.data) || response.data.type !== 'file') {
    throw new Error(`${owner}/${repo}/${path} is not a file`);
  }
  return {
    content: Buffer.from(response.data.content, 'base64').toString('utf8'),
    sha: response.data.sha,
  };
}

async function listOrgOpenPrs(github, org) {
  const repositories = await github.paginate(github.rest.repos.listForOrg, {
    org,
    type: 'public',
    per_page: 100,
  });
  const rows = [];
  for (const repository of repositories) {
    if (repository.archived || repository.disabled) continue;
    const pullRequests = await github.paginate(github.rest.pulls.list, {
      owner: org,
      repo: repository.name,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    });
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
  }
  return rows.sort(
    (a, b) =>
      a.repository.localeCompare(b.repository) || a.number - b.number,
  );
}

async function fetchDrawerSource() {
  const response = await fetch(SOURCE_URL, {
    headers: { 'user-agent': 'twojstar-profile-upkeep' },
  });
  if (!response.ok) {
    throw new Error(`Drawer source returned HTTP ${response.status}`);
  }
  return response.text();
}
module.exports = async function syncProfile({ github, context, core }) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const [targets, source, openPrs] = await Promise.all([
    Promise.all(TARGET_PATHS.map((path) => readRepoFile(github, owner, repo, path))),
    fetchDrawerSource(),
    listOrgOpenPrs(github, owner),
  ]);

  const quote = extractBlock(source, QUOTE_START, QUOTE_END);
  const feed = extractBlock(source, FEED_START, FEED_END);
  let changed = false;

  for (const [index, target] of targets.entries()) {
    const path = TARGET_PATHS[index];
    let updated = target.content;
    const labels = PROFILE_LOCALES[path];
    if (labels) {
      const open = [OPEN_START, renderOpenPrTable(openPrs, labels), OPEN_END].join(
        '\n',
      );
      updated = replaceBlock(updated, OPEN_START, OPEN_END, open);
    }
    updated = replaceBlock(updated, QUOTE_START, QUOTE_END, quote);
    updated = replaceBlock(updated, FEED_START, FEED_END, feed);
    if (updated === target.content) continue;

    await github.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message: `chore(readme): refresh ${path} drawers [skip ci]`,
      content: Buffer.from(updated, 'utf8').toString('base64'),
      sha: target.sha,
    });
    changed = true;
    core.info(`Refreshed ${path}.`);
  }

  return { changed, openPullRequests: openPrs.length };
};

module.exports._test = {
  extractBlock,
  renderOpenPrTable,
  replaceBlock,
};
