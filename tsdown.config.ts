import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { defineConfig } from 'tsdown';

const sources = ['src', 'specs'].flatMap((root) =>
  readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((file) => `${root}/${file}`)
    .filter((file) => /\.(ts|mts|mjs|json)$/.test(file) && file !== 'src/core/version.json'),
).sort();
const hash = createHash('sha256');
for (const file of sources) hash.update(file).update('\0').update(readFileSync(file)).update('\0');
writeFileSync('src/core/version.json', `${JSON.stringify({ version: hash.digest('hex') })}\n`);

const testingHelpers = ['testing/git-env.ts', 'testing/sample-inputs.ts', 'testing/seam.ts'];
const entry = Object.fromEntries(
  ['src', 'specs']
    .flatMap((root) => readdirSync(root, { recursive: true, encoding: 'utf8' }).map((file) => `${root}/${file}`))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.mts'))
    .concat(testingHelpers)
    .map((file) => [file.slice(0, -'.ts'.length), file]),
);

export default defineConfig({
  entry,
  unbundle: true,
  format: 'esm',
  dts: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  copy: [
    { from: 'src/core/instances/base.json', to: 'dist/src/core/instances' },
    { from: ['src/core/launch.mjs', 'src/core/launch.d.mts', 'src/core/version.json'], to: 'dist/src/core' },
  ],
});
