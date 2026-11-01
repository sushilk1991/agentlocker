import { Component, type ReactNode } from 'react';
import { Button } from './ui/button';

// Unmounting the app disposes its authenticated client and private query cache.
// Never render exception messages: they can contain private request data.
export class ErrorBoundary extends Component<{children: ReactNode}, {failed: boolean}> {
 state = {failed: false};
 static getDerivedStateFromError() { return {failed: true}; }
 render() {
  if (!this.state.failed) return this.props.children;
  return <div className="auth-layout"><main className="auth-card" role="alert">
   <h1>This page could not load</h1>
   <p>Reload the app and sign in again. Check the approval queue before repeating a request.</p>
   <Button onClick={() => window.location.reload()}>Reload and sign in</Button>
  </main></div>;
 }
}
