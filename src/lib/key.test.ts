import { describe, expect, it } from 'vitest'
import { itemKey } from './key'

describe('a variation is a different card', () => {
  const base = { name: 'Charizard', set: 'Base Set', number: '4', grader: 'PSA', grade: 10 }

  it('keeps two printings of the same card apart', () => {
    // Same name, set, number and grade. Wildly different money.
    const shadowless = itemKey({ ...base, variation: 'Shadowless' })
    const unlimited = itemKey({ ...base, variation: 'Unlimited' })
    expect(shadowless).not.toBe(unlimited)
  })

  it('leaves a card with no variation on exactly the key it had before', () => {
    // Anything imported before variations existed must stay attached to
    // whatever was stored against it.
    expect(itemKey({ ...base, variation: undefined })).toBe(itemKey(base))
    expect(itemKey({ ...base, variation: '' })).toBe(itemKey(base))
  })

  it('reads the same variation written differently as the same card', () => {
    expect(itemKey({ ...base, variation: '1st Edition' }))
      .toBe(itemKey({ ...base, variation: '1ST EDITION' }))
  })

  it('still separates grades within one variation', () => {
    expect(itemKey({ ...base, grade: 9, variation: 'Shadowless' }))
      .not.toBe(itemKey({ ...base, grade: 10, variation: 'Shadowless' }))
  })
})
