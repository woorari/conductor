import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { execFileSync } from 'node:child_process';

export const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = ['delivery', 'models', 'signals', 'ledger', 'lore', 'problems', 'plan', 'linear', 'router', 'posts', 'pause', 'store', 'board', 'merge', 'handover'];

export function checkRuntime(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 18)) throw new Error('Conductor requires Node.js 22.18 or newer.');
}

export function buildSkill(destination) {
  checkRuntime();
  const target = path.resolve(destination);
  if (fs.existsSync(target)) throw new Error(`Build destination already exists: ${target}`);
  fs.cpSync(path.join(repository, 'codex', 'skill'), target, { recursive: true });
  const core = path.join(target, 'scripts', 'core');
  fs.mkdirSync(core, { recursive: true });
  for (const name of modules) {
    const source = fs.readFileSync(path.join(repository, 'hooks', `${name}.ts`), 'utf8');
    const code = stripTypeScriptTypes(source, { mode: 'strip' }).replace(
      /(from\s+['"])(\.\.?\/[^'"]+)(['"])/g,
      (_, before, specifier, after) => `${before}${specifier}.mjs${after}`,
    );
    fs.writeFileSync(path.join(core, `${name}.mjs`), code);
  }
  fs.copyFileSync(path.join(repository, 'LICENSE'), path.join(core, 'LICENSE'));
  const manifest = JSON.parse(fs.readFileSync(path.join(repository, '.claude-plugin', 'plugin.json'), 'utf8'));
  let revision = 'source archive';
  try { revision = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Git metadata is optional for source archives. */ }
  fs.writeFileSync(path.join(core, 'provenance.json'), JSON.stringify({
    repository: manifest.repository,
    version: manifest.version,
    revision,
    adaptation: 'Built from hooks/*.ts in the same checkout. Types stripped and local imports given .mjs extensions. Claude runtime hooks are not included.',
  }, null, 2) + '\n');
  return target;
}
