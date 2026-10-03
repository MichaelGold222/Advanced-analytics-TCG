/**
 * Named watchlists: which cards are on screen, and remembering it.
 *
 * Kept out of the component file because a plain helper exported beside a
 * component breaks fast refresh.
 */
/** Which cards are on screen: every one, those on no list, or one named list. */
export type ListView = { kind: 'all' } | { kind: 'unsorted' } | { kind: 'list'; name: string }

export const ALL_VIEW: ListView = { kind: 'all' }

const VIEW_STORAGE = 'aa-tcg.watchlistView'

/** The view this viewer last had open. A per-browser convenience, nothing more. */
export function loadView(names: string[]): ListView {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE)
    const v = raw ? (JSON.parse(raw) as ListView) : ALL_VIEW
    if (v.kind === 'list' && !names.includes(v.name)) return ALL_VIEW
    return v.kind === 'all' || v.kind === 'unsorted' || v.kind === 'list' ? v : ALL_VIEW
  } catch {
    return ALL_VIEW
  }
}

export function saveView(v: ListView) {
  try {
    localStorage.setItem(VIEW_STORAGE, JSON.stringify(v))
  } catch {
    /* not remembered; harmless */
  }
}

export function inView(list: string | undefined, view: ListView): boolean {
  if (view.kind === 'all') return true
  if (view.kind === 'unsorted') return !list
  return list === view.name
}
