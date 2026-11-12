import { LINEAR_KEY } from './core/ledger.mjs';
import { LINEAR_API, M_UPDATE, errorsOf, issueOf, linearKeyOf, stateFor, updatedOf } from './core/linear.mjs';

const READ_STATE = 'query ConductorIssueState($id: String!) { issue(id: $id) { id identifier state { name type } team { id key states { nodes { id name type position } } } } }';
const terminal = type => ['completed', 'canceled', 'duplicate'].includes(type);

/** Older Codex runs kept the issue key followed by source/context text. */
export function issueFromSource(source = '') {
  return linearKeyOf(source) ?? linearKeyOf(source.trim().split(/\s+/)[0] ?? '');
}

/** Compute lifecycle intent from persisted work, never from an agent's claim about Linear. */
export function refreshLinear(raw) {
  if (!raw.codex) return;
  const root = raw.run.issue ?? issueFromSource(raw.run.source);
  const previous = raw.codex.linear;
  const activated = raw.run.plan === 'approved' || previous?.activated === true;
  if (!activated) return;
  const desired = new Map();
  const groups = new Map();
  for (const task of raw.tasks) {
    if (typeof task.ticket !== 'string' || !LINEAR_KEY.test(task.ticket) || task.ticket === root) continue;
    const group = groups.get(task.ticket) ?? [];
    group.push(task);
    groups.set(task.ticket, group);
  }
  for (const [issue, tasks] of groups) {
    if (tasks.every(task => task.status === 'done')) desired.set(issue, 'completed');
    else if (tasks.some(task => task.startedAt || task.status !== 'queued')) desired.set(issue, 'started');
  }
  if (root && LINEAR_KEY.test(root)) {
    const unresolved = (raw.problems ?? []).some(problem => problem.status === 'open' && problem.severity !== 'note');
    const questions = (raw.posts ?? []).some(post => post.kind === 'question' && !post.answeredBy);
    const finished = raw.run.plan === 'approved' && raw.tasks.length > 0 && raw.tasks.every(task => task.status === 'done') && !raw.merge && !unresolved && !questions && !raw.run.lore;
    desired.set(root, finished ? 'completed' : 'started');
  }
  if (!desired.size && !previous) return;
  const issues = {};
  for (const [issue, target] of desired) {
    const was = previous?.issues?.[issue];
    issues[issue] = was?.target === target ? was : { target };
  }
  raw.codex.linear = { activated: true, issues };
}

export function pendingLinear(raw) {
  const pending = Object.entries(raw.codex?.linear?.issues ?? {}).filter(([, value]) => !value.confirmed);
  const root = raw.run.issue ?? issueFromSource(raw.run.source);
  return pending.map(([issue, value]) => ({
    issue, target: value.target,
    ...(value.warning ? { warning: value.warning } : {}),
    ...(issue === root && value.target === 'completed' && pending.some(([key]) => key !== root)
      ? { waitingFor: pending.filter(([key]) => key !== root).map(([key]) => key) } : {}),
  }));
}

/** Credentials stay in the request header; never include API error bodies in a ledger or result. */
export function linearApiFromEnvironment(env = process.env, send = globalThis.fetch) {
  const key = env.LINEAR_API_KEY?.trim();
  if (!key) return undefined;
  return async (query, variables) => {
    let response;
    try {
      response = await send(LINEAR_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: key },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10000),
      });
    } catch { throw new Error('Linear could not be reached; retry linear_sync.'); }
    if (!response.ok) throw new Error(`Linear returned HTTP ${response.status}; retry linear_sync after checking access.`);
    let json;
    try { json = await response.json(); } catch { throw new Error('Linear returned an unreadable response.'); }
    if (errorsOf(json)) throw new Error('Linear rejected the request; check access and retry linear_sync.');
    return json.data;
  };
}

/** A read before every retry avoids repeating a state write whose response was lost. */
export async function synchronizeLinear(raw, api, at) {
  refreshLinear(raw);
  const completed = [];
  if (api) {
    for (const { issue, target } of pendingLinear(raw)) {
      const entry = raw.codex.linear.issues[issue];
      if (pendingLinear(raw).find(one => one.issue === issue)?.waitingFor?.length) continue;
      try {
        const view = issueOf(await api(READ_STATE, { id: issue }));
        if (!view || view.key !== issue) throw new Error('Linear did not return the expected issue.');
        let observed = view.state.type;
        let changed = false;
        if (view.state.type !== target && !terminal(view.state.type)) {
          const stateId = stateFor(view.team.states, target);
          if (!stateId) throw new Error(`Linear team ${view.team.key} has no ${target} state.`);
          if (!updatedOf(await api(M_UPDATE, { id: view.id, input: { stateId } }))) throw new Error('Linear did not confirm the state change.');
          observed = target;
          changed = true;
        }
        // A completed/canceled/duplicate issue is deliberately not reopened.
        entry.confirmed = true;
        entry.confirmedAt = at;
        entry.observed = observed;
        delete entry.warning;
        completed.push({ issue, target, observed, changed });
      } catch {
        entry.warning = 'Linear state update was not confirmed; retry linear_sync or use the connected Linear plugin.';
      }
    }
  }
  return { transport: api ? 'api' : 'connector', updated: completed, pending: pendingLinear(raw) };
}

/** Connector acknowledgements are accepted only for the current persisted intent. */
export function acknowledgeLinear(raw, input, at) {
  refreshLinear(raw);
  const entry = raw.codex?.linear?.issues?.[input.issue];
  if (!entry || entry.target !== input.target) throw new Error('That Linear transition is no longer pending; read linear_sync again.');
  if (input.error === true) {
    entry.warning = 'The connected Linear plugin did not confirm the state change; retry linear_sync.';
    return;
  }
  if (pendingLinear(raw).find(one => one.issue === input.issue)?.waitingFor?.length) throw new Error('Confirm the linked task issue updates before completing their parent.');
  if (input.observed !== entry.target && !terminal(input.observed)) throw new Error('Acknowledge only the observed target state, or a terminal issue that must not be reopened.');
  entry.confirmed = true;
  entry.confirmedAt = at;
  entry.observed = input.observed;
  delete entry.warning;
}
