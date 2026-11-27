'use client';

// Phase 2 floating bottom-right card for the local dashboard:
// Primary CTA to create a free RayTrace account, with a lightweight weekly
// newsletter email fallback underneath. Appears 20 seconds after connecting
// when >= 10 prompts exist, >= 24h have passed since star-prompt.json, and
// this machine has not linked a RayTrace Cloud account.
import { useEffect, useState, type FormEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ExternalLink, Sparkles, X } from 'lucide-react';
import { api } from './api';

export const SIGNUP_POPUP_DELAY_MS = 20_000;
const DEFAULT_SIGNUP_URL = 'https://raytracer.si/sign-in.html?src=local-dashboard';

type SignupPromptPayload = {
  eligible: boolean;
  prompts: number;
  threshold: number;
  status: string;
  signup_url?: string;
};

async function postSignupAction(body: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await api().fetch('/raytace/signup-prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-raytace-experiment': '1' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({})) as { error?: string };
    return response.ok ? { ok: true } : { ok: false, error: data.error || `Request failed (HTTP ${response.status}).` };
  } catch {
    return { ok: false, error: 'Could not reach the local RayTrace proxy.' };
  }
}

export function SignupPopup({ promptCount, connected }: { promptCount: number; connected: boolean }) {
  const reduced = useReducedMotion();
  const [info, setInfo] = useState<SignupPromptPayload | null>(null);
  const [checked, setChecked] = useState(false);
  const [stage, setStage] = useState<'hidden' | 'ask' | 'subscribed'>('hidden');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!connected || checked || promptCount < 10) return;
    let cancelled = false;
    api().fetch('/raytace/signup-prompt', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() as Promise<SignupPromptPayload> : null))
      .then((data) => {
        if (cancelled) return;
        setChecked(true);
        if (data?.eligible) setInfo(data);
      })
      .catch(() => {
        if (!cancelled) setChecked(true);
      });
    return () => { cancelled = true; };
  }, [connected, checked, promptCount]);

  useEffect(() => {
    if (!info?.eligible) return;
    const timer = setTimeout(() => setStage((prev) => (prev === 'hidden' ? 'ask' : prev)), SIGNUP_POPUP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [info]);

  const signupUrl = info?.signup_url || DEFAULT_SIGNUP_URL;
  const prompts = Math.max(info?.prompts ?? 0, promptCount);

  function onDismiss() {
    setStage('hidden');
    void postSignupAction({ action: 'dismissed' });
  }

  function onSignupClick() {
    setStage('hidden');
    void postSignupAction({ action: 'clicked_signup' });
  }

  async function onSubscribe(event: FormEvent) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('Please enter a valid email address.');
      return;
    }
    setError('');
    setSubmitting(true);
    const result = await postSignupAction({ action: 'subscribe', email: trimmed });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error || 'Could not subscribe right now.');
      return;
    }
    setStage('subscribed');
  }

  return <AnimatePresence>
    {stage !== 'hidden' && <motion.aside
      key={stage}
      className="rt-star-popup rt-signup-popup"
      role="region"
      aria-label={stage === 'ask' ? 'Create a RayTrace account or subscribe to updates' : 'Subscription confirmation sent'}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.98 }}
      transition={{ duration: reduced ? 0.1 : 0.22, ease: 'easeOut' }}
    >
      <div className="rt-star-popup-head">
        <span className="rt-star-popup-eyebrow">
          <Sparkles size={13} aria-hidden="true" />
          {stage === 'ask' ? 'GET MORE FROM RAYTRACE' : 'CHECK YOUR INBOX'}
        </span>
        <button type="button" className="rt-star-popup-close" aria-label="Dismiss"
          onClick={() => (stage === 'ask' ? onDismiss() : setStage('hidden'))}>
          <X size={14} />
        </button>
      </div>
      {stage === 'ask' ? <>
        <p className="rt-star-popup-copy">
          You&apos;ve recorded <strong>{prompts}</strong> prompts locally. Create a free account for cloud sandboxes, shareable trace links, and backup.
        </p>
        <div className="rt-star-popup-actions">
          <a className="rt-button primary rt-star-popup-cta" href={signupUrl} target="_blank" rel="noopener noreferrer" onClick={onSignupClick}>
            <span>Create free account</span>
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        </div>
        <div className="rt-signup-divider" />
        <form className="rt-signup-newsletter" onSubmit={onSubscribe} noValidate>
          <label className="rt-signup-label" htmlFor="rt-signup-email">
            Not ready for an account? Get the weekly what&apos;s new email:
          </label>
          <div className="rt-signup-row">
            <input id="rt-signup-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com" autoComplete="email" disabled={submitting} />
            <button type="submit" className="rt-button" disabled={submitting}>
              {submitting ? 'Sending…' : 'Subscribe'}
            </button>
          </div>
          {error && <p className="rt-signup-error" role="alert">{error}</p>}
          <p className="rt-signup-note">Only your email is sent — zero trace data leaves your machine.</p>
        </form>
      </> : <>
        <p className="rt-star-popup-copy">
          Check your inbox to confirm your subscription. You can unsubscribe any time.
        </p>
        <div className="rt-star-popup-actions">
          <button type="button" className="rt-button" onClick={() => setStage('hidden')}>Close</button>
        </div>
      </>}
    </motion.aside>}
  </AnimatePresence>;
}
