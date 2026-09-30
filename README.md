# hindidohe-feed

Public JSON feed for the HindiDohe app: https://knowsudhanshu.github.io/hindidohe-feed/dohe.json

A GitHub Actions workflow (every 6 hours, or **Actions → Update dohe from Facebook → Run workflow**)
reads the हिंदी दोहे Facebook Page through the Graph API (v26.0) and publishes `public/dohe.json`
to GitHub Pages. The app downloads this file and falls back to a bundled copy when offline.

**No Facebook token is in the app or in this repo.** The workflow uses a Meta Business
*system user* token stored as the encrypted secret `FB_SYSTEM_USER_TOKEN`.

## Secrets (Settings → Secrets and variables → Actions)
| Name | Required | What |
|---|---|---|
| `FB_SYSTEM_USER_TOKEN` | yes | Token of system user "HindiDohe Feed Bot" with only `pages_read_engagement` + `pages_read_user_content` |
| `FB_APP_SECRET` | optional | Adds `appsecret_proof` to every Graph call |

## Token renewal
Meta recommends 60-day system-user tokens. When the token expires the workflow run fails
(GitHub emails you) and the app keeps showing the last published dohe. Generate a new token and
update the secret.

## Local test
`npm test` (Node ≥ 20, no dependencies).
