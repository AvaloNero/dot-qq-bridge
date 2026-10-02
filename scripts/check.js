import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['src', 'scripts', 'test'];
const files = roots.flatMap(root => fs.readdirSync(root, { recursive: true }).filter(file => file.endsWith('.js')).map(file => path.join(root, file)));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1); }
}
process.stdout.write(`Syntax checked ${files.length} JavaScript files.\n`);
for (const file of ['package.json', 'plugin/plugin.json', 'plugin/mcp.json']) JSON.parse(fs.readFileSync(file, 'utf8'));
process.stdout.write('Parsed package and plugin template JSON. Remote plugin installation remains unverified.\n');
