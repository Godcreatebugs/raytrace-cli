'use client';

// Floating bottom-right GitHub star prompt for the local dashboard.
// Appears 20 seconds after the user has at least 3 recorded prompts (and has
// not already acted on the CLI or dashboard prompt). State is persisted on
// disk via /raytace/star-prompt (~/.raytrace/star-prompt.json).
import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ExternalLink, Star, X } from 'lucide-react';
import { api } from './api';

export const STAR_POPUP_DELAY_MS = 20_000;
const DEFAULT_STAR_URL = 'https://github.com/Godcreatebugs/raytrace-cli';
const DEFAULT_WEBSITE_URL = 'https://raytracer.si';

export type StarPromptAction = 'opened' | 'already_starred' | 'dismissed';
export type StarPromptSource = 'dashboard' | 'sidebar';

type StarPromptPayload = {
  eligible: boolean;
  prompts: number;
  threshold: number;
  status: string;
  url?: string;
  website_url?: string;
};

/** Persist a star-prompt action through the local proxy. Silently ignored when unavailable. */
export async function recordStarPromptAction(action: StarPromptAction, source: StarPromptSource = 'dashboard'): Promise<void> {
  try {
    await api().fetch('/raytace/star-prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-raytace-experiment': '1' },
      body: JSON.stringify({ action, source }),
    });
  } catch { /* local-only endpoint; ignore on older proxy or hosted dashboard */ }
}

export function StarPopup({ promptCount, connected, suppressed = false }: {
  promptCount: number;
  connected: boolean;
  suppressed?: boolean;
}) {
  const reduced = useReducedMotion();
  const [info, setInfo] = useState<StarPromptPayload | null>(null);
  const [checked, setChecked] = useState(false);
  const [stage, setStage] = useState<'hidden' | 'ask' | 'thanks'>('hidden');

  // Check eligibility once the dashboard is connected and at least 3 prompts exist.
  useEffect(() => {
    if (suppressed || !connected || checked || promptCount < 3) return;
    let cancelled = false;
    api().fetch('/raytace/star-prompt', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() as Promise<StarPromptPayload> : null))
      .then((data) => {
        if (cancelled) return;
        setChecked(true);
        if (data?.eligible) setInfo(data);
      })
      .catch(() => {
        if (!cancelled) setChecked(true);
      });
    return () => { cancelled = true; };
  }, [suppressed, connected, checked, promptCount]);

  // Wait 20 seconds before showing the popup so the user settles into the dashboard first.
  useEffect(() => {
    if (!info?.eligible || suppressed) {
      if (suppressed) setStage((prev) => (prev === 'ask' ? 'hidden' : prev));
      return;
    }
    const timer = setTimeout(() => setStage((prev) => (prev === 'hidden' ? 'ask' : prev)), STAR_POPUP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [info, suppressed]);

  const starUrl = info?.url || DEFAULT_STAR_URL;
  const websiteUrl = info?.website_url || DEFAULT_WEBSITE_URL;
  const prompts = Math.max(info?.prompts ?? 0, promptCount);

  function dismiss(action: 'dismissed' | 'already_starred') {
    setStage('hidden');
    void recordStarPromptAction(action, 'dashboard');
  }

  function onStarClick() {
    void recordStarPromptAction('opened', 'dashboard');
    setStage('thanks');
  }

  return <AnimatePresence>
    {stage !== 'hidden' && <motion.aside
      key={stage}
      className="rt-star-popup"
      role="region"
      aria-label={stage === 'ask' ? 'Star RayTrace on GitHub' : 'Explore RayTrace'}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.98 }}
      transition={{ duration: reduced ? 0.1 : 0.22, ease: 'easeOut' }}
    >
      <div className="rt-star-popup-head">
        <span className="rt-star-popup-eyebrow">
          <Star size={13} fill="currentColor" aria-hidden="true" />
          {stage === 'ask' ? 'ENJOYING RAYTRACE?' : 'THANKS FOR SUPPORTING RAYTRACE'}
        </span>
        <button type="button" className="rt-star-popup-close" aria-label="Dismiss"
          onClick={() => (stage === 'ask' ? dismiss('dismissed') : setStage('hidden'))}>
          <X size={14} />
        </button>
      </div>
      {stage === 'ask' ? <>
        <p className="rt-star-popup-copy">
          You&apos;ve recorded <strong>{prompts}</strong> prompts locally. A GitHub star helps other developers discover RayTrace.
        </p>
        <div className="rt-star-popup-actions">
          <a className="rt-button primary rt-star-popup-cta" href={starUrl} target="_blank" rel="noopener noreferrer" onClick={onStarClick}>
            <Star size={14} aria-hidden="true" />
            <span>Star on GitHub</span>
          </a>
          <button type="button" className="rt-star-popup-secondary" onClick={() => dismiss('already_starred')}>
            Already starred
          </button>
        </div>
      </> : <>
        <p className="rt-star-popup-copy">
          Want cloud sandboxes, shareable trace links, or product updates?
        </p>
        <div className="rt-star-popup-actions">
          <a className="rt-button primary rt-star-popup-cta" href={websiteUrl} target="_blank" rel="noopener noreferrer" onClick={() => setStage('hidden')}>
            <span>Visit raytracer.si</span>
            <ExternalLink size={13} aria-hidden="true" />
          </a>
          <button type="button" className="rt-star-popup-secondary" onClick={() => setStage('hidden')}>
            Close
          </button>
        </div>
      </>}
    </motion.aside>}
  </AnimatePresence>;
}
