import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Keeps one broken view from blanking the whole app: shows the error and a way out instead.
 * `resetKey` changing (e.g. switching view) clears the error.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string; onReset?: () => void; label?: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[axo] view crashed', error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-bg p-8 text-center">
        <div className="text-[13px] text-primary">{this.props.label ?? 'This view'} hit an error.</div>
        <pre className="max-h-40 max-w-xl overflow-auto whitespace-pre-wrap rounded border border-border-subtle bg-inset px-3 py-2 text-left font-mono text-2xs text-danger">
          {error.message}
        </pre>
        <div className="flex gap-2">
          {this.props.onReset && (
            <button className="h-7 rounded bg-accent px-3 text-xs font-medium text-accent-fg hover:bg-accent-hover cursor-pointer"
              onClick={() => { this.setState({ error: null }); this.props.onReset?.(); }}>
              Back to Fleet
            </button>
          )}
          <button className="h-7 rounded bg-control px-3 text-xs text-secondary hover:bg-control-hover cursor-pointer" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
