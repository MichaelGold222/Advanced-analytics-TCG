import { useState } from 'react'

/**
 * A slab photograph, or a quiet placeholder where one has not arrived.
 *
 * The frame is drawn either way so a row's height never changes as pictures
 * load, and a broken link falls back to the placeholder rather than to a
 * browser's torn-image icon. Photographs are fetched once per certificate and
 * kept, since a picture does not go stale the way a price does.
 */
export function CardThumb({
  src,
  name,
  size = 'sm',
}: {
  src: string | null
  name: string
  /** `sm` for a table row, `lg` for the expanded panel. */
  size?: 'sm' | 'lg'
}) {
  const [failed, setFailed] = useState(false)
  const box = size === 'lg' ? 'w-24 h-32' : 'w-10 h-14'

  if (!src || failed) {
    return (
      <div
        className={`shrink-0 ${box} rounded-sm`}
        style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
        aria-hidden
      />
    )
  }
  return (
    <img
      src={src}
      alt={`${name} slab`}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`shrink-0 ${box} rounded-sm object-cover`}
      style={{ border: '1px solid var(--border)' }}
    />
  )
}
