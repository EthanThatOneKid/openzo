import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[openzo] UI error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-lg font-medium">Something broke in the UI.</p>
        <pre className="max-w-xl overflow-auto rounded-lg bg-muted p-3 text-left text-xs">{this.state.error.message}</pre>
        <button className="rounded-md border px-3 py-1.5 text-sm" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
