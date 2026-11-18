#!/usr/bin/env node
// A fake `lore` program for node:test. It answers from a JSON table and appends every call to a log.
//   FAKE_LORE_TABLE  path of a JSON file: a list of rows { match, exit?, exits?, out?, err?, answers? }
//   FAKE_LORE_LOG    path of the log: one JSON line { args, cwd, row } per call
// `match` is the call's arguments (after --non-interactive) joined by spaces; a row answers a call whose
// arguments equal it or continue it after a space. The first row that matches answers. `answers` is a list
// of outputs given one per call of that row, the last one again and again; `exits` is the same for exit codes.
import fs from 'node:fs';

const argv = process.argv.slice(2);
const args = argv[0] === '--non-interactive' ? argv.slice(1) : argv;
const key = args.join(' ');
const table = JSON.parse(fs.readFileSync(process.env.FAKE_LORE_TABLE, 'utf8'));
const row = table.findIndex(one => key === one.match || key.startsWith(`${one.match} `));
const log = process.env.FAKE_LORE_LOG;
let earlier = 0;
if (log && fs.existsSync(log)) {
  earlier = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).filter(line => JSON.parse(line).row === row).length;
}
if (log) fs.appendFileSync(log, `${JSON.stringify({ args, cwd: process.cwd(), row })}\n`);
if (row === -1) {
  process.stderr.write(`fake lore: no answer for "${key}"\n`);
  process.exit(2);
}
const answer = table[row];
const out = answer.answers ? answer.answers[Math.min(earlier, answer.answers.length - 1)] : (answer.out ?? '');
process.stdout.write(out);
if (answer.err) process.stderr.write(answer.err);
const at = Math.min(earlier, (answer.exits?.length ?? 1) - 1);
process.exit(answer.exits ? answer.exits[at] : (answer.exit ?? 0));
