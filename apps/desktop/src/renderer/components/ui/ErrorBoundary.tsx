import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertOctagon, RefreshCw } from "lucide-react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // In a real build this would forward to telemetry
    console.error("[ACode] UI crash:", error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div className="h-full w-full flex flex-col items-center justify-center bg-acode-bg-primary p-8 text-center">
          <AlertOctagon className="w-10 h-10 text-acode-git-deleted mb-3" />
          <h1 className="text-xl font-semibold text-acode-text-primary mb-1">
            Something went wrong
          </h1>
          <p className="text-sm text-acode-text-muted max-w-md mb-4">
            ACode hit an unexpected error rendering this part of the UI. You can
            try resetting the surface — the editor and any open files are safe.
          </p>
          <pre className="text-[11px] text-acode-text-muted max-w-xl overflow-x-auto bg-acode-bg-secondary border border-acode-border-primary rounded p-3 mb-4">
            {this.state.error.message}
          </pre>
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 bg-acode-accent-primary hover:bg-acode-accent-hover text-white text-xs rounded-md"
            onClick={this.reset}
          >
            <RefreshCw className="w-3 h-3" />
            Reset surface
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
