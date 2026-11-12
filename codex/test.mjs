#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tests');
const tests = fs.readdirSync(directory).filter(name => name.endsWith('.test.mjs')).sort().map(name => path.join(directory, name));
const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
