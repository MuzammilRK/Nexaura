import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  title: string;
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

export class PanelErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message || 'Panel failed to render.' };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-xl border border-rose-500/40 bg-slate-900 p-5 text-slate-200">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5 text-rose-400">
              <AlertTriangle className="h-5 w-5 shrink-0" />
              <span className="font-semibold">{this.props.title} unavailable</span>
            </div>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false, message: '' })}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry Panel
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-400">{this.state.message}</p>
        </div>
      );
    }
    return this.props.children;
  }
}
