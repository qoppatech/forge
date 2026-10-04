import { CircleCheck, Clock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { ASSET } from "./content";
import { SampleLabel } from "./section";

const rows: [label: string, value: string, mono?: boolean][] = [
  ["Principal", `5,000.000000 ${ASSET}`],
  ["Fixed payoff", `5,100.000000 ${ASSET}`],
  ["Rate for term", "200 bps"],
  ["Term", "30 days"],
  ["Borrower", "7xKX…9fQ2", true],
  ["Destination", "Gq4T…mN8c", true],
];

/** Specimen of the approval panel described in DESIGN.md. Values are illustrative. */
export function ApprovalPanel() {
  return (
    <Card className="gap-0 py-0 shadow-none">
      <CardHeader className="border-border flex items-center justify-between border-b px-5 py-4">
        <div>
          <SampleLabel />
          <CardTitle className="mt-1 text-base font-medium">
            Loan L-0042
          </CardTitle>
        </div>
        <Badge variant="warning">
          <Clock aria-hidden />1 of 2 approvals
        </Badge>
      </CardHeader>
      <CardContent className="px-5 py-0">
        <dl className="divide-border divide-y">
          {rows.map(([label, value, mono]) => (
            <div
              key={label}
              className="flex items-baseline justify-between gap-4 py-3 text-sm"
            >
              <dt className="text-muted-foreground">{label}</dt>
              <dd
                className={
                  mono
                    ? "font-mono text-[13px]"
                    : "tabular text-right font-medium"
                }
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
      <div className="border-border grid grid-cols-2 border-t text-sm">
        <div className="border-border border-r px-5 py-4">
          <p className="text-muted-foreground text-xs">Approver A</p>
          <p className="text-success mt-1 flex items-center gap-1.5 font-medium">
            <CircleCheck aria-hidden className="size-4" />
            Approved
          </p>
        </div>
        <div className="px-5 py-4">
          <p className="text-muted-foreground text-xs">Approver B</p>
          <p className="mt-1 font-medium">Awaiting second approval</p>
        </div>
      </div>
      <div className="border-border bg-muted/60 flex items-center justify-between border-t px-5 py-3 text-xs">
        <span className="text-muted-foreground">Disbursement</span>
        <span className="font-medium">Not submitted</span>
      </div>
    </Card>
  );
}
