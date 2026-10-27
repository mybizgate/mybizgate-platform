# MyBizGate Platform

Provisioning, build, deployment and client-onboarding tooling for MyBizGate static websites.

```bash
cd /home/jul/Workspace/mybizgate
./platform/bin/mybizgate doctor          # check tools, auth, cPanel, DNS, AutoSSL
./platform/bin/mybizgate env             # show which env variables are set (names only)
./platform/bin/new-client.sh             # interactive wizard: MyBizgate - Multi Tenancy SaaS Wizard (asks Dry Run / Apply)
./platform/bin/new-client.sh --name "Paw Haven Cat Hotel" --slug pawhaven --template pet-boarding/modern-01 --domain-type subdomain --apply
./platform/bin/mybizgate templates       # list the template library (templates/<business-type>/<template>/)
./platform/bin/mybizgate render-template pet-boarding/modern-01 --out /tmp/preview --name "Paw Haven Cat Hotel" --whatsapp +60123456789 --address "Kuala Lumpur" --build
./platform/bin/mybizgate platform-ref pawhaven --set v1.2.0   # pin/upgrade a client to a platform release (dry run until --apply)
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
| `src/templates.mjs` | Template-library discovery (`<workspace>/templates/<business-type>/<template>/`, `template.yml`, placeholder detection) |
| `src/prompt.mjs` | Terminal prompt abstraction (real readline or scripted answers for tests) |
| `src/personalize.mjs` | Personalisation engine (`{{TOKEN}}` substitution, template defaults) and residue scanner |
| `.github/workflows/static-site-deploy.yml` | Reusable `workflow_call` deployment used by every site repository |
| `tests/` | Unit tests (`npm test`) and optional Playwright smoke tests (`tests/smoke`) |
| `docs/` | Architecture, new-client guide, domain modes, recovery, migration records |

## Setup

```bash
cd platform
npm run setup          # npm ci for the CLI and the build engine
npm test
```

Environment variables: `CPANEL_HOST`, `CPANEL_USER`, `CPANEL_TOKEN`, optional `FTP_SERVER`, `FTP_USERNAME`, `FTP_PASSWORD`, `GITHUB_OWNER`, `GITHUB_SSH_HOST`.

Put them in the workspace root `.env` (`/home/jul/Workspace/mybizgate/.env`, gitignored, never committed). Every
command and wrapper loads that file automatically, so `source .env` is not needed. POSIX (`KEY=value`,
`export KEY=value`) and Fish (`set -gx KEY "value"`) syntax are both accepted; `$HOME`-style references expand.
Variables already exported in the shell always take precedence over the file. Values are never printed.

```bash
./platform/bin/mybizgate env     # which variables are set and where they came from (names only)
MYBIZGATE_DOTENV=/other/.env ... # use a different file
MYBIZGATE_DOTENV=0 ...           # disable .env loading (CI, tests)
MYBIZGATE_DOTENV_TRACE=1 ...     # print the names loaded from .env
MYBIZGATE_WORKSPACE_DIR=/path    # force the workspace root (normally the parent of platform/)
```

GitHub CLI authentication for the MyBizGate account lives in its own config directory so the office identity is untouched:

```bash
GH_CONFIG_DIR=~/.config/gh-mybizgate gh auth login --hostname github.com --git-protocol ssh --scopes repo,workflow
```

(or export `MYBIZGATE_GH_TOKEN`).

## Template library

The reusable website products live outside this repository, at the workspace level:

```
/home/jul/Workspace/mybizgate/
├── platform/      automation engine (this repository)
├── templates/     reusable website templates: templates/<business-type>/<template>/
├── clients/       generated client projects (one Git repository each)
├── petgate/ ...   public demos / showcases (not templates)
└── mybizgate-site/
```

The wizard scans `templates/` every run: first-level folders are the business types (`pet-boarding` → "Pet Boarding"),
second-level folders are the templates (`modern-01` → "Modern 01", or `name:` from an optional `template.yml`).
Adding `templates/pet-boarding/luxury-02/` makes it appear in the wizard with no code change. A folder that only
holds `.gitkeep` is a placeholder: it can be selected and dry-run, but Apply stops before creating any resource.
`pet-boarding/modern-01` (Modern Pet Boarding v1.0.0) is the first real template: its `{{TOKEN}}` placeholders are
filled from the client information, a residue scan proves no source branding survived, and the local build + QA run
before any GitHub/cPanel resource is created. See `docs/NEW_CLIENT.md`.

## Rules

- Workspace root is not Git; every website and this platform are independent repositories.
- `main` = development, `deploy` = production. A push to `deploy` builds `dist/` and deploys it.
- Client workflows are pinned to a platform release (`@v1.2.0`), never to `main`; upgrade per client with `mybizgate platform-ref`.
- Local machine paths (client photo folders) live in `.mybizgate.local.yml` (gitignored), never in `site.config.yml`.
- Source stays readable; only `dist/` is minified/WebP-converted and it is never committed.
- Only `mybizgate-site` may deploy to `public_html/`; demos use `public_html/site-<slug>/`; clients use `public_html/clients/<slug>/`.
- Secrets live in the workspace root `.env` (gitignored, loaded automatically), the shell environment and GitHub Actions secrets; never in committed files.

See `docs/` for details.
