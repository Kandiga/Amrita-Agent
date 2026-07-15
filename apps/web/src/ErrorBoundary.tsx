import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * The one thing between a render-time throw and a blank white page (stability
 * audit: there was no error boundary, so any exception in a panel — an oversized
 * preview, a malformed row — unmounted the entire app). Catches, shows an honest
 * fallback, and offers a reload. Value-free: it never renders the error object,
 * which could carry content the operator would not want on screen.
 */
interface Props {
  children: ReactNode;
}
interface State {
  crashed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { crashed: false };

  static getDerivedStateFromError(): State {
    return { crashed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Console only, message only — never the full object or component stack in UI.
    console.error('Amrita UI error (recovered):', error.message, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.crashed) {
      return (
        <div className="app-crash">
          <h1>Something broke on screen</h1>
          <p>The rest of Amrita is fine — your data is safe in the store. Reload to continue.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
