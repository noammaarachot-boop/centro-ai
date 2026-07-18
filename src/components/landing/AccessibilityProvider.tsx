"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type A11yPrefs = {
  fontStep: number; // index into FONT_STEPS
  highContrast: boolean;
  grayscale: boolean;
  underlineLinks: boolean;
  reducedMotion: boolean;
};

export const FONT_STEPS = [0.9, 1, 1.1, 1.2, 1.3] as const;
const DEFAULT_STEP = 1; // index of "1" (100%) inside FONT_STEPS

const DEFAULT_PREFS: A11yPrefs = {
  fontStep: DEFAULT_STEP,
  highContrast: false,
  grayscale: false,
  underlineLinks: false,
  reducedMotion: false,
};

const STORAGE_KEY = "centro-a11y-prefs";

type A11yContextValue = {
  prefs: A11yPrefs;
  increaseFontSize: () => void;
  decreaseFontSize: () => void;
  toggle: (key: "highContrast" | "grayscale" | "underlineLinks" | "reducedMotion") => void;
  reset: () => void;
};

const A11yContext = createContext<A11yContextValue | null>(null);

function readStoredPrefs(): A11yPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function AccessibilityProvider({ children }: { children: React.ReactNode }) {
  // Lazy initializer: on the server this yields DEFAULT_PREFS (no window),
  // on the client it reads localStorage synchronously on first render —
  // no extra render pass, and nothing here affects the provider's own
  // (prefs-independent) JSX output, so there's no hydration mismatch.
  const [prefs, setPrefs] = useState<A11yPrefs>(() => readStoredPrefs());

  // Apply prefs to the document root and persist them.
  useEffect(() => {
    const root = document.documentElement;
    const scale = FONT_STEPS[prefs.fontStep] ?? 1;
    root.style.fontSize = scale === 1 ? "" : `${scale * 100}%`;
    root.dataset.a11yContrast = prefs.highContrast ? "high" : "";
    root.dataset.a11yGrayscale = prefs.grayscale ? "true" : "";
    root.dataset.a11yUnderline = prefs.underlineLinks ? "true" : "";
    root.dataset.a11yMotion = prefs.reducedMotion ? "reduced" : "";

    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // localStorage unavailable (private mode, etc.) — fail silently.
    }
  }, [prefs]);

  const increaseFontSize = useCallback(() => {
    setPrefs((p) => ({
      ...p,
      fontStep: Math.min(FONT_STEPS.length - 1, p.fontStep + 1),
    }));
  }, []);

  const decreaseFontSize = useCallback(() => {
    setPrefs((p) => ({ ...p, fontStep: Math.max(0, p.fontStep - 1) }));
  }, []);

  const toggle = useCallback(
    (key: "highContrast" | "grayscale" | "underlineLinks" | "reducedMotion") => {
      setPrefs((p) => ({ ...p, [key]: !p[key] }));
    },
    []
  );

  const reset = useCallback(() => setPrefs(DEFAULT_PREFS), []);

  const value = useMemo(
    () => ({ prefs, increaseFontSize, decreaseFontSize, toggle, reset }),
    [prefs, increaseFontSize, decreaseFontSize, toggle, reset]
  );

  return <A11yContext.Provider value={value}>{children}</A11yContext.Provider>;
}

export function useAccessibility() {
  const ctx = useContext(A11yContext);
  if (!ctx) {
    throw new Error("useAccessibility must be used within AccessibilityProvider");
  }
  return ctx;
}
