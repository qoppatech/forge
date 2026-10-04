import {
  CodeBlockTab,
  CodeBlockTabs,
  CodeBlockTabsList,
  CodeBlockTabsTrigger,
} from "fumadocs-ui/components/codeblock";
import { ServerCodeBlock } from "fumadocs-ui/components/codeblock.rsc";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";

import { codeSamples } from "./content";
import { Eyebrow, Section, SectionTitle } from "./section";

const tabs = [
  {
    code: codeSamples.rust,
    label: "Anchor program",
    lang: "rust",
    value: "rust",
  },
  { code: codeSamples.ts, label: "@forge/sdk", lang: "ts", value: "ts" },
  { code: codeSamples.sh, label: "Build & test", lang: "sh", value: "sh" },
] as const;

const facts = [
  ["Program", "Rust · Anchor 1.2.0"],
  ["Tests", "Compiled program in LiteSVM"],
  ["SDK", "TypeScript IDL, types, program ID"],
  ["Toolchain", "Pinned with Nix flakes"],
];

export function Developer() {
  return (
    <Section id="developers">
      <Eyebrow index="04">Developers</Eyebrow>
      <div className="grid gap-12 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <SectionTitle>
            Built to be read by the engineers who will integrate it.
          </SectionTitle>
          <dl className="divide-border border-border mt-10 divide-y border-y text-sm">
            {facts.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 py-3">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="text-right">{v}</dd>
              </div>
            ))}
          </dl>
          <Link
            href="/docs/getting-started"
            className="text-primary mt-8 inline-flex items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline"
          >
            Getting started
            <ArrowUpRight aria-hidden className="size-4" />
          </Link>
        </div>
        <div className="min-w-0 lg:col-span-7">
          <CodeBlockTabs defaultValue="rust">
            <CodeBlockTabsList>
              {tabs.map((t) => (
                <CodeBlockTabsTrigger key={t.value} value={t.value}>
                  {t.label}
                </CodeBlockTabsTrigger>
              ))}
            </CodeBlockTabsList>
            {tabs.map((t) => (
              <CodeBlockTab key={t.value} value={t.value}>
                <ServerCodeBlock
                  code={t.code}
                  lang={t.lang}
                  codeblock={{ className: "my-0 rounded-sm shadow-none" }}
                />
              </CodeBlockTab>
            ))}
          </CodeBlockTabs>
        </div>
      </div>
    </Section>
  );
}
