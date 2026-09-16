const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

test('release tag must match the package version', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const script = path.join(root, 'scripts/check-release-tag.js');
  const valid = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PROFILEDESK_RELEASE_TAG: `v${packageJson.version}` },
  });
  const invalid = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PROFILEDESK_RELEASE_TAG: 'v999.0.0' },
  });
  assert.equal(valid.status, 0);
  assert.match(valid.stdout, /Release tag verified/);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /does not match package version/);
});

test('tag builds publish four desktop packages through a draft release', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/build-desktop.yml'), 'utf8');
  assert.match(workflow, /name: Publish GitHub Release/);
  assert.match(workflow, /if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(workflow, /needs: build/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /actions\/download-artifact@v5/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /--draft/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /gh release edit "\$tag" --repo "\$GITHUB_REPOSITORY" --draft=false --latest/);
});
