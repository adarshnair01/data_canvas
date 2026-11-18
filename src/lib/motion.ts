/**
 * Animation helpers. Every effect checks `prefers-reduced-motion` and falls back to the final
 * state instantly. Only opacity and transforms are animated, so nothing triggers layout.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { animate, stagger } from "animejs";
import { interpolateNumber } from "d3-interpolate";

const REDUCED = "(prefers-reduced-motion: reduce)";

/** True when the user asked for reduced motion (or when there is no way to tell, e.g. tests). */
export function reducedMotion(): boolean {
  return typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia(REDUCED).matches;
}

/** Fade-and-rise a group of elements one after another (Anime.js stagger). */
export function staggerIn(
  targets: Element[],
  { step = 45, start = 0, distance = 10 }: { step?: number; start?: number; distance?: number } = {},
): () => void {
  if (!targets.length || reducedMotion()) return () => {};
  const a = animate(targets, {
    opacity: { from: 0 },
    translateY: { from: distance },
    duration: 460,
    delay: stagger(step, { start }),
    ease: "outCubic",
    // Drop the inline styles afterwards so hover transforms and layout stay untouched.
    onComplete: (self) => self.revert(),
  });
  return () => a.revert();
}

/** Stagger the children matching `selector` inside `ref` whenever `key` changes. */
export function useStaggerIn(
  ref: RefObject<HTMLElement | null>,
  selector: string,
  key: unknown,
  opts?: Parameters<typeof staggerIn>[1],
) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    return staggerIn(Array.from(root.querySelectorAll(selector)), optsRef.current);
  }, [ref, selector, key]);
}

/** A number that counts up from 0, then eases between later values (d3-interpolate + rAF). */
export function useTweenedNumber(target: number | null, duration = 700): number | null {
  const [initial] = useState(() => (target === null || reducedMotion() ? target : 0));
  const [shown, setShown] = useState(initial);
  const from = useRef(initial);
  useEffect(() => {
    if (target === null || from.current === null || reducedMotion() || from.current === target) {
      from.current = target;
      setShown(target);
      return;
    }
    const interp = interpolateNumber(from.current, target);
    const t0 = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      const v = interp(1 - Math.pow(1 - t, 3));
      from.current = v;
      setShown(t < 1 ? v : target);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);
  return shown;
}

/** Live `prefers-reduced-motion` value for components that switch strategies. */
export function useReducedMotionPref(): boolean {
  const [reduced, setReduced] = useState(reducedMotion);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(REDUCED);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}
