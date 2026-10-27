# Domain modes

| domain.type | dns_mode | Hosts | Notes |
| --- | --- | --- | --- |
| subdomain | – | `<slug>.mybizgate.com` | Created via cPanel API, DNS is automatic, AutoSSL issues the certificate. |
| custom | awedns | `stg-<slug>.mybizgate.com` + custom domain | Domain is bound as an addon domain. The registrar must delegate to `ns1.awedns.com` / `ns2.awedns.com`; cPanel then manages DNS. |
| custom | external | `stg-<slug>.mybizgate.com` + custom domain | Domain is bound as an addon domain. The client keeps their DNS provider and only adds the A records from `dns-instructions.txt`. Nameservers, MX, SPF, DKIM, DMARC and other records are never touched. |

Custom-domain clients always get staging first. Staging and production share the same hosting
directory (`public_html/clients/<slug>/`); staging builds are `noindex,nofollow`.
`site.environment` starts as `staging`; once DNS for the custom domain is verified the tool commits
`environment: production` and redeploys so canonical URLs and robots switch to the custom domain.

Regenerate instructions at any time: `./platform/bin/mybizgate dns-instructions <slug>`.
Resume after the client changes DNS: `./platform/bin/mybizgate new-client --slug <slug> --resume --apply`.

Status words used by the tool: `WAITING FOR DNS`, `DNS OK`, `DNS MISMATCH`, `WAITING FOR NAMESERVERS`,
`DELEGATION OK`, `SSL WAITING`, `HTTPS OK`.

Registrar APIs are not integrated; `src/dns.mjs` is the extension point for future providers.
