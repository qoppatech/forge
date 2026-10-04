import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** 1280px column on a 12-column grid with DESIGN.md page padding (16 / 24 / 32px). */
export function Container({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-[1280px] px-4 md:px-6 lg:px-8",
        className
      )}
    >
      {children}
    </div>
  );
}

export function Section({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn("border-border border-t py-16 md:py-24", className)}
    >
      <Container>{children}</Container>
    </section>
  );
}

/** Small uppercase label with an index, e.g. "02 — Lifecycle". */
export function Eyebrow({
  index,
  children,
}: {
  index: string;
  children: ReactNode;
}) {
  return (
    <p className="text-muted-foreground mb-6 flex items-center gap-3 font-mono text-xs tracking-[0.08em] uppercase">
      <span className="text-primary">{index}</span>
      <span aria-hidden className="bg-border h-px w-8" />
      {children}
    </p>
  );
}

export function SectionTitle({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <h2
      className={cn(
        "max-w-3xl text-[30px] leading-[1.15] font-normal tracking-[-0.02em] text-balance md:text-[40px]",
        className
      )}
    >
      {children}
    </h2>
  );
}

/** Marks illustrative content, per DESIGN.md ("Sample dashboards should be labeled as samples"). */
export function SampleLabel({
  children = "Sample data",
}: {
  children?: ReactNode;
}) {
  return (
    <span className="text-muted-foreground font-mono text-[11px] tracking-[0.08em] uppercase">
      {children}
    </span>
  );
}
