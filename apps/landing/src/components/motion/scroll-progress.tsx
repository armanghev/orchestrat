"use client";

import React from "react";
import { motion, useScroll, useSpring, useReducedMotion } from "motion/react";

export function ScrollProgress() {
  const shouldReduceMotion = useReducedMotion();
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, {
    stiffness: 200,
    damping: 30,
    restDelta: 0.001
  });

  if (shouldReduceMotion) return null;

  return (
    <motion.div
      className="bg-primary fixed top-0 right-0 left-0 z-[60] h-[2px] origin-left shadow-[0_0_8px_rgba(16,185,129,0.8)]"
      style={{ scaleX }}
    />
  );
}
