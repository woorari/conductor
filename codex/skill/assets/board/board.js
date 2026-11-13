const $ = id => document.getElementById(id);
const token = location.hash.slice(1);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
let previous;
const taskStates = { queued: 'Queued', building: 'Building', returned: 'Handed back', review: 'In review', green: 'Ready to merge', done: 'Done', blocked: 'Blocked', failed: 'Failed' };
const reportAge = activity => activity.ageMinutes < 1 ? 'less than a minute ago' : `${activity.ageMinutes} min ago`;
function section(title, count) {
  const node = el('section'); const heading = el('h2', title);
  if (count !== undefined) heading.append(el('span', String(count), 'section-count'));
  node.append(heading); return node;
}
function row(item, kind = item.status) {
  const node = el('div', undefined, 'row'); node.append(el('span', undefined, `dot ${kind ?? ''}`));
  const content = el('div'); const title = el('p', undefined, 'row-title');
  title.append(el('span', item.id, 'row-id'), document.createTextNode(item.title ?? item.text));
  content.append(title); if (item.detail) content.append(el('p', item.detail, 'detail'));
  if (item.activity && !['done', 'queued'].includes(item.status)) content.append(el('p', `Last report ${reportAge(item.activity)} · ${item.activity.text}`, 'detail'));
  node.append(content); return node;
}
function notice(title, message, command, warn = false) {
  const node = el('div', undefined, `notice${warn ? ' warn' : ''}`); node.append(el('strong', title), el('p', message));
  if (command) {
    const button = el('button', 'Copy ' + command);
    button.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(command); button.textContent = 'Copied — send it in chat'; }
      catch { button.textContent = 'Send in chat: ' + command; }
    }); node.append(button);
  }
  return node;
}
function render(data) {
  document.title = `${data.run.id} · Conductor`;
  $('title').textContent = data.run.title; $('run-id').textContent = data.run.id;
  $('completed').textContent = data.completed; $('total').textContent = ` of ${data.total} done`;
  $('elapsed').textContent = data.elapsed ? `${data.elapsed} elapsed` : '';
  $('progress').setAttribute('aria-valuemax', String(data.total || 1)); $('progress').setAttribute('aria-valuenow', String(data.completed));
  $('progress').firstElementChild.style.width = `${data.total ? data.completed / data.total * 100 : 0}%`;
  const state = [];
  if (data.run.pausedAt) state.push(notice('Run paused', 'No new tasks start or merge while the run is on hold.', data.commands.unpause, true));
  if (data.run.plan === 'proposed') state.push(notice('Plan ready for your approval', 'Review the tasks and expected files below, then send the approval command in chat.', data.commands.approve));
  else if (data.run.plan === 'draft') state.push(notice('Drafting the plan', 'Tasks can still change. Work starts after the proposed plan is approved.'));
  if (!data.total) state.push(notice('Your board is ready', 'Tasks appear here as the plan takes shape.'));
  if (data.total && data.completed === data.total) state.push(notice(data.problems.length || data.questions.length || data.pending.length ? 'Tasks complete · follow-up remains' : 'All tasks complete', 'Final integration and ticket state are confirmed in chat.'));
  const latest = Object.values(data.groups).flat().filter(task => task.activity && !['done', 'queued'].includes(task.status)).sort((a, b) => Date.parse(b.activity.at) - Date.parse(a.activity.at))[0];
  if (latest) state.push(notice('Latest reported activity', `${latest.id} · ${latest.activity.text} · ${reportAge(latest.activity)}. Reports describe saved progress; worker liveness is checked by the orchestrator.`));
  $('state').replaceChildren(...state);
  const sections = [];
  if (data.problems.length) { const s = section('Problems', `${data.problems.length} open`); data.problems.forEach(p => s.append(row(p, p.severity))); sections.push(s); }
  if (data.questions.length) { const s = section('Questions', data.questions.length); data.questions.forEach(q => s.append(row({ ...q, detail: 'from ' + q.from }, 'warning'))); sections.push(s); }
  if (data.pending.length) { const s = section('Linear updates pending', data.pending.length); data.pending.forEach(p => s.append(row({ id: p.issue, text: `Move to ${p.target}`, detail: p.warning ?? (p.waitingFor?.length ? `Waiting for ${p.waitingFor.join(', ')}` : 'Waiting for synchronization') }, 'warning'))); sections.push(s); }
  for (const [key, label] of [['attention', 'Needs a decision'], ['building', 'Worker tasks'], ['returned', 'Handed back'], ['review', 'Awaiting orchestrator review / merge']]) {
    const tasks = data.groups[key]; if (!tasks.length) continue;
    const s = section(label, tasks.length); tasks.forEach(t => s.append(row(t))); sections.push(s);
  }
  if (data.timeline) {
    const s = section('Worker timeline'); const axis = el('div', undefined, 'axis');
    axis.append(el('span', new Date(data.timeline.startMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), el('span', 'now')); s.append(axis);
    const grid = el('div', undefined, 'timeline');
    for (const lane of data.timeline.lanes) {
      const label = el('span', lane.worker, 'lane-label'); label.title = lane.worker; grid.append(label);
      const track = el('div', undefined, 'lane');
      for (const at of [25, 50, 75, 100]) { const tick = el('span', undefined, 'tick'); tick.style.left = `${at}%`; tick.setAttribute('aria-hidden', 'true'); track.append(tick); }
      for (const bar of lane.bars) {
        const b = el('span', undefined, `bar ${bar.status}`); b.style.left = `${bar.from * 100}%`; b.style.width = `${(bar.to - bar.from) * 100}%`;
        b.title = `${bar.taskId}: ${taskStates[bar.status] ?? bar.status}`; b.setAttribute('role', 'img'); b.setAttribute('aria-label', b.title); b.tabIndex = 0; track.append(b);
      }
      grid.append(track);
    }
    const drawn = new Set(data.timeline.lanes.flatMap(lane => lane.bars.map(bar => bar.status)));
    const legend = el('ul', undefined, 'timeline-legend'); legend.setAttribute('aria-label', 'Timeline status legend');
    for (const [status, label] of Object.entries(taskStates)) {
      if (!drawn.has(status)) continue;
      const item = el('li'); const sample = el('span', undefined, `bar ${status}`); sample.setAttribute('aria-hidden', 'true'); item.append(sample, document.createTextNode(label)); legend.append(item);
    }
    s.append(grid, legend); if (data.timeline.hidden) s.append(el('p', `and ${data.timeline.hidden} earlier workers`, 'detail')); sections.push(s);
  }
  const queued = [...data.groups.next, ...data.groups.waiting];
  if (queued.length) {
    const s = section('Up next', `${queued.length} queued`); const chips = el('div', undefined, 'queue');
    for (const task of queued) { const chip = el('span', undefined, `chip${task.dependsOn.some(id => !data.groups.done.some(t => t.id === id) && !data.groups.review.some(t => t.id === id && t.status === 'green')) ? ' waiting' : ''}`); chip.title = `${task.title}\n${task.detail}`; chip.append(document.createTextNode(task.id + ' '), el('small', task.complexity)); chips.append(chip); }
    s.append(chips); sections.push(s);
  }
  if (data.host === 'claude' && queued.length) {
    const s = section('Model tier before a task starts', queued.length);
    if (!data.tierEditable) s.append(el('p', 'Open this run in Claude to change model tiers. The board still updates while Claude is disconnected.', 'detail'));
    for (const task of queued) {
      const label = el('label', undefined, 'model-picker'); label.append(el('span', task.id));
      const select = el('select'); select.setAttribute('aria-label', `Model tier for ${task.id}`);
      for (const tier of ['opus', 'sonnet', 'haiku']) { const option = el('option', tier); option.value = tier; select.append(option); }
      const action = data.actions?.filter(one => one.task === task.id).at(-1);
      select.value = action?.status === 'pending' ? action.tier : task.tier;
      select.disabled = !data.tierEditable || action?.status === 'pending';
      const status = el('span', action?.status === 'pending' ? 'Waiting for Claude…' : action?.message ?? '', 'detail'); status.setAttribute('role', 'status');
      select.addEventListener('change', async () => {
        select.disabled = true; status.textContent = 'Sending model choice…';
        try {
          const response = await fetch('/api/tier', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ task: task.id, tier: select.value }), signal: AbortSignal.timeout(5000) });
          const result = await response.json(); if (!response.ok) throw new Error(result.error);
          status.textContent = 'Waiting for Claude…';
        } catch (error) { status.textContent = error.message; select.value = task.tier; select.disabled = !data.tierEditable; }
      });
      label.append(select); s.append(label, status);
    }
    sections.push(s);
  }
  if (data.groups.done.length) {
    const s = el('details', undefined, 'done-list'); s.id = 'done-list'; s.open = $('done-list')?.open ?? false;
    s.append(el('summary', `Completed · ${data.groups.done.length}`)); data.groups.done.forEach(t => s.append(row(t))); sections.push(s);
  }
  if (data.rulings.length) { const s = section('Latest rulings', data.rulings.length); data.rulings.slice(-3).forEach(r => s.append(row(r))); sections.push(s); }
  $('sections').replaceChildren(...sections);
  const plan = [];
  if (data.planChecks.length) { const checks = section('Plan checks', data.planChecks.length); data.planChecks.forEach(text => checks.append(el('p', text, 'detail'))); plan.push(checks); }
  for (const task of Object.values(data.groups).flat()) {
    const node = el('div', undefined, 'plan-task'); node.append(el('p', `${task.id} · ${task.title}`), el('p', `${task.status} · ${task.complexity}${task.dependsOn.length ? ' · after ' + task.dependsOn.join(', ') : ''}`, 'detail'), el('p', task.files.join('\n') || 'No expected files recorded', 'files'));
    if (task.modelSelection) node.append(el('p', `Next worker: ${task.modelSelection.label}`, 'detail'));
    if (task.recordedModel) node.append(el('p', `Recorded worker: ${task.recordedModel}`, 'detail'));
    if (task.note) node.append(el('p', task.note, 'detail')); plan.push(node);
  }
  $('plan-body').replaceChildren(...plan); $('plan-count').textContent = `${data.total} tasks`;
  if (data.run.plan === 'proposed' && previous?.run.plan !== 'proposed') $('plan').open = true;
  $('updated').textContent = `Saved ${new Date(data.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  $('counts').textContent = `${data.findings} findings · ${data.rulings.length} rulings`;
  $('board').setAttribute('aria-busy', 'false'); previous = data;
}
async function poll() {
  try {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Reopen this board with $conductor board to restore access.');
    const response = await fetch('/api/board?offset=' + -new Date().getTimezoneOffset(), { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error);
    // Keep expanded sections, focus and scroll stable between saves.
    if (!previous || JSON.stringify({ ...data, elapsed: undefined, timeline: undefined }) !== JSON.stringify({ ...previous, elapsed: undefined, timeline: undefined }) || data.elapsed !== previous.elapsed) render(data);
    $('connection').textContent = 'Board connected'; $('connection').className = 'live'; $('error').hidden = true;
  } catch (error) {
    $('connection').textContent = 'Reconnecting'; $('connection').className = 'offline';
    $('error').textContent = `${error.message || 'Board disconnected.'} Last shown data may be out of date. Retrying…`; $('error').hidden = false;
  } finally { setTimeout(poll, 1500); }
}
poll();
