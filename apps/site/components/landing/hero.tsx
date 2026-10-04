import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { GridPattern } from "@/components/ui/grid-pattern";
import { repoUrl } from "@/lib/shared";
import { cn } from "@/lib/utils";

import { ApprovalPanel } from "./approval-panel";
import { Container } from "./section";

const facts = [
  ["8", "Program instructions"],
  ["2", "Distinct approvals per loan"],
  ["4", "Loan states"],
  ["0", "Deployments: local sandbox"],
];

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <GridPattern
        width={48}
        height={48}
        squares={[
          [12, 1],
          [27, 1],
          [3, 12],
        ]}
        className="fill-accent stroke-border/80"
      />
      <Container className="relative">
        <div className="grid items-center gap-12 pt-16 pb-16 md:pt-24 lg:grid-cols-12 lg:gap-8 lg:pb-24">
          <div className="lg:col-span-7">
            <Badge variant="outline" size="lg" className="bg-background">
              Developer sandbox · Solana
            </Badge>
            <h1 className="mt-8 text-[40px] leading-[1.08] font-light tracking-[-0.025em] md:text-[72px]">
              Banking infrastructure.
              <br />
              <span className="text-primary">Onchain.</span>
            </h1>
            <p className="text-muted-foreground mt-6 max-w-xl text-lg">
              FORGE connects existing banking systems with programmable
              financial operations on Solana. It starts with bank-controlled
              lending: a funded vault, two independent approvals, and terms that
              cannot change after proposal.
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
                  "bg-background"
                )}
              >
                View source
              </a>
            </div>
          </div>
          <div className="lg:col-span-5">
            <ApprovalPanel />
          </div>
        </div>
      </Container>
      <div className="border-border bg-background relative border-t">
        <Container>
          <dl className="grid grid-cols-2 md:grid-cols-4">
            {facts.map(([value, label], i) => (
              <div
                key={label}
                className={`border-border py-6 md:py-8 ${
                  i % 2 === 1
                    ? "border-l pl-4 md:pl-8 "
                    : "md:pl-8 md:first:pl-0 "
                }${
                  i >= 2 ? "border-t md:border-t-0 " : ""
                }${i === 2 ? "md:border-l " : ""}`}
              >
                <dd className="tabular text-[26px] leading-[1.2] md:text-[32px]">
                  {value}
                </dd>
                <dt className="text-muted-foreground mt-1 text-sm">{label}</dt>
              </div>
            ))}
          </dl>
        </Container>
      </div>
    </section>
  );
}
