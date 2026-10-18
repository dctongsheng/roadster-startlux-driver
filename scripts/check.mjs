import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
for (const file of [manifest.background.service_worker, manifest.action.default_popup, 'facts.js', 'bridge.js', 'page-panel.js', 'popup.css']) await readFile(`extension/${file}`);
for (const file of await readdir('extension')) {
  if (!/\.(mjs|js)$/.test(file)) continue;
  const check = spawnSync(process.execPath, ['--check', `extension/${file}`], { encoding: 'utf8' });
  if (check.status !== 0) throw new Error(check.stderr);
}
console.log('Manifest references and JavaScript syntax verified.');
