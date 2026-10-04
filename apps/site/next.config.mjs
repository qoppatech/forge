import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

// GitHub Pages serves project sites from /<repo>; CI sets this, local dev leaves it empty.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** @type {import('next').NextConfig} */
const config = {
  basePath: basePath || undefined,
  images: { unoptimized: true },
  output: "export",
  reactStrictMode: true,
  trailingSlash: true,
};

export default withMDX(config);
