# dephantom.dev

The site has two pages: a project homepage with usage, maintainer guidance and contribution instructions, and a package directory with expandable rules and evidence. Package names are deduplicated across version selectors and sorted by weekly npm download estimates from `inputs/downloads.json`. Missing estimates appear last, not as zero downloads.

```sh
nub --node site/build.mjs
nub --node --test site/*.test.mjs
nub --node site/smoke.mjs https://dephantom.vercel.app
python3 -m http.server 3107 --bind 127.0.0.1 --directory site/public
```

The generated `site/public/` directory is ignored by Git. The build needs Node 24 and no installed packages. Each directory entry links to the source revision used for the build. Old guide, about and package-detail URLs redirect to the two retained pages.

The daily rebuild runs `node harness/downloads.mjs` to collect a single seven-day reporting period from npm. Scoped packages are queried individually; unscoped names use batches of at most 128. Rate limits back off, and exhausted request errors preserve the previous dated snapshot. Counts cover all versions and do not measure affected installations or unique users.

## Images and metadata

The editable logo and social cards are SVG sources. Raster outputs are checked in, so Vercel needs no graphics tools:

```sh
rsvg-convert site/social-home.svg -o site/social-home.png
rsvg-convert site/social-packages.svg -o site/social-packages.png
rsvg-convert -w 32 -h 32 site/favicon.svg -o site/favicon-32.png
rsvg-convert -w 180 -h 180 site/favicon.svg -o site/apple-touch-icon.png
```

The social cards are 1200 × 630 PNGs. Both pages have unique titles and descriptions, canonical URLs, Open Graph and Twitter large-image metadata. The homepage includes WebSite structured data. The sitemap lists only the two canonical pages; the error page is noindex. Tests check metadata, image dimensions, links and directory coverage.

The canonical origin is currently `https://dephantom.vercel.app`. Change `origin` in `site/build.mjs` only after the custom domain serves HTTPS; it controls canonical URLs, structured data, social image URLs, sitemap and robots together.

## Deployment

Vercel builds the repository root using `vercel.json`. The `dephantom` project is connected to `nubjs/package-extensions`, with `main` as its production branch. A committed dataset update triggers a site rebuild independently of npm publication.

Git deployments supply `VERCEL_GIT_COMMIT_SHA`. For a CLI deployment, pass the source revision explicitly:

```sh
vercel deploy --scope pullfrog \
  --build-env VERCEL_GIT_COMMIT_SHA=$(git rev-parse HEAD)
```

The website only serves static files. Search and filtering run in the browser; they do not send queries to a server. No analytics or third-party scripts are included.
