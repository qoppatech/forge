import { ArrowRight, Check, Minus } from "lucide-react";
import Link from "next/link";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { buttonVariants } from "@/components/ui/button";
import { Wordmark } from "@/lib/layout.shared";
import { repoUrl } from "@/lib/shared";
import { cn } from "@/lib/utils";

import { controls, faqs, principles, status } from "./content";
import { Container, Eyebrow, Section, SectionTitle } from "./section";

export function Principles() {
  return (
    <Section id="approach">
      <Eyebrow index="01">Approach</Eyebrow>
      <SectionTitle>
        Banks already run systems they trust. FORGE adds programmable operations
        without asking them to trust an interface.
      </SectionTitle>
      <div className="border-border mt-12 grid border-t md:grid-cols-3">
        {principles.map((p, i) => (
          <div
            key={p.title}
            className="border-border border-b py-8 md:border-b-0 md:pr-8 md:not-first:border-l md:not-first:pl-8"
          >
            <p className="tabular text-muted-foreground font-mono text-xs">
              0{i + 1}
            </p>
            <h3 className="mt-4 text-lg font-medium">{p.title}</h3>
            <p className="text-muted-foreground mt-2">{p.body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

export function Controls() {
  return (
    <Section id="controls">
      <Eyebrow index="03">Controls</Eyebrow>
      <SectionTitle>
        Every rule is a program check, with a named failure.
      </SectionTitle>
      <div className="border-border bg-border mt-12 grid gap-px overflow-hidden border sm:grid-cols-2 lg:grid-cols-3">
        {controls.map((c) => (
          <div key={c.title} className="bg-background flex flex-col p-6 md:p-8">
            <h3 className="font-medium">{c.title}</h3>
            <p className="text-muted-foreground mt-2 flex-1 text-sm">
              {c.body}
            </p>
            <code className="bg-muted text-foreground mt-6 w-fit rounded-sm px-2 py-1 font-mono text-xs">
              {c.code}
            </code>
          </div>
        ))}
      </div>
    </Section>
  );
}

function StatusList({
  title,
  items,
  done,
}: {
  title: string;
  items: string[];
  done?: boolean;
}) {
  const Icon = done ? Check : Minus;
  return (
    <div>
      <p className="border-border border-b pb-3 text-sm font-medium">{title}</p>
      <ul className="divide-border divide-y">
        {items.map((item) => (
          <li key={item} className="flex gap-3 py-3 text-sm">
            <Icon
              aria-hidden
              className={
                done
                  ? "text-success mt-0.5 size-4 shrink-0"
                  : "text-muted-foreground mt-0.5 size-4 shrink-0"
              }
            />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Status() {
  return (
    <Section id="status">
      <Eyebrow index="05">Status</Eyebrow>
      <div className="grid gap-12 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <SectionTitle>A sandbox, described plainly.</SectionTitle>
          <p className="text-muted-foreground mt-4 max-w-md">
            FORGE is a local prototype. It is not an audited protocol, a
            deployed program or a custody system. Here is exactly where it
            stands.
          </p>
        </div>
        <div className="grid gap-8 sm:grid-cols-2 lg:col-span-7">
          <StatusList title="Implemented" items={status.implemented} done />
          <StatusList title="Not yet" items={status.notYet} />
        </div>
      </div>
      <div className="mt-16 grid gap-12 lg:grid-cols-12">
        <h3 className="text-lg font-medium lg:col-span-5">
          Questions a bank engineer asks first
        </h3>
        <Accordion className="border-border border-t lg:col-span-7">
          {faqs.map((f) => (
            <AccordionItem
              key={f.q}
              value={f.q}
              className="border-border border-b"
            >
              <AccordionTrigger className="rounded-none py-5 text-base hover:no-underline">
                {f.q}
              </AccordionTrigger>
              <AccordionContent className="text-muted-foreground pb-5">
                {f.a}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </Section>
  );
}

export function FinalCta() {
  return (
    <section className="border-border bg-foreground text-background dark:bg-card dark:text-foreground border-t py-24 md:py-32">
      <Container>
        <h2 className="max-w-4xl text-[40px] leading-[1.08] font-light tracking-[-0.025em] text-balance md:text-[72px]">
          Read the rules before you trust them.
        </h2>
        <p className="text-background/70 dark:text-muted-foreground mt-6 max-w-xl text-lg">
          The documentation covers the lifecycle, the accounts, every error and
          every limit of the sandbox.
        </p>
        <div className="mt-10 flex flex-wrap gap-3">
          <Link href="/docs" className={buttonVariants({ size: "lg" })}>
            Read the docs
            <ArrowRight data-icon="inline-end" aria-hidden />
          </Link>
          <a
            href={repoUrl}
            className={cn(
              buttonVariants({ size: "lg", variant: "outline" }),
              "border-background/40 text-background hover:bg-background/10 dark:border-control dark:text-foreground dark:hover:bg-muted"
            )}
          >
            View source on GitHub
          </a>
        </div>
      </Container>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="border-border border-t py-10">
      <Container className="text-muted-foreground flex flex-col gap-6 text-sm md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-6">
          <span className="text-foreground">
            <Wordmark />
          </span>
          <span>
            Developer sandbox. Not a banking service. Test assets only.
          </span>
        </div>
        <nav className="flex gap-6">
          <Link href="/docs" className="hover:text-foreground">
            Docs
          </Link>
          <Link href="/docs/limitations" className="hover:text-foreground">
            Limitations
          </Link>
          <a href={repoUrl} className="hover:text-foreground">
            GitHub
          </a>
        </nav>
      </Container>
    </footer>
  );
}
