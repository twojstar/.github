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

---

## 💬 Quote from the drawer

<!-- markdownlint-disable MD033 -->
<!--STARTS_HERE_QUOTE_README-->
<i>❝The fact that keyboard have ‘Q’ ‘W’ ‘E’ ‘R’ ‘T’ ‘Y’ types of button: When keyboard was invented, it had buttons in alphabetical order, as a result, the typing speed was too fast and the computer used to hang. So, to reduce the speed of a person, qwerty keyboard were invented.❞</i>
<!--ENDS_HERE_QUOTE_README-->
<!-- markdownlint-enable MD033 -->

## 📰 Recently on the air

<!--README_FEED:START-->
- [Urban Word of the Day — Back when I lived in upstate new york](https://www.urbandictionary.com/define.php?term=Back%20when%20I%20lived%20in%20upstate%20new%20york&defid=5432275)
- [Urban Word of the Day — Salad Days](https://www.urbandictionary.com/define.php?term=Salad%20Days&defid=6122902)
- [Urban Word of the Day — grebo](https://www.urbandictionary.com/define.php?term=grebo&defid=1975218)
- [How to Engage with New Media: A Strategic Guide for Nonprofit Organizations](https://carnegieendowment.org/research/2026/08/how-to-engage-with-new-media-a-strategic-guide-for-nonprofit-organizations)
- [Urban Word of the Day — board chow](https://www.urbandictionary.com/define.php?term=board%20chow&defid=2568411)
- [BERDZENISHVILI MAMUKA - Gazeta Krakowska](https://news.google.com/atom/articles/CBMi0AFBVV95cUxQLV84Z0gzRmxEUHJWRjNpM2E5dlAzeENfcDBCTGtTU05kNDVhLUVZYzJHeFZSeGdYMkhra1FxRVJnaC1zMENSVmN1TW1lQmxFQ0owd3hUcmNWWnkwNkhyLTBtS1ItQnBQT3BEZFBzYUtTblRDZ2JTMWVMVzlqMzJMZFhzQ29Neml0dDJ3T0duRlZNa09SU3RUc29HSThGa3B2ZGJzUGlFMGtCejBKNnFYU2NHVzd6WTVxMTBSb3lsU2dpeTR5QWlnT243RWZHRVNz?oc=5)
<!--README_FEED:END-->
