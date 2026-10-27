# Inventory report (2026-10-27, before migration)

## Workspace

- Root `/home/jul/Workspace/mybizgate/` is not a Git repository (kept that way).
- `mybizgate-site/` — Git, remote `git@github-mybizgate:mybizgate/mybizgate-site.git`, branches `main`, `deploy` (deploy is 1 commit ahead of main), clean, HEAD `b6b0f0b`. Workflow `.github/workflows/deploy.yml`: FTPS deploy of `./` to `public_html/` with sed cache busting. Live title "MyBizGate | Websites & Business Systems for Malaysian SMEs".
- `petgate/` — Git, remote `git@github-mybizgate:mybizgate/site-petgate.git`, branch `deploy` only (no `main`), clean, HEAD `e3175f4c` (= live build-version). Workflow deploys `./` to `public_html/site-petgate/`. 16 JPG photos (1.4 MB) + 13 WebP.
- `autogate/`, `beautygate/`, `dentalgate/`, `supplygate/` — plain folders, not Git repositories, no workflows.
- Both GitHub repositories are public; `mybizgate` is a GitHub **user** account (not an organisation).
- Local Git identity in the two repos: `mybizgate <mybizgateway@gmail.com>`; global identity belongs to the office account and was not changed.

## Tooling

- Node v24.18.0 (platform requires >= 22; CI uses 22), npm 11.16, git 2.43, curl, jq 1.7, ssh, python3.
- `gh` was missing; installed GitHub CLI 2.103.3 into `~/.local/bin/gh` (checksum verified). `dig` is missing; the platform uses Node's resolver.
- `ssh -T git@github-mybizgate` authenticates as `mybizgate` (key `~/.ssh/id_ed25519_github_mybizgate`).
- The default `gh` config is logged in as the office account (read-only on mybizgate repos). The MyBizGate account is **not yet authenticated** in `GH_CONFIG_DIR=~/.config/gh-mybizgate` — required for repo creation, variables and secrets.

## cPanel / hosting

- `CPANEL_HOST`, `CPANEL_USER`, `CPANEL_TOKEN` are exported in the shell (Fish `.env`). API-token auth on port 2083 works.
- Domains: main `mybizgate.com`; subdomains petgate, supplygate, beautygate, dentalgate, autogate (`public_html/site-*`). No addon domains. `api-test.mybizgate.com` no longer exists, but `public_html/clients/api-test/` is left over (not deleted; remove manually if unwanted).
- `public_html/` contains the corporate site files plus `site-*`, `clients/`, `assets/`, `cgi-bin/`, `.well-known/`, a server-managed `.htaccess`, `.user.ini`, `php.ini`, and FTP-Deploy sync-state files in `public_html/` and `public_html/site-petgate/`.
- FTP accounts: main, `deploy@mybizgate.com` (home `public_html`, the shared deploy credential used by GitHub secrets), logs.
- AutoSSL: `mybizgate.com` covered until 2027-01-22; one standing problem: wildcard `*.mybizgate.com` DNS DCV (harmless for named subdomains).
- DNS: `mybizgate.com` and `petgate.mybizgate.com` -> 101.99.77.149; nameservers ns1/ns2.awedns.com.
