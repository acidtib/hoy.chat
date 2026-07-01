"use client";

import { useEffect, useRef, type ReactNode } from "react";

// Wraps the hero product window. Adds two premium-but-cheap cues:
//  - a subtle pointer-driven perspective tilt (pointer devices only), and
//  - a slow scroll parallax (the window drifts up as the page scrolls).
// Both are transform-only, disabled under reduced-motion / coarse pointers, and
// the element renders fully visible with no JS (enhancement, never a gate).
export function HeroStage({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fine = window.matchMedia("(pointer: fine)").matches;
    if (reduce) return;

    let rx = 0;
    let ry = 0;
    let py = 0;
    let raf = 0;

    const apply = () => {
      raf = 0;
      el.style.setProperty("--rx", `${rx.toFixed(2)}deg`);
      el.style.setProperty("--ry", `${ry.toFixed(2)}deg`);
      el.style.setProperty("--py", `${py.toFixed(1)}px`);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };

    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const cx = (e.clientX - r.left) / r.width - 0.5;
      const cy = (e.clientY - r.top) / r.height - 0.5;
      ry = cx * 5;
      rx = -cy * 4;
      schedule();
    };
    const onLeave = () => {
      rx = 0;
      ry = 0;
      schedule();
    };
    const onScroll = () => {
      const r = el.getBoundingClientRect();
      const progress = Math.min(Math.max(-r.top / window.innerHeight, -0.5), 1);
      py = -progress * 46;
      schedule();
    };

    if (fine) {
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerleave", onLeave);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
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
