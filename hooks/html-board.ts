import type { EngineInterface } from 'claude-code'

export type HtmlBoard = { runId: string; url?: string; error?: string }
export type HtmlAction = { id: string; task: string; tier: 'opus' | 'sonnet' | 'haiku' }

/** Only a token-bearing loopback URL from our local launcher is ever used by the bridge. */
export function boardAddress(url: string): { base: string; token: string } | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || !/^[a-f0-9]{64}$/.test(parsed.hash.slice(1))) return undefined
    return { base: parsed.origin, token: parsed.hash.slice(1) }
  } catch { return undefined }
}

export async function launchHtmlBoard($: EngineInterface, root: string, runId: string): Promise<HtmlBoard> {
  try {
    const result = await $.process.run(['node', `${$.plugin.root}/codex/board.mjs`, '--root', root, '--run', runId], { timeoutMs: 20000 })
    if (result.exitCode !== 0) return { runId, error: 'The HTML board needs Node.js 22.18 or newer. The native board and model pickers remain available.' }
    const url = JSON.parse(result.stdout).boardView?.url
    if (typeof url !== 'string' || !boardAddress(url)) throw new Error('Invalid local board address')
    return { runId, url }
  } catch { return { runId, error: 'The HTML board could not open. Use /board html to retry; the native board and model pickers remain available.' } }
}

export async function boardRequest($: EngineInterface, url: string, route: string, body?: unknown): Promise<unknown> {
  const address = boardAddress(url)
  if (!address || !/^\/api\/actions(?:\/[a-f0-9]{24})?$/.test(route)) throw new Error('Invalid board bridge request')
  const response = await Promise.race([
    $.http.fetch(`${address.base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${address.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    $.clock.sleep(3000).then(() => { throw new Error('Board bridge timed out') }),
  ])
  if (response.status !== 200) throw new Error('Board bridge unavailable')
  return JSON.parse(response.text)
}

export function htmlActions(value: unknown): HtmlAction[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 64).filter((one): one is HtmlAction => one !== null && typeof one === 'object' && /^[a-f0-9]{24}$/.test(one.id) && /^[A-Za-z0-9_-]{1,64}$/.test(one.task) && ['opus', 'sonnet', 'haiku'].includes(one.tier))
}
