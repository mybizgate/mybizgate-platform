# Recovery and rollback

Git is the source of truth. Every successful production deployment is tagged `prod-YYYYMMDD-HHMM-<sha>`
by the shared workflow. Migrations create `pre-platform-migration-YYYYMMDD-HHMM` tags.

```bash
./platform/bin/rollback.sh petgate              # plan: previous prod-* tag (dry run)
./platform/bin/rollback.sh petgate --apply      # new commit on deploy with that tree, push, redeploy, verify
./platform/bin/rollback.sh petgate --to pre-platform-migration-20261027-1530 --apply
```

The rollback never rewrites history: it creates a new commit on `deploy` whose tree equals the tag, pushes it,
and GitHub Actions redeploys. `main` is untouched; fix forward there and fast-forward `deploy` again.

Pre-migration workflows and deployment directories are recorded in `docs/migrations/`.

If a provisioning run stops midway, re-run with `--resume --apply`; completed steps are skipped and nothing is deleted.
To remove a client entirely (manual, deliberate): delete the GitHub repository, the cPanel subdomain/addon domain,
the FTP account and the hosting directory yourself. The tool does not delete these.
