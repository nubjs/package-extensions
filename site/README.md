# dephantom.dev

The site builds a package directory and maintainer guide from the checked-in dataset. Package names are deduplicated across version selectors and ordered by the pinned download ranking in `inputs/corpus.json`. Unranked curated packages follow alphabetically.

```sh
nub --node site/build.mjs
nub --node --test site/*.test.mjs
python3 -m http.server 3107 --bind 127.0.0.1 --directory site/public
```

The generated `site/public/` directory is ignored by Git. The build needs Node 24 and no installed packages. Each package page links to the source revision used for the build.

## Deployment

Vercel builds the repository root using `vercel.json`. The `dephantom` project is connected to `nubjs/package-extensions`, with `main` as its production branch. A committed dataset update triggers a site rebuild independently of npm publication.

Git deployments supply `VERCEL_GIT_COMMIT_SHA`. For a CLI deployment, pass the source revision explicitly:

```sh
vercel deploy --scope pullfrog \
  --build-env VERCEL_GIT_COMMIT_SHA=$(git rev-parse HEAD)
```

The website only serves static files. Search and filtering run in the browser; they do not send queries to a server. No analytics or third-party scripts are included.
