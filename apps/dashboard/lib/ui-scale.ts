"use client";

export type UiScale = "normal" | "large" | "extra";

export const UI_SCALE_STORAGE_KEY = "inbox_os_ui_scale";
export const UI_SCALE_CHANGE_EVENT = "inbox-ui-scale";
export const DEFAULT_UI_SCALE: UiScale = "normal";

export const UI_SCALE_ORDER: readonly UiScale[] = ["normal", "large", "extra"];

export const UI_SCALE_OPTIONS: Array<{ id: UiScale; label: string }> = [
  { id: "normal", label: "Normal" },
  { id: "large", label: "Large" },
  { id: "extra", label: "Extra" }
];

export function parseUiScale(raw: string | null | undefined): UiScale {
  return raw === "large" || raw === "extra" ? raw : DEFAULT_UI_SCALE;
}

export function readUiScale(): UiScale {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.getAttribute("data-ui-scale");
    if (attr === "large" || attr === "extra") return attr;
    if (attr === null && typeof window !== "undefined") {
      try {
        return parseUiScale(window.localStorage.getItem(UI_SCALE_STORAGE_KEY));
      } catch {
        return DEFAULT_UI_SCALE;
      }
    }
    return DEFAULT_UI_SCALE;
  }
  return DEFAULT_UI_SCALE;
}

export function stepUiScale(current: UiScale, direction: "up" | "down"): UiScale {
  const index = UI_SCALE_ORDER.indexOf(current);
  const base = index === -1 ? 0 : index;
  const next = direction === "down" ? base - 1 : base + 1;
  const clamped = Math.max(0, Math.min(UI_SCALE_ORDER.length - 1, next));
  return UI_SCALE_ORDER[clamped]!;
}

export function applyUiScale(next: UiScale): UiScale {
  const level = parseUiScale(next);
  if (typeof document !== "undefined") {
    if (level === "normal") document.documentElement.removeAttribute("data-ui-scale");
    else document.documentElement.setAttribute("data-ui-scale", level);
  }
  if (typeof window !== "undefined") {
    try {
      if (level === "normal") window.localStorage.removeItem(UI_SCALE_STORAGE_KEY);
      else window.localStorage.setItem(UI_SCALE_STORAGE_KEY, level);
    } catch {
      // The DOM attribute still applies when storage is unavailable.
    }
    window.dispatchEvent(new CustomEvent(UI_SCALE_CHANGE_EVENT, { detail: { scale: level } }));
  }
  return level;
}

export function nudgeUiScale(direction: "up" | "down"): UiScale {
  return applyUiScale(stepUiScale(readUiScale(), direction));
}

export function onUiScaleChange(handler: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === UI_SCALE_STORAGE_KEY) handler();
  };
  window.addEventListener(UI_SCALE_CHANGE_EVENT, handler);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(UI_SCALE_CHANGE_EVENT, handler);
    window.removeEventListener("storage", onStorage);
  };
}

export interface UiScaleBridge {
  get(): UiScale;
  set(next: UiScale): UiScale;
  step(direction: "up" | "down"): UiScale;
}

export function installUiScaleBridge(): void {
  if (typeof window === "undefined") return;
  const bridge: UiScaleBridge = {
    get: readUiScale,
    set: (next) => applyUiScale(next),
    step: (direction) => nudgeUiScale(direction === "down" ? "down" : "up")
  };
  (window as unknown as { __toviUiScale?: UiScaleBridge }).__toviUiScale = bridge;
}
