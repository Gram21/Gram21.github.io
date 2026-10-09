# janke.im

Source of the personal website of Jan Keim at [janke.im](https://janke.im).
The site uses the [astro-studia](https://github.com/dfuchss/astro-studia) template and [Astro](https://astro.build/).

## Develop

Use Node 22 or newer.

```bash
npm install
npm run dev
```

## Verify

```bash
npm run check
npm run build
npm run audit
```

## Content

| Path                  | Content                                   |
| --------------------- | ----------------------------------------- |
| `src/consts.ts`       | Site URL, email, name                     |
| `src/features.ts`     | Enabled site areas                        |
| `src/content/pages/`  | Page text (home, tagline, footer, nav)    |
| `src/content/posts/`  | Blog posts, named `YYYY-MM-DD-slug.md`    |
| `src/data/papers.bib` | Publications                              |
| `src/data/`           | Socials, contact, repositories            |
| `public/`             | Static files (CNAME, PDFs, keybase proof) |

The template documentation is in `docs/`.

## Deploy

A push to `master` starts `.github/workflows/deploy.yml`.
The workflow builds and audits the site, then publishes `dist/` to the `gh-pages` branch.
