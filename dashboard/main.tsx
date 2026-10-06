// The dashboard as a static page, served by the RayTrace proxy from the same
// origin as its API.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Home from './app/page';
import './app/globals.css';

createRoot(document.getElementById('root')!).render(<StrictMode><Home /></StrictMode>);
