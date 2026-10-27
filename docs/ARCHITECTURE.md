# Architecture

## Boundaries

```
/home/jul/Workspace/mybizgate/        workspace (NOT a Git repository)
├── platform/                          this repository: tooling only, no secrets
├── clients/client-<slug>/             one Git repository per real client
├── mybizgate-site/                    corporate website  -> public_html/
└── petgate|autogate|...               demo/products      -> public_html/site-<slug>/
```

The **slug** is the permanent identity of a client. Repository (`client-<slug>`), local folder
(`clients/client-<slug>`), hosting directory (`public_html/clients/<slug>/`), FTP account
(`deploy-<slug>@mybizgate.com`) and staging host (`stg-<slug>.mybizgate.com`) derive from it.
Changing the domain later never changes any of those.

## Configuration

Every site repository has a `site.config.yml` (see `templates/static-site/site.config.example.yml`).
`src/config.mjs` validates it; the deployment-directory rules are enforced there and again in CI:

| site.kind | allowed deploy_dir | repository |
| --- | --- | --- |
| corporate | `public_html/` | only `mybizgate-site` |
| demo | `public_html/site-<slug>/` | `site-<slug>` |
| client | `public_html/clients/<slug>/` | `client-<slug>` |

Anything else (root, `..`, empty, other folders) is refused before FTP runs.

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
6. Staging builds inject `<meta name="robots" content="noindex,nofollow">`, a `Disallow: /` robots.txt and staging canonical URLs.
7. Validate dist: `index.html` exists, every local reference resolves, documents are complete HTML, internal anchors exist.

## Deployment

Site repositories contain only the small caller workflow (`templates/static-site/.github/workflows/deploy.yml`).
It calls `mybizgate/mybizgate-platform/.github/workflows/static-site-deploy.yml@main`, which:

checkout site → checkout platform → Node 22 → `npm ci` (locked) → `resolve-target` (validates `site.config.yml`
and the `DEPLOY_DIR`/`SITE_DOMAIN`/`SITE_NAME` variables, refuses unsafe paths) → build `dist/` → QA →
optional Lighthouse / Playwright / screenshots (artifacts) → FTPS deploy of `./dist/` only
(`dangerous-clean-slate` is never enabled) → health check (HTTPS, status, identity, CSS, JS, image, build version) → `prod-YYYYMMDD-HHMM-<sha>` tag.

Clients get a dedicated FTP account whose home is `public_html/clients/<slug>/`; the FTP `server-dir` is then `./`,
so the account itself cannot write anywhere else. Demo/corporate sites use the shared deploy credential with explicit `server-dir`.

## Providers

- `src/cpanel.mjs` — `CPanelProvider` (UAPI first; the deprecated API 2 calls for addon domains and subdomain deletion are isolated here) and `MockCPanelProvider` for tests.
- `src/github.mjs` — `GitHubProvider` wraps `gh` with a dedicated `GH_CONFIG_DIR`; secrets go over stdin, never argv.
- `src/git.mjs`, `src/dns.mjs`, `src/ssl.mjs` — argument-array process execution, Node resolver, bounded polling.

## Safety

Dry run by default; `--apply` for changes; destructive actions require confirmation; secrets are redacted from all output;
no `eval`, no shell-string commands; TLS verification is never disabled.
