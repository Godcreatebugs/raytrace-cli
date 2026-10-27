// The dashboard as a static page, served by the RayTrace proxy from the same
// origin as its API. The views are raytace's own (app/), the same ones the
// hosted dashboard shows; this one shows what a local install serves.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import { configureApi } from './app/api';
import { Dashboard, type View } from './app/dashboard';
import './app/globals.css';

// The sections a local install serves so far. Story's recap and Chain of
// thought run on the user's own OpenRouter key (raytrace key openrouter).
// Changes and Playground follow; the initial scan is not kept locally yet.
const VIEWS: View[] = ['prompts', 'search', 'story', 'sandboxes', 'calls', 'sandbox', 'context', 'thought'];

// Same origin as the proxy that serves this page, whatever its port.
configureApi({ fetch: (path, init) => fetch(path, init) });

createRoot(document.getElementById('root')!).render(<StrictMode><Dashboard views={VIEWS} /></StrictMode>);
