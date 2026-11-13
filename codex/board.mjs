#!/usr/bin/env node
// Claude's entry to the same board package installed by the Codex adapter.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildSkill, repository } from './build.mjs';

const options = {};
const args = process.argv.slice(2);
while (args.length) { const key = args.shift(); if (!['--root', '--run', '--close'].includes(key) || !args.length) throw new Error('Use --root <project> --run <id> [--close true].'); options[key.slice(2)] = args.shift(); }
if (!options.root || !/^[A-Za-z0-9_-]{1,64}$/.test(options.run ?? '')) throw new Error('Give a project root and valid run id.');
const root = fs.realpathSync(options.root);
const run = path.join(root, '.claude/conductor/runs', options.run);
if (!fs.existsSync(path.join(run, 'ledger.json'))) throw new Error('No Claude run ledger exists.');
const hash = createHash('sha256');
for (const folder of ['hooks', 'codex/skill']) {
  const files = fs.readdirSync(path.join(repository, folder), { recursive: true }).filter(name => /\.(?:ts|mjs|js|html|css)$/.test(name)).sort();
  for (const file of files) hash.update(file).update(fs.readFileSync(path.join(repository, folder, file)));
}
const destination = path.join(run, `.html-runtime-${hash.digest('hex').slice(0, 16)}`);
if (!fs.existsSync(destination)) {
  const stage = fs.mkdtempSync(path.join(run, '.html-stage-'));
  const built = buildSkill(path.join(stage, 'conductor'));
  try { fs.renameSync(built, destination); }
  catch (error) { if (!fs.existsSync(destination)) throw error; /* Another launcher completed the same bundle. */ }
}
const { openBoard, closeBoard } = await import(pathToFileURL(path.join(destination, 'scripts/board-launcher.mjs')).href);
console.log(JSON.stringify(options.close ? await closeBoard(root, options.run, 'claude') : { boardView: await openBoard(root, options.run, 'claude') }));
