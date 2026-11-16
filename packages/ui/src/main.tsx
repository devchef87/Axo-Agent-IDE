import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { App } from './App.tsx';
import { initTheme } from './lib/theme.ts';
import { ErrorBoundary } from './components/error-boundary.tsx';

// pdf.js 6 calls Math.sumPrecise, which Electron 41's Chromium doesn't have yet.
if (!(Math as any).sumPrecise) (Math as any).sumPrecise = (xs: Iterable<number>) => { let s = 0; for (const x of xs) s += x; return s; };

initTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="Axo">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
