import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

async function files(dir) {
  return (await Promise.all((await readdir(dir, { withFileTypes: true })).map((entry) => entry.isDirectory() ? files(path.join(dir, entry.name)) : path.join(dir, entry.name)))).flat();
}
const sources = (await files('extension')).filter((file) => file.endsWith('.js'));
for (const source of sources) {
  const checked = spawnSync(process.execPath, ['--check', source], { encoding: 'utf8' });
  if (checked.status !== 0) { process.stderr.write(checked.stderr); process.exit(1); }
}
const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
for (const file of [manifest.background.service_worker, manifest.side_panel.default_path, manifest.options_page, ...manifest.content_scripts.flatMap((script) => script.js)]) await readFile(path.join('extension', file));
if (manifest.manifest_version !== 3) throw new Error('Manifest must use MV3');
console.log(`Verified ${sources.length} JavaScript files and all manifest entrypoints.`);
