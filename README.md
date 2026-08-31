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
<i>❝“On two occasions I have been asked, ‘If you put into the machine wrong figures, will the right answers come out?’  I am not able rightly to apprehend the kind of confusion of ideas that could provoke such a question.”— Charles Babbage❞</i>
<!--ENDS_HERE_QUOTE_README-->
<!-- markdownlint-enable MD033 -->

## 📰 Recently on the air

<!--README_FEED:START-->
- [Urban Word of the Day — Salad Days](https://www.urbandictionary.com/define.php?term=Salad%20Days&defid=6122902)
- [Urban Word of the Day — grebo](https://www.urbandictionary.com/define.php?term=grebo&defid=1975218)
- [How to Engage with New Media: A Strategic Guide for Nonprofit Organizations](https://carnegieendowment.org/research/2026/08/how-to-engage-with-new-media-a-strategic-guide-for-nonprofit-organizations)
- [Urban Word of the Day — board chow](https://www.urbandictionary.com/define.php?term=board%20chow&defid=2568411)
- [100 lat na straży! - malopolska.pl](https://news.google.com/atom/articles/CBMickFVX3lxTFBxWXFKbUs0MnJrS3B0V3hET1VNVHRjLXc5RGFEM0ZZdlJoMlhrbjFJeExPNU5pQ2lvdHNfTHRUVG5pV0Z2RzA0Z3lZM1lPWDgzMEswbFdvVXM2RnoydFV2VjdIb05KZk0xbHJEcjNKSDhTdw?oc=5)
- [Nowy rozkład jazdy PKP od 30 sierpnia. Zmiany także na trasie przez Krzeszowice, Trzebinię i Chrzanów - Przelom.pl - portal ziemi chrzanowskiej](https://news.google.com/atom/articles/CBMijwFBVV95cUxQV254VnUyMEllanZ3RFh5YUZEOVlaRDQxREg1SE1wLWtIWmV5cnYwQ2F1UlFXMmk3dmhzQ0NOV2NqQWxpV3h0WVV2ajJuUGYzTnIxWEJEMkY5bk9aTHlWMVpac0djYVM2Q0pHSmlOeHJKWS1nQ19DZG43TzVXVzFaZ191cXl4S0NqZkFmdkt0TQ?oc=5)
<!--README_FEED:END-->
