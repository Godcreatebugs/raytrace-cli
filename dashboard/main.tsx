// The dashboard as a static page, served by the RayTrace proxy from the same
// origin as its API. The views are raytace's own (app/), the same ones the
// hosted dashboard shows; this one shows what a local install serves.
import { StrictMode, useEffect, useState } from 'react';
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

// The sections a local install serves. Story's recap and Chain of thought run
// on the user's own OpenRouter key (raytrace key openrouter); Playground's
// forks run Claude Code on the user's own sign-in, in the local VM. The
// initial scan is not kept locally yet.
const VIEWS: View[] = ['prompts', 'search', 'story', 'sandboxes', 'calls', 'changes', 'sandbox', 'context', 'thought', 'playground'];

// Same origin as the proxy that serves this page, whatever its port.
configureApi({ fetch: (path, init) => fetch(path, init) });

// The page is read from disk, so after an upgrade an older proxy still running
// serves it, and answers its new sections "Unknown local endpoint". Say why.
const PROXY_API = 3;
function ProxyNotice() {
  const [outdated, setOutdated] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  useEffect(() => {
    fetch('/raytace/version').then((response) => (response.ok ? response.json() : { api: 0 }))
      .then((body) => setOutdated((Number(body.api) || 0) < PROXY_API), () => {});
    fetch('/raytace/models').then((response) => setSignedOut(response.status === 401), () => {});
  }, []);
  if (!outdated && !signedOut) return null;
  return <div role="alert" style={{ padding: '10px 16px', background: 'light-dark(#fff4d6,#3a2f12)', color: 'light-dark(#5c4300,#ffd97a)', fontSize: 13, borderBottom: '1px solid light-dark(#f0d48a,#5c4a1c)' }}>
    {outdated ? <>An older RayTrace proxy is running, so parts of this page cannot load. Restart it: <code>raytrace stop &amp;&amp; raytrace start</code></>
      : <>This browser is not signed in to RayTrace, so nothing can load. In a terminal, run: <code>raytrace open</code></>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><ProxyNotice /><Dashboard views={VIEWS} /></StrictMode>);
