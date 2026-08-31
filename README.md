# twojstar/.github

Organization control plane for **[twójstar](https://github.com/twojstar)**.

This repository keeps the public organization profile, fallback community-health files, and the small amount of automation that genuinely belongs at organization level.

## What lives here

| area | location | purpose |
| --- | --- | --- |
| organization profile | [`profile/README.md`](profile/README.md) | public front page for `github.com/twojstar` |
| community defaults | [`docs/`](docs/) and [`.github/`](.github/) | fallback conduct, contributing, security, issue and PR templates |
| organization upkeep | [`.github/workflows/upkeep.yml`](.github/workflows/upkeep.yml) | profile drawers and repository-scoped PR maintenance |

Repository-local configuration always wins over organization defaults.

## Upkeep

The profile sync is intentionally self-contained: it uses this repository's `GITHUB_TOKEN` to refresh the organization PR drawer and mirrors the maintained quote/news blocks from `trvny/trvny`.

Cross-repository PR maintenance is a separate layer. It uses a short-lived **GPTomek GitHub App** token and only sees repositories explicitly granted to the app installation. No hard-coded organization-wide repository list is required.

## Migration rule

Repositories move from `trvny/*` incrementally. The old location remains canonical until an actual GitHub transfer is complete; after a transfer, GitHub's repository redirect is relied on rather than maintaining duplicate repositories.
