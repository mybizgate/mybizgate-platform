# Domain modes

| domain.type | dns_mode | Hosts | Notes |
| --- | --- | --- | --- |
| subdomain | – | `<slug>.<parent>` (client), `demo-<slug>.<parent>` (demo) | Created via cPanel API on the chosen parent domain; AutoSSL issues the certificate. |
| custom | awedns | `stg-<slug>.mybizgate.com` + custom domain | Domain is bound as an addon domain. The registrar must delegate to `ns1.awedns.com` / `ns2.awedns.com`; cPanel then manages DNS. |
| custom | external | `stg-<slug>.mybizgate.com` + custom domain | Domain is bound as an addon domain. The client keeps their DNS provider and only adds the A records from `dns-instructions.txt`. Nameservers, MX, SPF, DKIM, DMARC and other records are never touched. |

## Parent domains

`MYBIZGATE_BASE_DOMAINS` lists the parents offered by the wizard (default `mybizgate.com,niagova.com`).
`MYBIZGATE_BASE_DOMAIN` sets the default (first in the list otherwise). `MYBIZGATE_HOSTING_DOMAIN` is the cPanel
account's main domain (default `mybizgate.com`); FTP logins stay on it. The parent is not stored separately: it is
read from `domain.primary` in `site.config.yml`.

cPanel only writes DNS to its own zone, so a parent must be on the cPanel account and one of these must be true,
otherwise Apply stops before creating anything (Dry Run warns):

- its nameservers are `ns1.awedns.com` / `ns2.awedns.com` (DNS is automatic), or
- the new host already resolves to the server, through a wildcard `*.<parent>` or a per-site A record at its DNS provider.

`mybizgate doctor` reports this for every parent domain.

## Custom domains

Custom-domain clients always get staging first. Staging and production share the same hosting
directory (`public_html/clients/<slug>/`); staging builds are `noindex,nofollow`.
`site.environment` starts as `staging`; once DNS for the custom domain is verified the tool commits
`environment: production` and redeploys so canonical URLs and robots switch to the custom domain.

Regenerate instructions at any time: `./platform/bin/mybizgate dns-instructions <slug>`.
Resume after the client changes DNS: `./platform/bin/mybizgate new-client --slug <slug> --resume --apply`.

Status words used by the tool: `WAITING FOR DNS`, `DNS OK`, `DNS MISMATCH`, `WAITING FOR NAMESERVERS`,
`DELEGATION OK`, `SSL WAITING`, `HTTPS OK`.

Registrar APIs are not integrated; `src/dns.mjs` is the extension point for future providers.
