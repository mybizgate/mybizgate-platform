# New client

```bash
cd /home/jul/Workspace/mybizgate
./platform/bin/mybizgate doctor
./platform/bin/new-client.sh                 # wizard, shows the plan (dry run)
./platform/bin/new-client.sh --name "Paw Haven Cat Hotel" --slug pawhaven --template petgate --domain-type subdomain --apply
```

Custom domain:

```bash
./platform/bin/new-client.sh --name "Paw Haven Cat Hotel" --slug pawhaven --template petgate \
  --domain-type custom --domain pawhaven.com.my --dns-mode external --apply
```

What happens with `--apply`: project folder from the template → `site.config.yml` → Git (`main`, `deploy`) →
GitHub repo `client-<slug>` → cPanel subdomain (or staging + custom domain) → dedicated FTP account →
GitHub variables/secrets → local build + QA → push → GitHub Actions deploy → DNS, AutoSSL, HTTPS and health checks.

If a step fails the command stops and reports what exists. Fix the cause and continue with:

```bash
./platform/bin/mybizgate new-client --slug pawhaven --resume --apply
```

Progress is stored in `clients/client-<slug>/.mybizgate/state.json` (ignored by Git). Nothing is deleted automatically.

Afterwards: edit on `main`, push, then `git checkout deploy && git merge --ff-only main && git push` to release.
