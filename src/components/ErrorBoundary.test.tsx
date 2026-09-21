/** @vitest-environment happy-dom */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

function Boom(): never {
  throw new Error('field went missing')
}

const render = (node: React.ReactNode) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  act(() => { createRoot(host).render(<StrictMode>{node}</StrictMode>) })
  return host
}

afterEach(() => { document.body.innerHTML = '' })

describe('a render that throws', () => {
  it('shows a message instead of blanking the page', () => {
    // React logs the caught error; the test is about what the person sees.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = render(<ErrorBoundary label="Data &amp; settings"><Boom /></ErrorBoundary>)
    expect(host.textContent).toMatch(/could not be drawn/i)
    quiet.mockRestore()
  })

  it('says the stored data is intact, which is the thing to know', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = render(<ErrorBoundary><Boom /></ErrorBoundary>)
    expect(host.textContent).toMatch(/Nothing stored has been lost/i)
    expect(host.textContent).toMatch(/other tabs should still work/i)
    quiet.mockRestore()
  })

  it('shows the error itself, since only the person seeing it can report it', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = render(<ErrorBoundary><Boom /></ErrorBoundary>)
    expect(host.textContent).toContain('field went missing')
    quiet.mockRestore()
  })

  it('stays out of the way when nothing throws', () => {
    const host = render(<ErrorBoundary><p>all fine</p></ErrorBoundary>)
    expect(host.textContent).toBe('all fine')
    expect(host.textContent).not.toMatch(/could not be drawn/i)
  })
})
