/**
 * What the Lore CLI (0.12) prints, read into values, and the ignore rules of
 * a `.loreignore`. Pure: the hooks module runs `lore` and hands its output here.
 *
 * Lore's output is read line by line and leniently: a line this version does
 * not know is skipped, and a required line that is missing answers undefined,
 * so a caller never acts on half a reading.
 */

/** A Lore revision: its 64-hex signature. Revision numbers count per branch, so the signature is what pins one. */
export const REVISION = /^[0-9a-f]{64}$/

const ZERO = /^0{64}$/

export type BranchInfo = {
  name: string
  id: string
  /** The branch's latest revision in this workspace; absent when it was never synced here. */
  latest?: string
  /** The branch's latest revision on the server; absent before its first push. */
  remoteLatest?: string
  parents: { branch: string; revision: string }[]
}

export type RepositoryInfo = {
  name: string
  /** `lores://host:port`, as `Remote URL` says; the clone URL is `${remote}/${name}`. */
  remote: string
  defaultBranch: string
}

export type LoreStatus = {
  branch: string
  revision: string
  isInSync: boolean
  untracked: string[]
  changed: string[]
  conflicts: string[]
  pendingMerge?: string
  isClean: boolean
}

export type MergeOutcome = { kind: 'merged'; revision: string } | { kind: 'conflict'; files: string[] } | { kind: 'failed'; reason: string }

export type PushOutcome =
  | { kind: 'pushed'; revision: string }
  | { kind: 'unchanged' }
  | { kind: 'refused'; reason: 'protected' | 'diverged' | 'other'; text: string }

const lines = (out: string): string[] => out.split(/\r?\n/)

const revision = (value: string | undefined): string | undefined => {
  const found = value?.trim()
  return found !== undefined && REVISION.test(found) && !ZERO.test(found) ? found : undefined
}

export function branchInfoOf(out: string): BranchInfo | undefined {
  let name: string | undefined
  let id: string | undefined
  let latest: string | undefined
  let remoteLatest: string | undefined
  const parents: { branch: string; revision: string }[] = []
  let inParents = false
  for (const line of lines(out)) {
    const head = /^Branch (\S.*)$/.exec(line)
    if (head !== null && name === undefined) {
      name = head[1].trim()
      continue
    }
    const field = /^\s+([A-Za-z ]+):\s*(.*)$/.exec(line)
    if (field !== null) {
      inParents = false
      const [, key, value] = field
      if (key === 'ID') id = value.trim()
      else if (key === 'Latest') latest = revision(value)
      else if (key === 'Remote Latest') remoteLatest = revision(value)
      else if (key === 'Parent') {
        inParents = true
        const parent = /^(\S+) at ([0-9a-f]{64})$/.exec(value.trim())
        if (parent !== null) parents.push({ branch: parent[1], revision: parent[2] })
      }
      continue
    }
    if (inParents) {
      const more = /^\s+(\S+) at ([0-9a-f]{64})\s*$/.exec(line)
      if (more !== null) parents.push({ branch: more[1], revision: more[2] })
      else inParents = false
    }
  }
  if (name === undefined || id === undefined) return undefined
  return { name, id, ...(latest === undefined ? {} : { latest }), ...(remoteLatest === undefined ? {} : { remoteLatest }), parents }
}

export function repositoryInfoOf(out: string): RepositoryInfo | undefined {
  let name: string | undefined
  let remote: string | undefined
  let defaultBranch: string | undefined
  for (const line of lines(out)) {
    const title = /^(\S+) \([0-9a-f]+\)$/.exec(line.trim())
    if (title !== null && name === undefined) name = title[1]
    const url = /^Remote URL:\s*(\S+)/.exec(line)
    if (url !== null) remote = url[1]
    const branch = /^Default branch:\s*(\S+)/.exec(line)
    if (branch !== null) defaultBranch = branch[1]
  }
  return name !== undefined && remote !== undefined && defaultBranch !== undefined ? { name, remote, defaultBranch } : undefined
}

/** A status entry, `A untracked.txt`, `M  a.txt (M)!`: its path. */
const entryPath = (line: string): string | undefined => /^[AMDRC?!]{1,2}\s+(.+?)(?:\s+\([A-Z?!]+\))?!?\s*$/.exec(line)?.[1]

export function statusOf(out: string): LoreStatus | undefined {
  let branch: string | undefined
  let current: string | undefined
  let isInSync = false
  let pendingMerge: string | undefined
  let hasSummary = false
  const untracked: string[] = []
  const changed: string[] = []
  const conflicts: string[] = []
  let section: 'untracked' | 'conflicts' | 'changed' | undefined
  for (const line of lines(out)) {
    const on = /^On branch (\S+) revision \d+ -> ([0-9a-f]{64})/.exec(line)
    if (on !== null) {
      branch = on[1]
      current = on[2]
      section = undefined
      continue
    }
    if (/^Local branch in sync with remote/.test(line)) isInSync = true
    const pending = /^Pending merge, incoming revision ([0-9a-f]{64})/.exec(line)
    if (pending !== null) pendingMerge = pending[1]
    if (/^Tracked changes:/.test(line)) hasSummary = true
    if (/^[A-Z][^:]*:\s*$/.test(line)) {
      section = /^Untracked/.test(line) ? 'untracked' : /conflict/i.test(line) ? 'conflicts' : 'changed'
      continue
    }
    if (section !== undefined) {
      const path = entryPath(line)
      if (path === undefined) {
        section = undefined
        continue
      }
      ;(section === 'untracked' ? untracked : section === 'conflicts' ? conflicts : changed).push(path)
    }
  }
  if (branch === undefined || current === undefined) return undefined
  const isClean = untracked.length === 0 && changed.length === 0 && conflicts.length === 0 && pendingMerge === undefined && !hasSummary
  return { branch, revision: current, isInSync, untracked, changed, conflicts, ...(pendingMerge === undefined ? {} : { pendingMerge }), isClean }
}

/** The line that says why a command failed: Lore's `[Error]` line, else the last line it printed. */
const failure = (exitCode: number, out: string): string => {
  const all = lines(out).map(line => line.trim()).filter(line => line !== '')
  const error = all.find(line => line.startsWith('[Error]'))
  return error?.replace(/^\[Error\]\s*/, '') ?? all.at(-1) ?? `lore exited ${exitCode}`
}

/** `lore branch merge` (which commits locally) and `lore branch merge into` (a merge on the server). A conflict exits 0. */
export function mergeOf(exitCode: number, out: string): MergeOutcome {
  const all = lines(out)
  const conflicted = Number(/(\d+) conflicted/.exec(out)?.[1] ?? '0')
  const listed = all.findIndex(line => /^Files in conflict:/.test(line))
  if (conflicted > 0 || listed >= 0) {
    const files: string[] = []
    for (const line of listed >= 0 ? all.slice(listed + 1) : []) {
      const path = line.trim()
      if (path === '' || path.startsWith('[')) break
      files.push(path)
    }
    return { kind: 'conflict', files }
  }
  if (exitCode !== 0) return { kind: 'failed', reason: failure(exitCode, out) }
  const committed = /Committed merged repository state \d+ -> ([0-9a-f]{64})/.exec(out)?.[1]
  const signed = /^Signature\s*:\s*([0-9a-f]{64})/m.exec(out)?.[1]
  const merged = committed ?? signed
  return merged === undefined ? { kind: 'failed', reason: `lore did not say what it merged: ${failure(exitCode, out)}` } : { kind: 'merged', revision: merged }
}

export function pushOf(exitCode: number, out: string): PushOutcome {
  if (exitCode === 0) {
    const pushed = /Pushed revision \d+ -> ([0-9a-f]{64})/.exec(out)?.[1]
    if (pushed !== undefined) return { kind: 'pushed', revision: pushed }
    if (/already pushed and at remote latest/.test(out)) return { kind: 'unchanged' }
    return { kind: 'refused', reason: 'other', text: failure(exitCode, out) }
  }
  const text = failure(exitCode, out)
  if (/Not authorized/i.test(out)) return { kind: 'refused', reason: 'protected', text }
  if (/diverged/i.test(out)) return { kind: 'refused', reason: 'diverged', text }
  return { kind: 'refused', reason: 'other', text }
}

/** One line of a `.loreignore`, ready to match. */
export type IgnoreRule = { regex: RegExp; isNegated: boolean; isDirOnly: boolean }

const glob = (pattern: string): string => {
  let out = ''
  for (let at = 0; at < pattern.length; at++) {
    const char = pattern[at]
    if (char === '*' && pattern[at + 1] === '*') {
      const before = at === 0 || pattern[at - 1] === '/'
      const after = pattern[at + 2] === '/' || at + 2 === pattern.length
      if (before && after) {
        if (pattern[at + 2] === '/') {
          out += '(?:.*/)?'
          at += 2
        } else {
          out += '.*'
          at += 1
        }
        continue
      }
      out += '[^/]*'
      at += 1
    } else if (char === '*') out += '[^/]*'
    else if (char === '?') out += '[^/]'
    else if (char === '[') {
      const close = pattern.indexOf(']', at + 1)
      if (close < 0) out += '\\['
      else {
        const inside = pattern.slice(at + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')
        out += `[${inside}]`
        at = close
      }
    } else out += char.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  return out
}

export function ignoreRules(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of lines(text)) {
    let line = raw.replace(/\s+$/, '')
    if (line === '' || line.startsWith('#')) continue
    const isNegated = line.startsWith('!')
    if (isNegated) line = line.slice(1)
    const isDirOnly = line.endsWith('/')
    if (isDirOnly) line = line.replace(/\/+$/, '')
    if (line === '') continue
    const isAnchored = line.includes('/')
    line = line.replace(/^\//, '')
    const body = glob(line)
    rules.push({ regex: new RegExp(isAnchored ? `^${body}$` : `(?:^|/)${body}$`), isNegated, isDirOnly })
  }
  return rules
}

/** What the last matching rule says of this one path, its parents aside. */
const own = (rules: readonly IgnoreRule[], path: string, isDir: boolean): boolean => {
  let ignored = false
  for (const rule of rules) {
    if (rule.isDirOnly && !isDir) continue
    if (rule.regex.test(path)) ignored = !rule.isNegated
  }
  return ignored
}

/** Whether a path (relative to the workspace root, `/`-separated) is ignored: by a rule of its own, or because a folder above it is. */
export function isIgnored(rules: readonly IgnoreRule[], path: string, isDir: boolean): boolean {
  const parts = path.replace(/^\/+|\/+$/g, '').split('/')
  for (let depth = 1; depth < parts.length; depth++) {
    if (own(rules, parts.slice(0, depth).join('/'), true)) return true
  }
  return own(rules, parts.join('/'), isDir)
}
