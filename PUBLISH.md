# Publishing @clenisa/optimal-cli to NPM

## Option 1: Login and Publish (Interactive)

```bash
cd /root/.openclaw/workspace/optimal-cli
npm login
# Follow prompts (username, password, 2FA)
npm publish --access public
```

## Option 2: Using Access Token (Automated)

1. Go to https://www.npmjs.com/settings/clenisa/tokens
2. Create "Automation" token
3. Add to `~/.npmrc`:

```bash
echo "//registry.npmjs.org/:_authToken=npm_YOUR_TOKEN_HERE" > ~/.npmrc
```

4. Then publish:

```bash
cd /root/.openclaw/workspace/optimal-cli
npm publish --access public
```

## Option 3: GitHub Actions (Recommended)

Add this `.github/workflows/publish.yml`:

```yaml
name: Publish to NPM
on:
  push:
    tags:
      - 'v*'
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'
      - run: pnpm install
      - run: pnpm build
      - run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Then add `NPM_TOKEN` secret in GitHub repo settings.

## Post-Publish Verification

```bash
# Check package
npm view @clenisa/optimal-cli

# Install globally
npm install -g @clenisa/optimal-cli

# Test
optimal --version
optimal config list
```