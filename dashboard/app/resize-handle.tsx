'use client';

// A drag handle that sets a width, as a CSS variable on a target element.
// The width is written straight to the element while dragging (no re-render
// per pixel) and kept in this browser, so a panel stays the size it was left.
// Arrow keys move it too; double-click puts it back.
import { type RefObject, useEffect } from 'react';

const read = (key: string) => { try { return Number(localStorage.getItem(key)) || null; } catch { return null; } };
const keep = (key: string, value: number | null) => { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, String(value)); } catch { /* private window */ } };

export function ResizeHandle({ target, variable, storageKey, min, max, label }: {
  target: RefObject<HTMLElement | null>;
  /** The CSS variable holding the width, e.g. --nav-width. */
  variable: string;
  storageKey: string;
  min: number; max: number;
  label: string;
}) {
  const clamp = (value: number) => Math.round(Math.min(max, Math.max(min, value)));
  const set = (value: number | null) => {
    if (value == null) target.current?.style.removeProperty(variable);
    else target.current?.style.setProperty(variable, `${clamp(value)}px`);
  };
  const current = (handle: HTMLElement) => handle.parentElement?.getBoundingClientRect().width ?? min;

  useEffect(() => {
    const saved = read(storageKey);
    if (saved) target.current?.style.setProperty(variable, `${Math.round(Math.min(max, Math.max(min, saved)))}px`);
  }, [target, variable, storageKey, min, max]);

  // A button: reachable by keyboard, where arrow keys resize it.
  return <button type="button" aria-label={`${label}: drag, or use the arrow keys, to resize`}
    className="resize-handle" title={`${label} · drag to resize, double-click to reset`}
    onPointerDown={(event) => {
      const handle = event.currentTarget;
      const startX = event.clientX; const startWidth = current(handle);
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add('resizing');
      const move = (moved: PointerEvent) => set(startWidth + moved.clientX - startX);
      const done = (ended: PointerEvent) => {
        handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', done); handle.removeEventListener('pointercancel', done);
        document.body.classList.remove('resizing');
        keep(storageKey, clamp(startWidth + ended.clientX - startX));
      };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', done); handle.addEventListener('pointercancel', done);
    }}
    onKeyDown={(event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const next = clamp(current(event.currentTarget) + (event.key === 'ArrowRight' ? 24 : -24));
      set(next); keep(storageKey, next);
    }}
    onDoubleClick={() => { set(null); keep(storageKey, null); }} />;
}
