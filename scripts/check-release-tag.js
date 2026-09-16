const path = require('node:path');

const packageJson = require(path.resolve(__dirname, '..', 'package.json'));
const tag = String(process.env.PROFILEDESK_RELEASE_TAG || '').trim();
const expected = `v${packageJson.version}`;

if (!tag) {
  process.stderr.write('PROFILEDESK_RELEASE_TAG is required.\n');
  process.exitCode = 1;
} else if (tag !== expected) {
  process.stderr.write(`Release tag ${tag} does not match package version ${expected}.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Release tag verified: ${tag}\n`);
}
