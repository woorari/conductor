// Proven callers. A run that is given --callers <dir> trusts only a caller whose token has a record there.
// The folder holds <sha256(token)>.json files. A token is 64 hex characters, it is never stored and never
// written in a message: it reaches a session through the launch environment (CONDUCTOR_TOKEN).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const KINDS = ['orchestrator', 'worker', 'decider', 'dispatcher'];
const TOKEN = /^[0-9a-f]{64}$/;
const hashOf = token => crypto.createHash('sha256').update(token).digest('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const text = value => typeof value === 'string' && value !== '';
const PERSON = /^[A-Za-z0-9_.-]{1,64}$/;

// Writes <sha256>.json (mode 0600, atomic) and returns the token.
export function issueCaller(dir, record) {
  if (!record || !KINDS.includes(record.kind)) throw new Error('A caller is an orchestrator, worker, decider or dispatcher.');
  if (!text(record.department)) throw new Error('A caller names its department.');
  if ((record.kind === 'orchestrator' || record.kind === 'worker') && !text(record.run)) throw new Error('An orchestrator or worker record names its run.');
  if (record.kind === 'worker' && !text(record.task)) throw new Error('A worker record names its task.');
  if (!(Date.parse(record.expiresAt) > 0)) throw new Error('A caller record has an expiry time (ISO 8601).');
  if (record.person !== undefined && (record.kind !== 'dispatcher' || typeof record.person !== 'string' || !PERSON.test(record.person))) throw new Error('Only a dispatcher record names a person, as 1-64 letters, digits, dots, hyphens or underscores.');
  const token = crypto.randomBytes(32).toString('hex');
  const sha256 = hashOf(token);
  const file = path.join(dir, `${sha256}.json`);
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temp, JSON.stringify({ ...record, sha256 }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return token;
}

// The callers folder is the run's trust root. It is named by realpath: a folder only its owner can write to.
// Returns { dir } (the real path) or { refused } with a reason that holds no token text.
export function callersFolder(dir) {
  let real;
  try { real = fs.realpathSync(dir); } catch { return { refused: 'The callers folder does not exist.' }; }
  let stat;
  try { stat = fs.statSync(real); } catch { return { refused: 'The callers folder cannot be read.' }; }
  if (!stat.isDirectory()) return { refused: 'The callers folder is not a folder.' };
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return { refused: 'The callers folder is not owned by the user running this call.' };
    if ((stat.mode & 0o022) !== 0) return { refused: 'The callers folder is writable by its group or by others; only its owner may write to it.' };
  }
  return { dir: real };
}

// The run's recorded folder (run.callers.dir) against the real path given now: true, or { refused } naming both.
export function callersBound(real, runCallers) {
  if (!runCallers) return true;
  if (!text(runCallers.dir)) return { refused: 'This run recorded no callers folder, so no callers folder is trusted for it.' };
  if (runCallers.dir !== real) return { refused: `This run trusts the callers folder ${runCallers.dir}, not ${real}.` };
  return true;
}

// The record the token proves, or { refused } with a reason that holds no token text.
export function resolveCaller(dir, token, now) {
  if (typeof token !== 'string' || !TOKEN.test(token)) return { refused: 'This call has no valid caller token (CONDUCTOR_TOKEN).' };
  const sha256 = hashOf(token);
  let record;
  try { record = JSON.parse(fs.readFileSync(path.join(dir, `${sha256}.json`), 'utf8')); }
  catch { return { refused: 'The caller token is not known to this run.' }; }
  if (!record || typeof record.sha256 !== 'string' || !same(record.sha256, sha256)) return { refused: 'The caller token is not known to this run.' };
  if (!KINDS.includes(record.kind) || !text(record.department)) return { refused: 'The caller record is malformed.' };
  if (!(Date.parse(record.expiresAt) > now.getTime())) return { refused: 'The caller token has expired.' };
  const { sha256: _hash, ...rest } = record;
  return rest;
}

export function revokeCaller(dir, token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) return;
  fs.rmSync(path.join(dir, `${hashOf(token)}.json`), { force: true });
}

// The command map: who may run what with a proven caller. Not listed: refused.
const OPEN = ['list', 'board', 'digest'];
const ORCHESTRATOR = ['init', 'conduct', 'board_open', 'board_close', 'task_add', 'task_update', 'run_plan', 'worktree', 'merge_check', 'merge', 'run_sync_base', 'run_check', 'handover', 'reconcile', 'board_post', 'board_rule', 'brief'];
const WORKER = ['task_update', 'board_post', 'brief', 'quarantine'];
const DECIDER = ['approve', 'approve_main', 'approve_merge', 'tier', 'model_policy'];
const WORKER_STATUS = ['review', 'blocked', 'failed'];
function who(command) {
  if (command.startsWith('problem_') || ORCHESTRATOR.includes(command)) return ['orchestrator', ...(WORKER.includes(command) ? ['worker'] : [])];
  if (WORKER.includes(command)) return ['worker'];
  // A dispatcher's approval is bound to a recorded person decision by a later task; here only kind, department and run are checked.
  if (DECIDER.includes(command)) return ['decider', 'dispatcher'];
  if (command === 'pause' || command === 'unpause') return ['decider', 'dispatcher'];
  // The run's orchestrator lands the run on the base under the plan's decision; a dispatcher may too, for a person's go-ahead.
  if (command === 'run_merge_main') return ['dispatcher'];
  if (command === 'merged') return ['dispatcher'];
  return [];
}

// proven: what resolveCaller returned, or null when the call has no --callers.
// ctx: { run, runCallers (the ledger's run.callers), input, callerFlag (the --caller option) }.
// Returns true, or { refused } with the reason.
export function callerMay(proven, command, ctx = {}) {
  const input = ctx.input ?? {};
  if (proven === null || proven === undefined) {
    if (OPEN.includes(command)) return true;
    return ctx.runCallers ? { refused: 'This run requires proven callers (--callers) for every call that is not a read.' } : true;
  }
  if (ctx.callerFlag !== undefined) return { refused: '--caller is not accepted with --callers; the caller is proven by CONDUCTOR_TOKEN.' };
  if (OPEN.includes(command)) return true;
  if (proven.refused) return { refused: proven.refused };
  const kinds = who(command);
  if (kinds.length === 0) return { refused: `Command ${command} is not open to any proven caller.` };
  if (!kinds.includes(proven.kind)) return { refused: `A ${proven.kind} may not run ${command}.` };
  if (command === 'init') return true;
  if (command === 'conduct') {
    if (input.id !== proven.run) return { refused: 'A run is started only by the orchestrator proven for that run id.' };
    if (!text(input.department)) return { refused: 'conduct with callers needs department in its input.' };
    if (input.department !== proven.department) return { refused: 'A caller starts runs only in its own department.' };
    return true;
  }
  if (!ctx.runCallers) return { refused: `Run ${ctx.run} was not created with callers.` };
  if (proven.department !== ctx.runCallers.department) return { refused: 'This caller belongs to another department.' };
  if (proven.run !== undefined && proven.run !== ctx.run) return { refused: 'This caller is proven for another run.' };
  if (proven.kind === 'worker') {
    if ((command === 'task_update' || command === 'brief') && input.task !== proven.task) return { refused: 'A worker uses only its own task.' };
    if (command === 'task_update' && input.status !== undefined && !WORKER_STATUS.includes(input.status)) return { refused: 'A worker sets its task to review, blocked or failed.' };
  }
  return true;
}

// The gates a recorded decision decides, and who may stand behind one: a decider as decider:<its department>, a dispatcher as person:<id> of the person its record names.
const GATES = ['approve', 'approve_main'];
// proven: what resolveCaller returned, or null. ctx: { input, runCallers }. Returns true, or { refused } with the reason.
// Without --callers nothing is required: the CI checks a hash or records a decision when one is given.
export function decisionMay(proven, command, ctx = {}) {
  if (!proven || proven.refused || !GATES.includes(command) || !['decider', 'dispatcher'].includes(proven.kind)) return true;
  const input = ctx.input ?? {};
  if (command === 'approve' && !text(input.planSha256)) return { refused: 'An approval by a proven caller names the plan hash it approves (planSha256).' };
  const decision = input.decision;
  if (!decision || typeof decision !== 'object' || Array.isArray(decision) || !text(decision.by) || !text(decision.ref)) return { refused: 'An approval by a proven caller carries a decision {by, ref}.' };
  if (proven.kind === 'decider') {
    if (decision.agent !== undefined && decision.agent !== proven.agent) return { refused: "A decider's decision names the agent its record names, or none." };
    const department = ctx.runCallers?.department;
    if (!text(department) || decision.by !== `decider:${department}`) return { refused: `A decider's decision is by decider:${department ?? '<department>'}.` };
  } else if (!text(proven.person) || decision.by !== `person:${proven.person}`) return { refused: "A dispatcher's decision is by the person its record names (person:<id>); this caller has none or another." };
  return true;
}

// The input with a proven decider's agent set from its record: that is the agent a decision records.
export function withAgent(proven, command, input) {
  if (!proven || proven.refused || proven.kind !== 'decider' || !GATES.includes(command) || !input?.decision || typeof input.decision !== 'object') return input;
  const { agent: _given, ...rest } = input.decision;
  return { ...input, decision: { ...rest, ...(text(proven.agent) ? { agent: proven.agent } : {}) } };
}

// The shape the command bodies already take.
export function legacyCaller(proven) {
  if (!proven || proven.refused) return { kind: 'stranger' };
  if (proven.kind === 'orchestrator') return { kind: 'orchestrator' };
  if (proven.kind === 'worker') return { kind: 'worker', taskId: proven.task };
  return { kind: 'owner' };
}

// What conduct records for a run made with callers: { department, dir (the real path of the callers folder) }, or { refused }.
export function runCallersOf(input, dir) {
  return text(input?.department) && text(dir) ? { department: input.department, dir } : { refused: 'conduct with callers needs department in its input.' };
}
