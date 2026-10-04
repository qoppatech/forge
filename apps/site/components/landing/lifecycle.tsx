"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Timeline,
  TimelineContent,
  TimelineDescription,
  TimelineDot,
  TimelineConnector,
  TimelineHeader,
  TimelineItem,
  TimelineTitle,
} from "@/components/ui/timeline";
import { cn } from "@/lib/utils";

import { ASSET, lifecycle } from "./content";
import type { LedgerRow } from "./content";
import { SampleLabel } from "./section";

const stateVariant: Record<
  NonNullable<LedgerRow["state"]>,
  "warning" | "info" | "success" | "outline"
> = {
  Active: "outline",
  Approved: "info",
  Proposed: "warning",
  Repaid: "success",
};

/** Walk through one loan; the ledger shows vault state after the selected step. */
export function Lifecycle() {
  const [active, setActive] = useState(lifecycle.length - 1);

  return (
    <div className="mt-12 grid grid-cols-1 gap-12 lg:grid-cols-12">
      <Timeline activeIndex={active} className="min-w-0 lg:col-span-5">
        {lifecycle.map((step, i) => (
          <TimelineItem key={step.title}>
            <TimelineDot />
            <TimelineConnector />
            <TimelineContent className="pb-2">
              <button
                type="button"
                onClick={() => setActive(i)}
                aria-pressed={i === active}
                className="group w-full rounded-sm text-left"
              >
                <TimelineHeader render={<span className="block" />}>
                  <span className="text-muted-foreground block font-mono text-[11px] tracking-[0.08em] uppercase">
                    {step.signer} ·{" "}
                    <span className="normal-case">{step.instruction}</span>
                  </span>
                  <TimelineTitle
                    render={<span className="block" />}
                    className={cn(
                      "group-hover:text-primary text-base font-medium transition-colors duration-150",
                      i > active && "text-muted-foreground"
                    )}
                  >
                    {step.title}
                  </TimelineTitle>
                </TimelineHeader>
                <TimelineDescription
                  render={<span className="block" />}
                  className="text-muted-foreground mt-1 text-sm"
                >
                  {step.body}
                </TimelineDescription>
              </button>
            </TimelineContent>
          </TimelineItem>
        ))}
      </Timeline>

      <div className="min-w-0 lg:col-span-7">
        <div className="lg:sticky lg:top-24">
          <div className="border-border flex items-baseline justify-between border-b pb-3">
            <p className="text-sm font-medium">Vault ledger</p>
            <SampleLabel>Sample data · {ASSET}</SampleLabel>
          </div>
          <section
            aria-label="Vault ledger"
            // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable region must be keyboard-focusable on narrow screens
            tabIndex={0}
            className="overflow-x-auto"
          >
            <Table className="min-w-[520px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-12">After step</TableHead>
                  <TableHead className="h-12 text-right">Vault cash</TableHead>
                  <TableHead className="h-12 text-right">
                    Outstanding principal
                  </TableHead>
                  <TableHead className="h-12">Loan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lifecycle.map(({ ledger }, i) => (
                  <TableRow
                    key={ledger.step}
                    aria-current={i === active ? "step" : undefined}
                    className={cn(
                      "h-14 transition-colors duration-150 hover:bg-transparent",
                      i === active && "bg-accent hover:bg-accent",
                      i > active && "text-muted-foreground/50"
                    )}
                  >
                    <TableCell className="font-medium">{ledger.step}</TableCell>
                    <TableCell className="tabular text-right">
                      {ledger.vaultCash}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {ledger.outstanding}
                    </TableCell>
                    <TableCell>
                      {ledger.state ? (
                        <Badge
                          variant={
                            i > active ? "outline" : stateVariant[ledger.state]
                          }
                          className={cn(i > active && "opacity-50")}
                        >
                          {ledger.approvals && ledger.state === "Proposed"
                            ? `${ledger.approvals} approvals`
                            : ledger.state}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
          <p className="text-muted-foreground mt-4 text-sm">
            Cash and receivables move separately: after the draw the vault holds
            5,000 in cash and 5,000 in outstanding principal. Repayment returns
            5,100 in cash and clears the receivable.
          </p>
        </div>
      </div>
    </div>
  );
}
