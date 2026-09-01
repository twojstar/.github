const fs = require('node:fs');

const target = process.env.TARGET_REPO || process.argv[2];
const legacyOwner = process.env.LEGACY_OWNER || 'trvny';
if (!target || !target.includes('/')) {
  console.error('Usage: TARGET_REPO=owner/repo node migration-audit.cjs');
  process.exit(2);
}
const [owner, repo] = target.split('/');
const ciCrossRepo = process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY !== target;
const token = ciCrossRepo ? '' : (process.env.AUDIT_GH_TOKEN || process.env.GH_TOKEN || '');
const headers = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'twojstar-migration-audit',
};
if (token) headers.Authorization = `Bearer ${token}`;

async function api(path, optional = false) {
  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (optional && (response.status === 401 || response.status === 403 || response.status === 404)) return null;
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

async function raw(path) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(defaultBranch)}/${path}`;
  const response = await fetch(url, { headers: { 'User-Agent': headers['User-Agent'] } });
  return response.ok ? response.text() : '';
}
let defaultBranch = 'main';
const rows = [];
let failed = false;
function result(name, status, detail) {
  rows.push({ name, status, detail });
  if (status === 'FAIL') failed = true;
}

(async () => {
  const metadata = await api(`/repos/${owner}/${repo}`);
  defaultBranch = metadata.default_branch;
  result('Repository', metadata.private ? 'WARN' : 'PASS', `${metadata.full_name} (${metadata.visibility})`);

  const tree = await api(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`);
  const paths = tree.tree.filter((entry) => entry.type === 'blob').map((entry) => entry.path);
  const readmes = paths.filter((path) => /(^|\/)README[^/]*\.md$/i.test(path));
  const legacyPattern = new RegExp(`(?:github\\.com|raw\\.githubusercontent\\.com|deepwiki\\.com|img\\.shields\\.io/github/license)/${legacyOwner}/${repo}`, 'i');
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
    const emptyEcosystem = /package-ecosystem:\s*["']?\s*["']?(?:#|\r?$)/m.test(config);
    result('Dependabot', emptyEcosystem ? 'FAIL' : 'PASS', emptyEcosystem ? 'placeholder package-ecosystem detected' : 'configuration present');
  }
  const rulesets = await api(`/repos/${owner}/${repo}/rulesets`, true) || [];
  let copilot = false;
  for (const item of rulesets) {
    if (item.enforcement !== 'active') continue;
    const detail = await api(`/repos/${owner}/${repo}/rulesets/${item.id}`, true);
    if (detail?.rules?.some((rule) => rule.type === 'copilot_code_review')) copilot = true;
  }
  result('Copilot auto-review', copilot ? 'PASS' : 'FAIL', copilot ? 'active ruleset found' : 'no active copilot_code_review ruleset');

  const codeqlWorkflow = paths.find((path) => /^\.github\/workflows\/.*codeql.*\.ya?ml$/i.test(path));
  let defaultSetup = null;
  if (token) defaultSetup = await api(`/repos/${owner}/${repo}/code-scanning/default-setup`, true);
  const codeqlConfigured = Boolean(codeqlWorkflow) || defaultSetup?.state === 'configured';
  if (codeqlConfigured) result('CodeQL', 'PASS', codeqlWorkflow || `default setup: ${(defaultSetup.languages || []).join(', ') || 'configured'}`);
  else result('CodeQL', token ? 'FAIL' : 'WARN', token ? 'not configured' : 'no committed workflow; rerun locally with GH_TOKEN to verify default setup');

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
    ...rows.map((row) => `| ${row.name} | ${row.status} | ${String(row.detail).replaceAll('|', '\\|')} |`),
    '',
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
