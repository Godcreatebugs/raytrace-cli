'use client';

// Adapted from Amicro's AnimatedButton spring, sparkle and shake interactions.
// Copyright (c) 2026 SYED SUBHAN UDDIN. MIT: ./AMICRO-LICENSE.txt.
import { useState, type ButtonHTMLAttributes, type ComponentType } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Moon, Star, Sun, Trash2, Wifi, WifiOff, Waves } from 'lucide-react';
import { setTheme, useTheme } from '../theme';
import { setWaveAnimation, useWaveAnimation } from './wave-preference';

// GitHub mark from Primer Octicons (MIT); see THIRD_PARTY_NOTICES.md.
function Github({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor"><path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656" /></svg>;
}

export const iconSpring = { type: 'spring' as const, stiffness: 600, damping: 28 };

export function MorphIcon({ first: First, second: Second, active, sparkle = false }: {
  first: ComponentType<{ size?: number }>; second: ComponentType<{ size?: number }>; active: boolean; sparkle?: boolean;
}) {
  const reduced = useReducedMotion();
  const Icon = active ? Second : First;
  return <span className={`rt-morph-icon${sparkle ? ' sparkle' : ''}`} aria-hidden="true">
    <AnimatePresence initial={false}>
      <motion.span key={`${active}:${Icon.displayName}`}
        initial={{ opacity: 0, scale: reduced ? 1 : .5, y: !reduced && sparkle ? 10 : 0 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: reduced ? 1 : .5, y: !reduced && sparkle ? -10 : 0 }}
        transition={reduced ? { duration: 0 } : iconSpring}>
        <Icon size={16} />
        {sparkle && active && <>
          <motion.i className="rt-star-spark one" initial={{ opacity: 0, scale: 0, rotate: -45 }}
            animate={{ opacity: 1, scale: 1, rotate: 0 }} transition={reduced ? { duration: 0 } : { ...iconSpring, delay: .05 }}><Star size={8} fill="currentColor" /></motion.i>
          <motion.i className="rt-star-spark two" initial={{ opacity: 0, scale: 0, rotate: 45 }}
            animate={{ opacity: 1, scale: 1, rotate: 0 }} transition={reduced ? { duration: 0 } : { ...iconSpring, delay: .1 }}><Star size={5} fill="currentColor" /></motion.i>
        </>}
      </motion.span>
    </AnimatePresence>
  </span>;
}

export function GitHubStarLink({ onStarClick }: { onStarClick?: () => void } = {}) {
  const [active, setActive] = useState(false);
  return <a className="rt-button rt-motion-button rt-github-star" href="https://github.com/Godcreatebugs/raytrace-cli"
    target="_blank" rel="noreferrer" onClick={onStarClick}
    onMouseEnter={() => setActive(true)} onMouseLeave={() => setActive(false)}
    onFocus={() => setActive(true)} onBlur={() => setActive(false)}>
    <MorphIcon first={Github} second={Star} active={active} sparkle />
    <span>Star on GitHub</span>
  </a>;
}

export function ThemeButton() {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const label = `Switch to ${theme === 'light' ? 'dark' : 'light'} theme`;
  return <motion.button type="button" className="rt-motion-theme" aria-label={label} title={label}
    aria-pressed={theme === 'dark'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
    whileHover={reduced ? undefined : { rotate: 12, scale: 1.08 }} whileTap={reduced ? undefined : { scale: .9 }}>
    <MorphIcon first={Moon} second={Sun} active={theme === 'dark'} />
  </motion.button>;
}

export function ConnectionStatus({ loaded, connected, offline }: { loaded: boolean; connected: boolean; offline: string }) {
  const reduced = useReducedMotion();
  const state = !loaded ? 'pending' : connected ? 'connected' : 'offline';
  return <motion.div className="rt-network-status" data-state={state} role="status" aria-live="polite"
    title={!loaded ? 'Connecting to the local proxy' : connected ? 'Dashboard connected to the proxy' : 'The dashboard cannot reach the proxy'}
    whileHover={reduced ? undefined : { scale: 1.025 }}>
    <MorphIcon first={Wifi} second={WifiOff} active={loaded && !connected} />
    <span>{!loaded ? 'Connecting…' : connected ? 'Connected' : offline}</span>
  </motion.div>;
}

export function DeleteButton({ children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`rt-button rt-motion-button rt-delete-button ${className}`} {...props}>
    <span className="rt-delete-icon" aria-hidden="true"><Trash2 size={16} /></span>{children}
  </button>;
}

export function WaveAnimationButton() {
  const enabled = useWaveAnimation();
  const label = enabled ? 'Pause loading animation' : 'Enable loading animation';
  return <button type="button" className="rt-motion-theme rt-wave-motion-toggle" aria-label={label} title={label}
    aria-pressed={enabled} onClick={() => setWaveAnimation(!enabled)}><Waves size={16} aria-hidden="true" /></button>;
}
