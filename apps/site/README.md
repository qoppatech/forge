# @forge/site

FORGE landing page (`/`) and documentation (`/docs`), built with Next.js, Fumadocs, Tailwind CSS and shadcn/ui. The site is a static export deployed to GitHub Pages by `.github/workflows/pages.yml`.

```sh
bun run dev:site                    # from the repository root
bun run --cwd apps/site build       # static export to apps/site/out
```

- Theme: `app/global.css` maps the FORGE tokens from `docs/brand/forge-tokens.css` onto shadcn variables; Fumadocs reads them through `fumadocs-ui/css/shadcn.css`. Follow `DESIGN.md` for any visual change.
- Docs content: `content/docs/*.mdx`, ordered by `content/docs/meta.json`.
- Landing sections: `components/landing/`. Copy and sample figures live in `components/landing/content.ts`; keep them consistent with the program and label every sample.
- `components/ui/`, `hooks/` and `lib/compose-refs.ts` are vendored registry components (shadcn, coss, Magic UI, Dice UI) and are excluded from lint.
- GitHub Pages serves the site under `/<repo>`. CI sets `NEXT_PUBLIC_BASE_PATH` and `NEXT_PUBLIC_SITE_URL`; raw URLs that bypass `next/link` must use `basePath` from `lib/shared.ts`.
