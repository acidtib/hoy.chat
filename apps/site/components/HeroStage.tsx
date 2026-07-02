"use client";

import { useEffect, useRef, type ReactNode } from "react";

// Wraps the hero product window. Adds one subtle cue: a slow scroll parallax
// (the window drifts up as the page scrolls). Transform-only, disabled under
// reduced-motion, and the element renders fully visible with no JS (enhancement,
// never a gate).
export function HeroStage({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;

    let py = 0;
    let raf = 0;

    const apply = () => {
      raf = 0;
      el.style.setProperty("--py", `${py.toFixed(1)}px`);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };

    const onScroll = () => {
      const r = el.getBoundingClientRect();
      const progress = Math.min(Math.max(-r.top / window.innerHeight, -0.5), 1);
      py = -progress * 46;
      schedule();
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={ref} className="hero-stage">
      {children}
    </div>
  );
}
