import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
// DESIGN.md §1.2/§1.8 row A -- IBM Plex Sans is now the primary display/sans
// family (index.css's --font-display/--font-sans), 'Inter Variable' kept
// only as its own declared fallback in that same token -- Inter Tight is no
// longer referenced anywhere and its import is removed, not just demoted.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource-variable/inter/wght.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import { App } from './App.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
