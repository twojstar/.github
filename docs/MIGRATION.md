# Repository migration helper

Use **Migration Audit** after moving a public repository from `trvny/*` to `twojstar/*`.

The workflow checks:

- README files for stale self-links to the old owner;
- a real Dependabot configuration, not an empty template;
- an active GitHub Copilot automatic-review ruleset;
- CodeQL through a committed workflow when publicly visible;
- security-analysis details when authenticated access is available.

The central workflow intentionally does not claim to verify GitHub App installations or Cloudflare account state. Those are account-scoped integrations and remain explicit post-transfer checks.

For a deeper local audit with the currently authenticated GitHub account:

```powershell
$env:GH_TOKEN = gh auth token
$env:TARGET_REPO = 'twojstar/wambridge'
$env:LEGACY_OWNER = 'trvny'
node .github/scripts/migration-audit.cjs
```

Post-transfer manual checks:

- grant the repository to the selected GitHub Apps;
- verify Cloudflare Workers Builds / Pages where applicable;
- compare webhooks, environments, secrets and rulesets with the preflight inventory;
- update local Git remotes;
- run a harmless CI or deployment smoke test.
