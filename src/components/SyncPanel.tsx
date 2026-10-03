import { useRef, useState } from 'react'
import { Cloud, CloudOff, Download, Upload } from 'lucide-react'
import { relativeTime } from '../lib/format'
import { saveFile, type FileWriter } from '../lib/save-file'
import { TOKEN_URL } from '../lib/sync'
import type { SyncState } from '../lib/store'

interface Props {
  sync: SyncState
  onConnect: (token: string) => Promise<void>
  onChoose: (keep: 'account' | 'browser') => Promise<void>
  onDisconnect: () => void
  onSyncNow: () => Promise<void>
  /** The backup file's text, built when the button is pressed. */
  backupText: () => string
  onRestore: (text: string) => Promise<{ holdings: number; watchlist: number }>
}

function jsonWriter(text: string): FileWriter {
  const blob = () => new Blob([text], { type: 'application/json' })
  return {
    toBlob: async () => blob(),
    toFile: async (filename) => {
      const url = URL.createObjectURL(blob())
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
  }
}

/**
 * Saving the cards somewhere other than this one browser.
 *
 * Two routes, because they answer different worries: sync keeps every browser
 * the owner signs into in step without them thinking about it, and a backup
 * file is a copy they hold themselves that depends on nobody's account.
 */
export function SyncPanel({ sync, onConnect, onChoose, onDisconnect, onSyncNow, backupText, onRestore }: Props) {
  const [token, setToken] = useState('')
  const [restoreNote, setRestoreNote] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const connected = sync.account != null && sync.status !== 'off'
  const working = sync.status === 'working'

  async function download() {
    const day = new Date().toISOString().slice(0, 10)
    await saveFile(jsonWriter(backupText()), `tcg-cards-backup-${day}.json`)
  }

  async function restore(file: File) {
    setRestoreNote(null)
    try {
      const { holdings, watchlist } = await onRestore(await file.text())
      setRestoreNote(`Restored ${holdings} holding${holdings === 1 ? '' : 's'} and ${watchlist} watch item${watchlist === 1 ? '' : 's'}.`)
    } catch (err) {
      setRestoreNote(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section className="card p-4">
      <h2 className="text-sm font-semibold mb-1 flex items-center gap-2">
        {connected ? <Cloud className="size-4" aria-hidden /> : <CloudOff className="size-4" aria-hidden />}
        Keep my cards on every browser
      </h2>

      {sync.choice ? (
        <div className="text-sm leading-relaxed space-y-3">
          <p>
            Your GitHub account already has saved cards ({sync.choice.remoteHoldings} holdings,{' '}
            {sync.choice.remoteWatch} watch items, saved {relativeTime(sync.choice.remoteSavedAt)}), and this
            browser has different ones. Which should every browser use?
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" onClick={() => void onChoose('account')}>
              Use the saved cards (replace this browser&apos;s)
            </button>
            <button type="button" className="btn" onClick={() => void onChoose('browser')}>
              Keep this browser&apos;s (replace the saved ones)
            </button>
          </div>
        </div>
      ) : connected ? (
        <div className="text-sm leading-relaxed">
          <p className="secondary">
            {working
              ? 'Syncing…'
              : sync.status === 'error'
                ? 'Sync is connected but the last attempt failed.'
                : `Synced with GitHub (${sync.account}) · last saved ${relativeTime(sync.lastSynced)}.`}{' '}
            Changes save automatically. On another browser, open this page and connect with the same token.
          </p>
          <div className="flex flex-wrap gap-2 mt-3">
            <button type="button" className="btn" disabled={working} onClick={() => void onSyncNow()}>Sync now</button>
            <button type="button" className="btn" onClick={onDisconnect}>Disconnect this browser</button>
          </div>
        </div>
      ) : (
        <div className="text-sm leading-relaxed">
          <p className="text-xs secondary mb-3">
            Right now your cards are saved only in this browser. Connect a GitHub token and they are saved
            to a secret gist in your own GitHub account, and load on any browser or device where you connect
            the same token.
          </p>
          <ol className="text-xs secondary list-decimal pl-5 space-y-1 mb-3">
            <li>
              <a className="underline" href={TOKEN_URL} target="_blank" rel="noreferrer">Make a token on GitHub</a>{' '}
              — only the <span className="font-medium">gist</span> box needs ticking (it is pre-ticked). Pick
              &ldquo;No expiration&rdquo; if you do not want to redo this.
            </li>
            <li>Copy it, paste it here, and press Connect.</li>
            <li>Do the same on your other browsers with the same token. Keep the token somewhere safe.</li>
          </ol>
          <div className="flex gap-2">
            <input
              className="input" type="password" placeholder="GitHub token (ghp_…)" value={token}
              aria-label="GitHub token"
              onChange={(e) => setToken(e.target.value)}
            />
            <button
              type="button" className="btn btn-primary" disabled={working || !token.trim()}
              onClick={() => { void onConnect(token).then(() => setToken('')) }}
            >
              {working ? 'Connecting…' : 'Connect'}
            </button>
          </div>
          <p className="text-xs muted mt-2">
            The token stays in this browser and is sent only to GitHub. Your Parse key is never saved to the
            gist. A secret gist is unlisted and not searchable, but anyone given its exact link could open it.
          </p>
        </div>
      )}

      {sync.message && (
        <p className="text-xs mt-3" style={{ color: 'var(--critical)' }} role="alert">{sync.message}</p>
      )}

      <h3 className="text-sm font-semibold mt-5 mb-1">Backup file</h3>
      <p className="text-xs secondary mb-2">
        A copy you keep yourself: every card, fetched sale and typed value in one file. Restoring replaces
        what is in this browser.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" onClick={() => void download()}>
          <Download className="size-4" aria-hidden /> Download backup
        </button>
        <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
          <Upload className="size-4" aria-hidden /> Restore from backup
        </button>
        <input
          ref={fileRef} type="file" accept=".json,application/json" className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void restore(f)
          }}
        />
      </div>
      {restoreNote && <p className="text-xs secondary mt-2" role="status">{restoreNote}</p>}
    </section>
  )
}
