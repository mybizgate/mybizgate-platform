# MyBizGate Platform

Provisioning, build, deployment and client-onboarding tooling for MyBizGate static websites.

```bash
cd /home/jul/Workspace/mybizgate
./platform/bin/mybizgate doctor          # check tools, auth, cPanel, DNS, AutoSSL
./platform/bin/new-client.sh             # interactive wizard (dry run until --apply)
./platform/bin/new-client.sh --name "Paw Haven Cat Hotel" --slug pawhaven --template petgate --domain-type subdomain --apply
./platform/bin/mybizgate build petgate   # optimised dist/ for any site
./platform/bin/site-status.sh pawhaven
./platform/bin/rollback.sh pawhaven      # roll deploy back to the previous prod-* tag
```

Everything that touches GitHub, cPanel, DNS or production is a **dry run unless `--apply` is passed**.

## Layout

| Path | Purpose |
| --- | --- |
| `bin/` | Thin Bash wrappers (`mybizgate`, `new-client.sh`, `migrate-site.sh`, `site-status.sh`, `rollback.sh`) |
| `src/` | Node.js 22 logic: CLI, config/validation, cPanel + GitHub providers, Git, DNS, SSL, hosting, provisioning, verification |
| `build/` | Shared build engine (html-minifier-next, Lightning CSS, Terser, sharp) with its own locked dependencies |
| `templates/static-site/` | Files added to every site: caller workflow, `.gitignore`, `site.config.example.yml`, README |
| `.github/workflows/static-site-deploy.yml` | Reusable `workflow_call` deployment used by every site repository |
| `tests/` | Unit tests (`npm test`) and optional Playwright smoke tests (`tests/smoke`) |
| `docs/` | Architecture, new-client guide, domain modes, recovery, migration records |

## Setup

```bash
cd platform
npm run setup          # npm ci for the CLI and the build engine
npm test
```

Environment (export in Fish; never commit): `CPANEL_HOST`, `CPANEL_USER`, `CPANEL_TOKEN`, optional `FTP_SERVER`, `FTP_USERNAME`, `FTP_PASSWORD`, `GITHUB_OWNER`, `GITHUB_SSH_HOST`.

GitHub CLI authentication for the MyBizGate account lives in its own config directory so the office identity is untouched:

```bash
GH_CONFIG_DIR=~/.config/gh-mybizgate gh auth login --hostname github.com --git-protocol ssh --scopes repo,workflow
```

(or export `MYBIZGATE_GH_TOKEN`).

## Rules

- Workspace root is not Git; every website and this platform are independent repositories.
- `main` = development, `deploy` = production. A push to `deploy` builds `dist/` and deploys it.
- Source stays readable; only `dist/` is minified/WebP-converted and it is never committed.
- Only `mybizgate-site` may deploy to `public_html/`; demos use `public_html/site-<slug>/`; clients use `public_html/clients/<slug>/`.
- Secrets live in the shell environment and GitHub Actions secrets, never in files.

See `docs/` for details.
