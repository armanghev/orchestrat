"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

/**
 * `inView` is true while the element reaches above the bottom `threshold`
 * share of the viewport. Shrinking the root instead of using an intersection
 * ratio keeps this working for elements taller than the viewport.
 * `ready` turns true once the observer has reported, and `seen` once the
 * element has been on screen. Before `ready` (server render, no JavaScript)
 * demos render in their resting, fully visible state.
 */
export function useInViewport<T extends Element>(threshold = 0.3) {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  const [seen, setSeen] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setReady(true);
        setInView(entry.isIntersecting);
        if (entry.isIntersecting) setSeen(true);
      },
      { rootMargin: `0px 0px -${Math.round(threshold * 100)}% 0px` }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold]);
  return { ref, inView, seen, ready };
}

/** Class for content that animates in the first time its section is seen. */
export function entrance(ready: boolean, seen: boolean) {
  if (!ready) return "";
  return seen ? "enter" : "opacity-0";
}

/**
 * Steps through a scripted demo while it is on screen. `durations[i]` is how
 * long step i stays before advancing. Until the observer reports, and with
 * reduced motion, the demo rests on `restStep` (the last step by default).
 */
export function useSequence<T extends Element>(
  durations: number[],
  {
    loop = true,
    restStep,
    threshold = 0.3
  }: { loop?: boolean; restStep?: number; threshold?: number } = {}
) {
  const { ref, inView, seen, ready } = useInViewport<T>(threshold);
  const reduced = usePrefersReducedMotion();
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const last = durations.length - 1;

  useEffect(() => {
    if (reduced) setStep(restStep ?? last);
  }, [last, reduced, restStep]);

  useEffect(() => {
    if (reduced || paused || !inView) return;
    if (step >= last && !loop) return;
    const id = window.setTimeout(
      () => setStep((current) => (current >= last ? 0 : current + 1)),
      durations[step] ?? 1000
    );
    return () => window.clearTimeout(id);
  }, [durations, inView, last, loop, paused, reduced, step]);

  const restart = useCallback(() => {
    setPaused(false);
    setStep(0);
  }, []);

  return {
    ref,
    inView,
    seen,
    ready,
    reduced,
    step: ready ? step : (restStep ?? last),
    setStep,
    paused,
    setPaused,
    restart,
    done: !loop && step >= last
  };
}
