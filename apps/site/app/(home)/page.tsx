import { Developer } from "@/components/landing/developer";
import { Hero } from "@/components/landing/hero";
import { Lifecycle } from "@/components/landing/lifecycle";
import { Reveal } from "@/components/landing/reveal";
import { Eyebrow, Section, SectionTitle } from "@/components/landing/section";
import {
  Controls,
  FinalCta,
  Footer,
  Principles,
  Status,
} from "@/components/landing/sections";

export default function HomePage() {
  return (
    <>
      <Hero />
      <Reveal>
        <Principles />
      </Reveal>
      <Section id="lifecycle">
        <Reveal>
          <Eyebrow index="02">Lifecycle</Eyebrow>
          <SectionTitle>One loan, from funded vault to repayment.</SectionTitle>
          <p className="text-muted-foreground mt-4 max-w-2xl">
            Select a step to see the vault as the program records it. Every
            transition is an instruction with a required signer.
          </p>
        </Reveal>
        {/* Not wrapped in Reveal: balances display immediately (DESIGN.md, Motion). */}
        <Lifecycle />
      </Section>
      <Reveal>
        <Controls />
      </Reveal>
      <Reveal>
        <Developer />
      </Reveal>
      <Reveal>
        <Status />
      </Reveal>
      <FinalCta />
      <Footer />
    </>
  );
}
