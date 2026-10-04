import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

import { appName, repoUrl } from "./shared";

// Typeset placeholder until the Monolith mark has a vector master (see DESIGN.md, Logo directions).
export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-[0.08em]">
      <span aria-hidden className="bg-primary size-2.5" />
      {appName}
    </span>
  );
}

export function baseOptions(): BaseLayoutProps {
  return {
    githubUrl: repoUrl,
    links: [{ active: "nested-url", text: "Docs", url: "/docs" }],
    nav: {
      title: <Wordmark />,
    },
    themeSwitch: { mode: "light-dark" },
  };
}
