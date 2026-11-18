import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSkill } from '../build.mjs';

const built = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-build-'));
process.on('exit', () => fs.rmSync(built, { recursive: true, force: true }));

const sources = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(path.join(directory, entry.name)) : entry.name.endsWith('.mjs') ? [path.join(directory, entry.name)] : []);

test('build lists every hooks module the scripts import', () => {
  const skill = buildSkill(path.join(built, 'conductor'));
  const missing = [];
  for (const file of sources(path.join(skill, 'scripts'))) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\s*\()\s*['"](\.\.?\/[^'"]+)['"]/g)) {
      if (!fs.existsSync(path.resolve(path.dirname(file), match[1]))) missing.push(`${path.relative(skill, file)} imports ${match[1]}`);
    }
  }
  assert.deepEqual(missing, []);
  const core = fs.readdirSync(path.join(skill, 'scripts', 'core')).filter(name => name.endsWith('.mjs'));
  assert.ok(core.length > 0 && core.every(name => fs.existsSync(path.join(skill, 'scripts', 'core', name))));
});
