# Pre-migration record: mybizgate-site

Date: 2026-10-27T08:10:18.686Z
Remote: git@github-mybizgate:mybizgate/mybizgate-site.git
Branch: deploy @ b6b0f0bf
Local branches: deploy, main
Remote branches: deploy, main
Deployment directory: public_html/
Recovery tag: pre-platform-migration-20261027-1610

## Previous workflow (.github/workflows/deploy.yml)

```yaml
name: Deploy MyBizGate Production

on:
  push:
    branches:
      - deploy

concurrency:
  group: mybizgate-production
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Add cache busting version
        run: |
          VERSION="${GITHUB_SHA::8}"
          echo "Deploy version: $VERSION"
          sed -i "s/__BUILD_VERSION__/$VERSION/g" index.html

      - name: Deploy MyBizGate via FTPS
        uses: SamKirkland/FTP-Deploy-Action@v4.4.0
        with:
          server: ${{ secrets.FTP_SERVER }}
          username: ${{ secrets.FTP_USERNAME }}
          password: ${{ secrets.FTP_PASSWORD }}
          protocol: ftps
          port: 21
          local-dir: ./
          server-dir: public_html/

          exclude: |
            **/.git*
            **/.git*/**
            **/.github/**
            **/node_modules/**
            README.md
            README.txt
            AGENTS.md
```
