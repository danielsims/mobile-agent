import { useState, useEffect, useCallback } from "react";

export type Theme = "light" | "dark" | "system";

export interface Settings {
  theme: Theme;
  colorfulGitLabels: boolean;
}

const STORAGE_KEY = "mobile-agent-settings";

const DEFAULTS: Settings = {
  theme: "dark",
  colorfulGitLabels: true,
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return DEFAULTS;
}

function saveSettings(settings: Settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function getEffectiveTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

const DARK_VARS: Record<string, string> = {
  "--bg": "#13120a",
  "--bg-subtle": "#1b1912",
  "--bg-hover": "#23221a",
  "--bg-active": "#2c2b22",
  "--border": "#2a2920",
  "--text": "#edecec",
  "--text-secondary": "#8a8980",
  "--text-muted": "#5c5b52",
  "--accent": "#5a9bf0",
  "--unread": "#f5f5f0",
  "--starred": "#e6b828",
  "--danger": "#ef4444",
  "--kbd-bg": "rgba(255, 255, 255, 0.08)",
  "--kbd-color": "rgba(255, 255, 255, 0.45)",
  "--kbd-border": "rgba(255, 255, 255, 0.1)",
  "--status-running": "#22c55e",
  "--status-awaiting": "#eab308",
  "--status-error": "#ef4444",
  "--status-idle": "#6b7280",
  "--status-starting": "#3b82f6",
  "--status-exited": "#64748b",
};

const LIGHT_VARS: Record<string, string> = {
  "--bg": "#f7f7f4",
  "--bg-subtle": "#f2f1ee",
  "--bg-hover": "#edece8",
  "--bg-active": "#e7e6e1",
  "--border": "#dddcd7",
  "--text": "#26251e",
  "--text-secondary": "#6e6d65",
  "--text-muted": "#a09f97",
  "--accent": "#2563eb",
  "--unread": "#1a1912",
  "--starred": "#b8930a",
  "--danger": "#dc2626",
  "--kbd-bg": "rgba(0, 0, 0, 0.05)",
  "--kbd-color": "rgba(0, 0, 0, 0.4)",
  "--kbd-border": "rgba(0, 0, 0, 0.1)",
  "--status-running": "#16a34a",
  "--status-awaiting": "#ca8a04",
  "--status-error": "#dc2626",
  "--status-idle": "#6b7280",
  "--status-starting": "#2563eb",
  "--status-exited": "#64748b",
};

function applyThemeVars(effective: "light" | "dark") {
  const vars = effective === "light" ? LIGHT_VARS : DARK_VARS;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(loadSettings);

  const updateSetting = useCallback(
    <K extends keyof Settings>(key: K, value: Settings[K]) => {
      setSettings((prev) => {
        const next = { ...prev, [key]: value };
        saveSettings(next);
        return next;
      });
    },
    []
  );

  useEffect(() => {
    applyThemeVars(getEffectiveTheme(settings.theme));
  }, [settings.theme]);

  useEffect(() => {
    if (settings.theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyThemeVars(getEffectiveTheme("system"));
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [settings.theme]);

  return { settings, updateSetting };
}
