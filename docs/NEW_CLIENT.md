# New client or demo

Two entry points share the same provisioning flow. Both are a **dry run** unless `--apply` is given
(the wizard asks for the mode and defaults to Dry Run).

## Interactive mode (wizard)

```bash
cd /home/jul/Workspace/mybizgate
./platform/bin/new-client.sh
```

```
========================================================
        MyBizgate - Multi Tenancy SaaS Wizard
========================================================
```

The wizard asks, in order:

1. **Project Type** - `[1] Client Website` (default) or `[2] Demo Website`.
2. **Client/Demo Information** - Business Name, then the slug (a kebab-case suggestion is shown; Enter accepts it).
3. **Available Business Types** - the first-level folders of `templates/`, shown as `[1] Automotive`, `[2] Beauty`, ...
4. **<Business Type> Templates** - the folders under the chosen type (`[1] Modern 01`, ...). The internal
   reference stays `pet-boarding/modern-01`; the display name comes from `template.yml` `name:` or the folder name.
5. **Domain** - clients choose a MyBizGate subdomain or custom domain. Demos use `<slug>.mybizgate.com` and skip
   the custom-domain questions.
6. **Business Information** - WhatsApp, Email, Address (required); Phone, Opening Hours, Facebook, Instagram,
   TikTok (optional, Enter to skip). WhatsApp is normalised to E.164 and every change is announced with `[INFO]`.
7. **Project Images** - optional folder of photos (`[INFO] No client image folder supplied.` when blank).
   Recorded as `assets.images_source` for the personalisation phase; nothing is copied yet.
8. **Mode** - `[1] Dry Run` (default) or `[2] Apply / Provision`.

Then the usual `[CHECK]` lines run (dependencies, environment, template, local folder, GitHub repository,
cPanel domain, hosting directory), the **NEW CLIENT SUMMARY** or **NEW DEMO SUMMARY** block and the `[PLAN]` are printed, and:

- Dry Run ends with `[DRY ] Dry run only. Nothing was created.`
- Apply asks `Proceed with provisioning? [y/N]:` - the default is **No**; only `y`/`yes` continues.

## CLI mode (automation)

```bash
./platform/bin/new-client.sh \
  --name "Paw Haven Cat Hotel" \
  --slug pawhaven \
  --template pet-boarding/modern-01 \
  --domain-type subdomain \
  --apply
```

Optional: `--whatsapp +60123456789 --email hello@pawhaven.com --address "Kuala Lumpur" --phone ... --opening-hours "..."
--facebook ... --instagram ... --tiktok ... --images /path/to/photos --project-type client|demo --visibility private|public --ftp-account dedicated|shared
--yes` (skip the confirmation) `--mock` (fake providers). `--template blank` creates the built-in coming-soon starter;
legacy demo names (`petgate`, ...) are still accepted but deprecated.

Demo project:

```bash
./platform/bin/new-client.sh --name "Paw Haven Demo" --slug pawhaven-demo --project-type demo \
  --template pet-boarding/modern-01 --apply
```

The demo convention is local folder `demo/demo-<slug>/`, GitHub repository `demo-<slug>` (public), a dedicated FTP account,
and deployment directory `public_html/demo/<slug>/`. The older Gate products remain independent repositories at
`public_html/site-<slug>/` and are not moved by this option.

Custom domain:

```bash
./platform/bin/new-client.sh --name "Paw Haven Cat Hotel" --slug pawhaven --template pet-boarding/modern-01 \
  --domain-type custom --domain pawhaven.com.my --dns-mode external --apply
```

## Template library

```
templates/<business-type>/<template>/      e.g. templates/pet-boarding/modern-01/
```

Templates are discovered from the filesystem every run. Adding `templates/pet-boarding/luxury-02/` makes
`Luxury 02` appear in the wizard immediately; `./platform/bin/mybizgate templates` lists everything with its status.

- **ready**: contains `index.html` (plus CSS/JS/images). It is copied into the selected client or demo project folder.
- **placeholder**: only `.gitkeep` (or empty). It can be selected and dry-run, with
  `[WARN] Template <ref> currently contains no website source files.`; in Apply mode provisioning stops
  *before* any GitHub, cPanel or Git resource is created:
  `Selected template is currently a placeholder template. Website source cannot be generated until the template is populated.`
- Optional `template.yml` (`name`, `version`, `description`, `id`, `category`) supplies the display name and the
  `template.version` recorded in `site.config.yml`.
- `template.yml`, `.gitkeep`, `README.md` and `preview.*` are never copied into a generated project.

## What `--apply` does (local first, remote after)

generate the project from the template → personalise every token with the business information → **residue
validation** (fails on leftover source branding or unfilled tokens) → Git (`main`, `deploy`) → **local production
build + QA** → GitHub repository (`client-<slug>` private or `demo-<slug>` public) → cPanel subdomain (or client staging +
custom domain) → dedicated generated-project FTP → GitHub variables/secrets → push → GitHub Actions deploy →
DNS, AutoSSL, HTTPS and health checks.

Nothing remote is created while local generation is invalid. Dry run already performs the generation and residue
scan in a temporary folder and reports `[ OK ] ... no template residue` or `[FAIL] Template personalisation incomplete`.

Preview a template for a client without provisioning:

```bash
./platform/bin/mybizgate render-template pet-boarding/modern-01 --out /tmp/pawhaven-preview \
  --name "Paw Haven Cat Hotel" --whatsapp +60123456789 --address "12 Jalan Ampang, 55100 Kuala Lumpur" \
  --email hello@pawhaven.com --instagram @pawhaven --build
```

## Platform release pinning

Every generated project workflow uses an explicit platform release:

```yaml
uses: mybizgate/mybizgate-platform/.github/workflows/static-site-deploy.yml@v1.3.0
with:
  platform_ref: v1.3.0
```

The same value is recorded as `platform_ref: v1.3.0` in `site.config.yml`. New projects default to the release of the
platform checkout that creates them (`mybizgate version`); override with `--platform-ref` or `MYBIZGATE_PLATFORM_REF`.
Existing projects are **never upgraded automatically**. To upgrade one deliberately:

```bash
./platform/bin/mybizgate platform-ref pawhaven                      # show the current pin
./platform/bin/mybizgate platform-ref pawhaven --set v1.3.0         # dry run: shows what would change
./platform/bin/mybizgate platform-ref pawhaven --set v1.3.0 --apply # rewrites the workflow + config, commits on main
cd clients/client-pawhaven && git push origin main                  # review, then release:
git checkout deploy && git merge --ff-only main && git push origin deploy
```

Roll back the same way with the previous tag. Clients created before v1.2.0 still follow `@main`; pin them with the
command above when convenient.

Apply verifies that the selected `platform_ref` exists in `mybizgate/mybizgate-platform` before creating the local
project or any remote resource. Publish and tag the platform release first; otherwise provisioning stops safely.

## Local-only input

The photos folder asked by the wizard (`--images`) is a machine path. It is written to the generated project's
`.mybizgate.local.yml`, which is gitignored and excluded from builds, so `site.config.yml`
stays portable and no local path ever reaches GitHub.

Before anything is created the command validates: local project folder free, GitHub repo free, domain free,
hosting directory free, template exists and is usable, environment (`CPANEL_TOKEN`) available, GitHub authentication available.

If a step fails the command stops and reports what exists. Fix the cause and continue with:

```bash
./platform/bin/mybizgate new-client --slug pawhaven --resume --apply
```

Progress is stored in the generated project's `.mybizgate/state.json` (ignored by Git). Nothing is deleted automatically.

Afterwards: edit on `main`, push, then `git checkout deploy && git merge --ff-only main && git push` to release.
