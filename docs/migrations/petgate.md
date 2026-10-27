# Pre-migration record: petgate

Date: 2026-10-27T08:03:30.273Z
Remote: git@github-mybizgate:mybizgate/site-petgate.git
Branch: deploy @ e3175f4c
Local branches: deploy
Remote branches: deploy
Deployment directory: public_html/site-petgate/
Recovery tag: pre-platform-migration-20261027-1603

## Previous workflow (.github/workflows/deploy.yml)

```yaml
name: Deploy PetGate Production

on:
  push:
    branches:
      - deploy

concurrency:
  group: petgate-production
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

      - name: Deploy PetGate via FTPS
        uses: SamKirkland/FTP-Deploy-Action@v4.4.0
        with:
          server: ${{ secrets.FTP_SERVER }}
          username: ${{ secrets.FTP_USERNAME }}
          password: ${{ secrets.FTP_PASSWORD }}
          protocol: ftps
          port: 21
          local-dir: ./
          server-dir: public_html/site-petgate/

          exclude: |
            **/.git*
            **/.git*/**
            **/.github/**
            **/node_modules/**
            README.md
            README.txt
            AGENTS.md
```
