import { createGetUrl } from "fumadocs-core/source";

export const appName = "FORGE";
export const docsRoute = "/docs";
export const docsImageRoute = "/og/docs";
export const docsContentRoute = "/llms.mdx/docs";

/** Prefix for raw asset URLs that bypass next/link (e.g. fetch). Matches next.config basePath. */
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const gitConfig = {
  branch: "main",
  repo: "forge",
  user: "qoppatech",
};

export const repoUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, "content.md"];

  return { segments, url: getContentUrl(segments, page.locale) };
}

const getImageUrl = createGetUrl(docsImageRoute);

export function getPageImageUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, "image.png"];

  return { segments, url: getImageUrl(segments, page.locale) };
}
