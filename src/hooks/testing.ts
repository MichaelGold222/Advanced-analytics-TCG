/**
 * A minimal hook renderer.
 *
 * The project has no testing-library, and a hook this small does not justify
 * adding one: a host element, a component that calls the hook and records what
 * it returned, and React's own `act` to flush. `result.current` is read
 * through a getter so it is always the latest render rather than a snapshot
 * taken before an update.
 */
import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

export { act }

export function renderHook<P, T>(
  hook: (props: P) => T,
  options: { initialProps?: P } = {},
): { result: { current: T }; rerender: (props: P) => void; unmount: () => void } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: Root
  let latest: T

  const Probe = ({ hookProps }: { hookProps: P }) => {
    latest = hook(hookProps)
    return null
  }

  const render = (props: P) => {
    act(() => {
      root ??= createRoot(host)
      root.render(createElement(Probe, { hookProps: props }))
    })
  }

  render(options.initialProps as P)

  return {
    result: { get current() { return latest } },
    rerender: (props: P) => render(props),
    unmount: () => { act(() => root.unmount()); host.remove() },
  }
}
