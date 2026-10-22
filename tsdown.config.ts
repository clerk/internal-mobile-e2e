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

const { exports: exportsMap } = JSON.parse(readFileSync('package.json', 'utf8')) as {
  exports: Record<string, { import: string }>;
};
const entry = Object.fromEntries(
  Object.values(exportsMap)
    .map((value) => value.import.replace('./dist/', '').replace(/\.js$/, ''))
    .filter((file) => !file.endsWith('.mjs'))
    .map((file) => [file, `${file}.ts`]),
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
