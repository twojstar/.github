const fs = require('node:fs');

const target = process.env.TARGET_REPO || process.argv[2];
const legacyOwner = process.env.LEGACY_OWNER || 'trvny';
if (!target || !target.includes('/')) {
  console.error('Usage: TARGET_REPO=owner/repo node migration-audit.cjs');
  process.exit(2);
}
const [owner, repo] = target.split('/');
const ciCrossRepo = process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY !== target;
const token = process.env.AUDIT_GH_TOKEN || (!ciCrossRepo ? (process.env.GH_TOKEN || '') : '');
const headers = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'twojstar-migration-audit',
};
if (token) headers.Authorization = `Bearer ${token}`;

/** Escape user-controlled repository names before embedding them in a RegExp. */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Perform one GitHub API request and require a successful response. */
async function api(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
/** Probe an authenticated-only endpoint without confusing unreadable with absent. */
async function probe(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers });
  if ([401, 403, 404].includes(response.status)) return { status: response.status, data: null };
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return { status: response.status, data: await response.json() };
}

/** Retrieve all pages from a standard GitHub list endpoint. */
async function apiAll(path) {
  const separator = path.includes('?') ? '&' : '?';
  const items = [];
  for (let page = 1; ; page += 1) {
    const batch = await api(`${path}${separator}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

let defaultBranch = 'main';
/** Fetch repository text and fail closed on transient or permission errors. */
async function raw(path) {
  if (token) {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(defaultBranch)}`, {
      headers: { ...headers, Accept: 'application/vnd.github.raw+json' },
    });
    if (!response.ok) throw new Error(`${path}: contents HTTP ${response.status}`);
    return response.text();
  }
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${path}`;
  const response = await fetch(url, { headers: { 'User-Agent': headers['User-Agent'] } });
  if (!response.ok) throw new Error(`${path}: raw HTTP ${response.status}`);
  return response.text();
}

/** Return a complete blob path listing, traversing subtrees if GitHub truncates recursion. */
async function listBlobPaths() {
  const recursive = await api(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`);
  if (!recursive.truncated) return recursive.tree.filter((entry) => entry.type === 'blob').map((entry) => entry.path);
  const paths = [];
  const queue = [{ sha: recursive.sha, prefix: '' }];
  let traversed = 0;
  while (queue.length) {
    const current = queue.shift();
    traversed += 1;
    if (traversed > 5000) throw new Error('repository tree traversal exceeded safety bound');
    const tree = await api(`/repos/${owner}/${repo}/git/trees/${current.sha}`);
    for (const entry of tree.tree) {
      const path = current.prefix ? `${current.prefix}/${entry.path}` : entry.path;
      if (entry.type === 'blob') paths.push(path);
      if (entry.type === 'tree') queue.push({ sha: entry.sha, prefix: path });
    }
  }
  return paths;
}

const rows = [];
let failed = false;
/** Record one audit result and remember hard failures for the process exit code. */
function result(name, status, detail) {
  rows.push({ name, status, detail });
  if (status === 'FAIL') failed = true;
}

(async () => {
  const metadata = await api(`/repos/${owner}/${repo}`);
  defaultBranch = metadata.default_branch;
  result('Repository', metadata.private ? 'WARN' : 'PASS', `${metadata.full_name} (${metadata.visibility})`);

  const paths = await listBlobPaths();
  const readmes = paths.filter((path) => /(^|\/)README[^/]*\.md$/i.test(path));
  const legacyPattern = new RegExp(`(?:github\\.com|raw\\.githubusercontent\\.com|deepwiki\\.com|img\\.shields\\.io/github/license)/${escapeRegex(legacyOwner)}/${escapeRegex(repo)}`, 'i');
  const stale = [];
  for (const path of readmes) {
    const text = await raw(path);
    if (legacyPattern.test(text)) stale.push(path);
  }
  result('Legacy self-links', stale.length ? 'FAIL' : 'PASS', stale.length ? stale.join(', ') : `no ${legacyOwner}/${repo} links in README files`);

  const dependabotPath = paths.find((path) => path.toLowerCase() === '.github/dependabot.yml');
  if (!dependabotPath) result('Dependabot', 'FAIL', 'missing .github/dependabot.yml');
  else {
    const config = await raw(dependabotPath);
    const cleaned = config.split(/\r?\n/).map((line) => line.replace(/\s+#.*$/, '')).join('\n');
    const lines = cleaned.split('\n');
    const updatesLine = lines.findIndex((line) => /^\s*updates:\s*$/.test(line));
    const updateBlocks = [];
    if (updatesLine >= 0) {
      const baseIndent = lines[updatesLine].match(/^\s*/)[0].length;
      let current = [];
      for (let i = updatesLine + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.trim()) continue;
        const indent = line.match(/^\s*/)[0].length;
        if (indent <= baseIndent) break;
        if (indent === baseIndent + 2 && /^\s*-\s+/.test(line)) {
          if (current.length) updateBlocks.push(current);
          current = [line.replace(/^\s*-\s*/, '  ')];
        } else if (current.length) current.push(line);
      }
      if (current.length) updateBlocks.push(current);
    }
    const knownEcosystems = new Set(['bundler','bun','cargo','composer','devcontainers','docker','docker-compose','dotnet-sdk','elm','gitsubmodule','github-actions','gomod','gradle','helm','hex','maven','mix','npm','nuget','pip','pip-compile','pipenv','pnpm','pub','swift','terraform','uv','vcpkg']);
    const validUpdates = updateBlocks.filter((blockLines) => {
      const block = blockLines.join('\n');
      const eco = block.match(/^\s*package-ecosystem:\s*["']?([^"'#\s]+)["']?\s*$/mi)?.[1];
      const directory = block.match(/^\s*directory:\s*["']?([^"'#\s]+)["']?\s*$/mi)?.[1];
      const directories = /^\s*directories:\s*$/mi.test(block) && /^\s*-\s*["']?[^"'#\s]+/m.test(block.slice(block.search(/^\s*directories:\s*$/mi)));
      const blockSchedule = /^\s*schedule:\s*$/mi.test(block) && /^\s*interval:\s*["']?[^"'#\s]+/mi.test(block);
      const inlineSchedule = /^\s*schedule:\s*\{[^}]*\binterval\s*:\s*["']?[^"'#\s,}]+/mi.test(block);
      const schedule = blockSchedule || inlineSchedule;
      return knownEcosystems.has((eco || '').toLowerCase()) && Boolean(directory || directories) && schedule;
    });
    const usable = /^\s*version:\s*2\s*$/m.test(cleaned) && validUpdates.length > 0;
    result('Dependabot', usable ? 'PASS' : 'FAIL', usable ? `${validUpdates.length} valid update entr${validUpdates.length === 1 ? 'y' : 'ies'}` : 'no complete updates entry with supported ecosystem, path and schedule');
  }

  const rulesets = await apiAll(`/repos/${owner}/${repo}/rulesets`);
  let copilot = false;
  for (const item of rulesets) {
    if (item.enforcement !== 'active') continue;
    const detail = await api(`/repos/${owner}/${repo}/rulesets/${item.id}`);
    if (detail.rules?.some((rule) => rule.type === 'copilot_code_review')) copilot = true;
  }
  result('Copilot auto-review', copilot ? 'PASS' : 'FAIL', copilot ? 'active ruleset found' : 'no active copilot_code_review ruleset');

  const workflowPaths = paths.filter((path) => /^\.github\/workflows\/.*\.ya?ml$/i.test(path));
  let advancedWorkflow = '';
  for (const path of workflowPaths) {
    const text = await raw(path);
    const executableLines = text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line));
    const hasInit = executableLines.some((line) => /^\s*(?:-\s*)?uses:\s*["']?github\/codeql-action\/init@/i.test(line));
    const hasAnalyze = executableLines.some((line) => /^\s*(?:-\s*)?uses:\s*["']?github\/codeql-action\/analyze@/i.test(line));
    if (hasInit && hasAnalyze) {
      advancedWorkflow = path;
      break;
    }
  }
  let defaultSetup = { status: 0, data: null };
  if (token && !advancedWorkflow) defaultSetup = await probe(`/repos/${owner}/${repo}/code-scanning/default-setup`);
  if (advancedWorkflow) result('CodeQL', 'PASS', `advanced workflow: ${advancedWorkflow}`);
  else if (defaultSetup.data?.state === 'configured') {
    result('CodeQL', 'PASS', `default setup: ${(defaultSetup.data.languages || []).join(', ') || 'configured'}`);
  } else if (token && defaultSetup.status === 200) {
    result('CodeQL', 'FAIL', `default setup state: ${defaultSetup.data?.state || 'unknown'}`);
  } else {
    result('CodeQL', 'WARN', 'default setup is not verifiable with current credentials');
  }

  const security = metadata.security_and_analysis;
  if (security) {
    for (const [key, label] of [['secret_scanning', 'Secret scanning'], ['secret_scanning_push_protection', 'Push protection']]) {
      const enabled = security[key]?.status === 'enabled';
      result(label, enabled ? 'PASS' : 'FAIL', security[key]?.status || 'unknown');
    }
  } else {
    result('Security analysis', 'WARN', 'not visible without authenticated repository admin access');
  }

  const manual = [
    'GitHub Apps are scoped to the transferred repository',
    'Cloudflare Workers Builds / Pages source access still works where applicable',
    'webhooks, environments, secrets and rulesets match the pre-transfer inventory',
    'local clones use the new origin URL',
  ];
  const lines = [
    `# Migration audit: ${target}`,
    '',
    '| Check | Status | Detail |',
    '| --- | --- | --- |',
    ...rows.map((row) => `| ${row.name} | ${row.status} | ${String(row.detail).replaceAll('|', '\\|')} |`),    '',
    '## Manual follow-up',
    ...manual.map((item) => `- [ ] ${item}`),
    '',
    token ? '_Authenticated audit._' : '_Public cross-repository audit. Run locally with `GH_TOKEN` for CodeQL default setup and admin-only security details._',
  ];
  const report = `${lines.join('\n')}\n`;
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  if (failed) process.exitCode = 1;
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 2;
});
