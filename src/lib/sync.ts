/**
 * Keeping the cards in step across browsers, through a secret GitHub Gist.
 *
 * Everything else here lives in one browser's IndexedDB, which belongs to one
 * site address in one browser on one device. Open the page anywhere else and
 * the collection is not there, which read to the owner as the cards having
 * been lost. The site is static, so there is no server of ours to hold a copy;
 * a gist in the owner's own GitHub account is the one store that needs no
 * backend, answers CORS from a browser, and is theirs rather than ours.
 *
 * The token is kept in this browser's localStorage, like the Parse key, and is
 * sent only to api.github.com. The Parse key is never written into the gist:
 * it lives outside the persisted state, so it cannot ride along by accident.
 *
 * A secret gist is unlisted and unsearchable but readable by anyone holding
 * its URL. The UI says so rather than calling it private.
 */

const API = 'https://api.github.com'
const TOKEN_STORAGE = 'aa-tcg.syncToken'
const GIST_ID_STORAGE = 'aa-tcg.syncGistId'
/** The `savedAt` of the copy this browser and the gist last agreed on. */
const SYNCED_AT_STORAGE = 'aa-tcg.syncedAt'
/** When this browser last changed something the gist has not yet received. */
const DIRTY_AT_STORAGE = 'aa-tcg.syncDirtyAt'

export const GIST_FILE = 'advanced-analytics-tcg.json'
const GIST_DESCRIPTION = 'Advanced Analytics TCG — saved cards (written by the app; do not edit)'
export const BACKUP_APP = 'advanced-analytics-tcg'
export const BACKUP_VERSION = 1

/** A creation link with only the `gist` scope ticked, so nothing broader is granted. */
export const TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=gist&description=Advanced%20Analytics%20TCG%20sync'

/** What goes into the gist and into a backup file: the same shape for both. */
export interface Envelope<S> {
  app: typeof BACKUP_APP
  version: number
  savedAt: string
  state: S
}

export function makeEnvelope<S>(state: S, savedAt = new Date().toISOString()): Envelope<S> {
  return { app: BACKUP_APP, version: BACKUP_VERSION, savedAt, state }
}

/** Reads an envelope from text, or says plainly why it is not one. */
export function readEnvelope<S>(text: string): Envelope<S> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('That file is not a backup from this app — it is not readable JSON.')
  }
  const e = parsed as Partial<Envelope<S>> | null
  if (!e || e.app !== BACKUP_APP || typeof e.state !== 'object' || e.state == null) {
    throw new Error('That file is not a backup from this app.')
  }
  if (typeof e.version === 'number' && e.version > BACKUP_VERSION) {
    throw new Error('That backup was written by a newer version of the app. Reload the page and try again.')
  }
  return { app: BACKUP_APP, version: e.version ?? 1, savedAt: e.savedAt ?? '', state: e.state as S }
}

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    /* storage unavailable; sync simply will not remember itself */
  }
}

export const getSyncToken = () => read(TOKEN_STORAGE)
export const getSyncedAt = () => read(SYNCED_AT_STORAGE) || null
export const getDirtyAt = () => read(DIRTY_AT_STORAGE) || null
export const setSyncedAt = (at: string | null) => write(SYNCED_AT_STORAGE, at)
export const setDirtyAt = (at: string | null) => write(DIRTY_AT_STORAGE, at)

export function setSyncToken(token: string): void {
  write(TOKEN_STORAGE, token || null)
  if (!token) {
    write(GIST_ID_STORAGE, null)
    write(SYNCED_AT_STORAGE, null)
    write(DIRTY_AT_STORAGE, null)
  }
}

export class SyncError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

async function gh(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    })
  } catch {
    throw new SyncError('Could not reach GitHub. Check the connection; your cards are still saved in this browser.')
  }
  if (res.status === 401) {
    throw new SyncError('GitHub did not accept that token. It may have expired or been deleted — make a new one.', 401)
  }
  if (res.status === 403 || res.status === 404) {
    // A token without the gist scope answers 404 on gist writes, not 403.
    throw new SyncError('That token is not allowed to save gists. Make one with the "gist" box ticked.', res.status)
  }
  if (!res.ok) throw new SyncError(`GitHub answered ${res.status}. Your cards are still saved in this browser.`, res.status)
  return res
}

/** The GitHub login the token belongs to, which doubles as a check that it works. */
export async function whoAmI(token: string): Promise<string> {
  const res = await gh(token, '/user')
  const body = (await res.json()) as { login?: string }
  return body.login ?? 'your account'
}

interface GistFile { content?: string; truncated?: boolean; raw_url?: string }
interface Gist { id: string; files: Record<string, GistFile | undefined> }

/**
 * Finds the app's gist in the account, so a second browser lands on the same
 * one the first created rather than starting another.
 */
async function findGist(token: string): Promise<string | null> {
  const cached = read(GIST_ID_STORAGE)
  if (cached) return cached
  for (let page = 1; page <= 10; page++) {
    const res = await gh(token, `/gists?per_page=100&page=${page}`)
    const list = (await res.json()) as Gist[]
    const hit = list.find((g) => g.files && GIST_FILE in g.files)
    if (hit) {
      write(GIST_ID_STORAGE, hit.id)
      return hit.id
    }
    if (list.length < 100) break
  }
  return null
}

/** The saved copy, or null when this account has never saved one. */
export async function pullRemote<S>(token: string): Promise<Envelope<S> | null> {
  const id = await findGist(token)
  if (!id) return null
  let res: Response
  try {
    res = await gh(token, `/gists/${id}`)
  } catch (err) {
    // Deleted by hand since it was cached: forget it and look again.
    if (err instanceof SyncError && err.status === 404) {
      write(GIST_ID_STORAGE, null)
      return null
    }
    throw err
  }
  const gist = (await res.json()) as Gist
  const file = gist.files[GIST_FILE]
  if (!file) return null
  // The API cuts file content off at about a megabyte; the raw URL serves the rest.
  let text = file.content ?? ''
  if (file.truncated && file.raw_url) {
    const raw = await fetch(file.raw_url).catch(() => null)
    if (!raw?.ok) throw new SyncError('Could not download the saved copy from GitHub.')
    text = await raw.text()
  }
  return readEnvelope<S>(text)
}

/** Writes the copy, creating the gist the first time. */
export async function pushRemote<S>(token: string, envelope: Envelope<S>): Promise<void> {
  const content = JSON.stringify(envelope)
  const files = { [GIST_FILE]: { content } }
  const id = await findGist(token)
  if (id) {
    try {
      await gh(token, `/gists/${id}`, { method: 'PATCH', body: JSON.stringify({ files }) })
      return
    } catch (err) {
      if (!(err instanceof SyncError && err.status === 404)) throw err
      write(GIST_ID_STORAGE, null)
    }
  }
  const res = await gh(token, '/gists', {
    method: 'POST',
    body: JSON.stringify({ description: GIST_DESCRIPTION, public: false, files }),
  })
  const created = (await res.json()) as Gist
  write(GIST_ID_STORAGE, created.id)
}

/**
 * What to do on load, given what each side has.
 *
 * `syncedAt` is the version both last agreed on; `dirtyAt` is set while this
 * browser holds a change the gist has not received. The only real conflict is
 * both having moved since they last agreed, and then the later edit wins —
 * one person on two devices, so the later one is almost always the intended.
 */
export function decide(opts: {
  remoteSavedAt: string | null
  syncedAt: string | null
  dirtyAt: string | null
}): 'pull' | 'push' | 'none' {
  const { remoteSavedAt, syncedAt, dirtyAt } = opts
  if (!remoteSavedAt) return 'push'
  const remoteMoved = remoteSavedAt !== syncedAt
  if (remoteMoved && !dirtyAt) return 'pull'
  if (!remoteMoved) return dirtyAt ? 'push' : 'none'
  return dirtyAt! > remoteSavedAt ? 'push' : 'pull'
}
