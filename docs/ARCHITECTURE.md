# Architecture

## Boundaries

```
/home/jul/Workspace/mybizgate/        workspace (NOT a Git repository)
├── platform/                          this repository: tooling only, no secrets
├── templates/<business-type>/<tpl>/   template library (reusable website products; discovered at runtime)
├── clients/client-<slug>/             one Git repository per real client
├── demo/demo-<slug>/                  one Git repository per generated demo
├── mybizgate-site/                    corporate website  -> public_html/
└── petgate|autogate|...               legacy Gate demos  -> public_html/site-<slug>/
```

The **slug** is the permanent identity of a client. Repository (`client-<slug>`), local folder
(`clients/client-<slug>`), hosting directory (`public_html/clients/<slug>/`), FTP account
(`deploy-<slug>@mybizgate.com`) and staging host (`stg-<slug>.mybizgate.com`) derive from it.
Changing the domain later never changes any of those.

Generated demos derive repository `demo-<slug>`, local folder `demo/demo-<slug>` and hosting directory
`public_html/demo/<slug>/` from the same slug. Legacy Gate demo repositories keep their existing `site-<slug>`
repository and `public_html/site-<slug>/` deployment conventions.

## Configuration

Every site repository has a `site.config.yml` (see `templates/static-site/site.config.example.yml`). It records the
template identity (`template.id` = `<business-type>/<template>`, `template.version` from `template.yml`) and the
`business` contact details collected by the wizard. Local-only input such as the client photos folder is written to
`.mybizgate.local.yml` (gitignored, excluded from builds), never to the committed config.
`src/config.mjs` validates it; the deployment-directory rules are enforced there and again in CI:

| site.kind | allowed deploy_dir | repository |
| --- | --- | --- |
| corporate | `public_html/` | only `mybizgate-site` |
| demo (generated) | `public_html/demo/<slug>/` | `demo-<slug>` |
| demo (legacy Gate) | `public_html/site-<slug>/` | `site-<slug>` |
| client | `public_html/clients/<slug>/` | `client-<slug>` |

Anything else (root, `..`, empty, other folders) is refused before FTP runs.

## Template personalisation (`src/personalize.mjs`)

Templates in `templates/<business-type>/<template>/` carry `{{TOKEN}}` placeholders (`{{BUSINESS_NAME}}`,
`{{SHORT_NAME}}`, `{{WHATSAPP}}`, `{{EMAIL}}`, `{{PHONE}}`, `{{ADDRESS}}`, `{{OPENING_HOURS}}`, `{{SEO_TITLE}}`,
`{{SEO_DESCRIPTION}}`, `{{FACEBOOK_URL}}`, ...; `{{KEY|js}}`, `{{KEY|url}}`, `{{KEY|raw}}` filters;
`{{#KEY}}...{{/KEY}}` conditional blocks). `template.yml` declares `required_content`, `defaults` (may reference
tokens) and `residue` (source-design strings that must not survive). Provisioning order, both modes:

project type -> template selection -> business information -> generate project source -> personalise -> residue validation
-> local production build -> local QA -> GitHub / cPanel / FTP -> GitHub deployment -> production health check.

Dry run performs the generation and residue scan in a temporary directory; Apply stops with
`[FAIL] Template personalisation incomplete` (file:line matches) before any remote resource exists.

## Build engine (`build/`)

`build-static-site.mjs <site> --out dist --version <sha>`:

1. Walk the source, skipping dev-only files (Git, workflows, README, config, logs, sync state).
   `.htaccess`, `robots.txt`, `sitemap.xml`, `site.webmanifest`, `favicon.ico`, `.well-known` are never excluded.
2. Convert JPG/JPEG/PNG photography to WebP (quality 82, max width 1920, auto-rotate, metadata stripped, never upscaled).
   Favicons, Apple touch icons, manifest icons, `og:image`/`twitter:image` targets and `build.images.preserve` patterns keep their format.
   If WebP is not smaller the original is kept.
3. Rewrite references to converted images in HTML/CSS/JS/manifest files (root-relative, `./`, `/` and file-relative forms).
4. Minify HTML (html-minifier-next, conservative whitespace, comments removed, inline CSS/JS minified, JSON-LD compacted, attributes untouched),
   CSS (Lightning CSS) and JS (Terser compress + mangle). Any minifier error fails the build.
5. Replace `__BUILD_VERSION__` with the short Git SHA in dist only.
   Every dist HTML document then gets exactly one `<meta name="build-version" content="<sha>">` inside `<head>`:
   inserted when the source has none, updated in place when it does, duplicates removed. Source files never need the tag;
   the post-deploy health check reads it to confirm which build is live.
6. Staging builds inject `<meta name="robots" content="noindex,nofollow">`, a `Disallow: /` robots.txt and staging canonical URLs. Production builds leave canonical/og:url exactly as authored.
7. Validate dist: `index.html` exists, every local reference resolves, documents are complete HTML, internal anchors exist.

## Deployment

Site repositories contain only the small caller workflow (`templates/static-site/.github/workflows/deploy.yml`).
It calls `mybizgate/mybizgate-platform/.github/workflows/static-site-deploy.yml@<platform_ref>` and passes the same
`platform_ref` to the build-engine checkout. New projects are pinned to the platform release they were created with
(`v1.3.0`, recorded as `platform_ref` in `site.config.yml`); nothing on platform `main` reaches a project until
`mybizgate platform-ref <slug> --set vX.Y.Z --apply` is run for it. The reusable workflow:

checkout site → checkout platform → Node 22 → `npm ci` (locked) → `resolve-target` (validates `site.config.yml`
and the `DEPLOY_DIR`/`SITE_DOMAIN`/`SITE_NAME` variables, refuses unsafe paths) → build `dist/` → QA →
optional Lighthouse / Playwright / screenshots (artifacts) → FTPS deploy of `./dist/` only
(`dangerous-clean-slate` is never enabled) → health check (HTTPS, status, identity, CSS, JS, image, build version) → `prod-YYYYMMDD-HHMM-<sha>` tag.

Generated clients and demos get a dedicated FTP account rooted at their own deployment directory; the FTP `server-dir`
is then `./`, so the account cannot write anywhere else. Legacy Gate demos and the corporate site use the shared deploy
credential with an explicit `server-dir`.
Corporate deployment protection treats both `public_html/clients/` and `public_html/demo/` as protected directories.

## Providers

- `src/cpanel.mjs` — `CPanelProvider` (UAPI first; the deprecated API 2 calls for addon domains and subdomain deletion are isolated here) and `MockCPanelProvider` for tests.
- `src/github.mjs` — `GitHubProvider` wraps `gh` with a dedicated `GH_CONFIG_DIR`; secrets go over stdin, never argv.
- `src/git.mjs`, `src/dns.mjs`, `src/ssl.mjs` — argument-array process execution, Node resolver, bounded polling.

## Safety

Dry run by default; `--apply` for changes; destructive actions require confirmation; secrets are redacted from all output;
no `eval`, no shell-string commands; TLS verification is never disabled.
