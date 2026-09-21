import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Stops one broken panel from taking the whole page with it.
 *
 * React unmounts the entire tree when a render throws, so before this existed
 * a single bad read — a field added to stored state that older saved data does
 * not carry — produced a completely black page with nothing on it to act on or
 * report. The data was intact the whole time; only the drawing of it had
 * failed, and there was no way to tell that from the outside.
 *
 * So the message says the three things worth knowing: what broke, that nothing
 * stored was lost, and how to get moving again. The error text is shown rather
 * than hidden, because the person seeing it is the only one who can pass it on.
 */
interface Props {
  children: ReactNode
  /** What this boundary wraps, for the message. */
  label?: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept in the console for anyone who opens it; the panel below is for
    // everyone else.
    console.error('Render failed', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <section className="card p-4" style={{ borderColor: 'var(--critical)' }}>
        <h2 className="text-sm font-semibold" style={{ color: 'var(--critical)' }}>
          {this.props.label ? `${this.props.label} could not be drawn` : 'Something could not be drawn'}
        </h2>
        <p className="text-sm secondary mt-2 leading-relaxed max-w-2xl">
          Nothing stored has been lost — this is a fault in displaying the page, not in the data behind
          it. Your holdings, watchlist, fetched prices and photographs are all still in this browser. The
          other tabs should still work.
        </p>
        <pre className="text-xs mt-3 p-2 overflow-auto rounded" style={{ background: 'var(--surface-2)' }}>
          {error.message}
        </pre>
        <div className="mt-3 flex gap-2">
          <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Reload the page
          </button>
        </div>
      </section>
    )
  }
}
