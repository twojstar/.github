# Repository migration helper

Use **Migration Audit** after moving a public repository from `trvny/*` to `twojstar/*`.

The workflow checks:

- README files for stale self-links to the old owner;
- presence of the repository Dependabot configuration, leaving schema validation to GitHub;
- an active GitHub Copilot automatic-review ruleset;
- security-analysis details when authenticated access is available.

The central workflow can always perform the public checks. For authenticated cross-repository checks, configure the optional `AUDIT_GH_TOKEN` repository secret with read access to the target repositories. GitHub App installations and Cloudflare account state remain explicit post-transfer checks because they are account-scoped integrations.

For a deeper local audit with the currently authenticated GitHub account:

```powershell
$env:GH_TOKEN = gh auth token
$env:TARGET_REPO = 'twojstar/wambridge'
$env:LEGACY_OWNER = 'trvny'
node .github/scripts/migration-audit.cjs
```

Post-transfer manual checks:

- confirm the repository is covered by the intended GitHub Apps;
- confirm CodeQL/code scanning has a successful run after transfer;
- verify Cloudflare Workers Builds / Pages where applicable;
- compare webhooks, environments, secrets and rulesets with the preflight inventory;
- update local Git remotes;
- run a harmless CI or deployment smoke test.
