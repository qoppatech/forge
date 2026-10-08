import { useState } from "react";
import type { ReactNode } from "react";

import { ASSET, short, tokens } from "./format";

type Tone = "success" | "warning" | "error" | "info" | "neutral";

const TONE_ICON: Record<Tone, string> = {
  error: "■",
  info: "◆",
  neutral: "○",
  success: "●",
  warning: "◐",
};

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`badge badge-${tone}`}>
      <span aria-hidden="true">{TONE_ICON[tone]}</span> {children}
    </span>
  );
}

export function Amount({
  base,
  unit = true,
}: {
  base: string | bigint | null | undefined;
  unit?: boolean;
}) {
  return (
    <span className="numeric">
      {tokens(base)}
      {unit && <span className="unit"> {ASSET}</span>}
    </span>
  );
}

/** Abbreviated identifier with a copy action exposing the full value. */
export function Id({
  value,
  size = 4,
}: {
  value: string | null | undefined;
  size?: number;
}) {
  const [copied, setCopied] = useState(false);
  if (!value) {
    return <span className="muted">—</span>;
  }
  return (
    <button
      type="button"
      className="id"
      title={value}
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? "copied" : short(value, size)}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Section({
  id,
  title,
  aside,
  children,
}: {
  id: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="section" aria-labelledby={`${id}-title`}>
      <header className="section-header">
        <h2 id={`${id}-title`}>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

/** Horizontally scrollable table container that keyboard users can focus and scroll. */
export function ScrollRegion({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section
      className="table-wrap"
      aria-label={label}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable region must be keyboard-focusable to scroll (WCAG 2.1.1)
      tabIndex={0}
    >
      {children}
    </section>
  );
}

const THEME_KEY = "forge.theme";

/** Light by default; dark only when the operator chose it (DESIGN.md, implementation guide). */
export function storedTheme(): "light" | "dark" {
  return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
}

export function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.dataset.theme === "dark"
  );
  return (
    <button
      type="button"
      className="secondary"
      aria-pressed={dark}
      onClick={() => {
        const next = dark ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        localStorage.setItem(THEME_KEY, next);
        setDark(!dark);
      }}
    >
      Dark theme
    </button>
  );
}

export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}
