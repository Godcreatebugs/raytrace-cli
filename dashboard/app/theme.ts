'use client';

/**
 * Light or dark, as the website does it (website/site.js): `data-theme` on
 * <html>, remembered in this browser under the same key, light by default.
 * The stylesheets give every colour both values with light-dark().
 */
import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'raytrace-theme';

function stored(): Theme {
  try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}
export function currentTheme(): Theme {
  return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}
export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(KEY, theme); } catch { /* the choice lasts for this page only */ }
}
// Applied as the script loads, before the first paint where it can be.
if (typeof document !== 'undefined') document.documentElement.dataset.theme = stored();

function subscribe(changed: () => void) {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
/** The theme in force, for the few colours a stylesheet cannot reach (the graph's). */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme, () => 'light');
}
