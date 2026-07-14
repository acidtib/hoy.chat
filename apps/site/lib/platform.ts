"use client";

import { useSyncExternalStore } from "react";
import type { OS } from "./downloads";

function detectOS(): OS | null {
  if (typeof navigator === "undefined") return null;
  const source = `${navigator.userAgent} ${navigator.platform ?? ""}`.toLowerCase();
  if (source.includes("mac")) return "macos";
  if (source.includes("win")) return "windows";
  if (source.includes("linux") || source.includes("x11")) return "linux";
  return null;
}

const subscribe = () => () => {};
const getServerSnapshot = () => null;

export function useDetectedOS(): OS | null {
  return useSyncExternalStore(subscribe, detectOS, getServerSnapshot);
}
