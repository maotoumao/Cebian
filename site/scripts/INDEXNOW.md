# IndexNow deployment notifications

This is deployment plumbing, not a new analytics tracker. It sends only public page URLs to `https://api.indexnow.org/indexnow` after GitHub Pages deploys successfully.

## Operation

- The repository Actions secret `INDEXNOW_KEY` contains a randomly generated ownership key (8–128 letters, digits or dashes). The build writes its UTF-8 verification file at the site root; the key is not committed to source or printed in logs. `SITE_ORIGIN` is configured in `deploy-site.yml`.
- The `indexnow-manifest` artifact stores SHA-256 hashes of generated HTML for published sitemap URLs, excluding `noindex` pages. Build timestamps are not included. The existing sitemap `lastmod` policy remains unchanged.
- The notification job compares against the latest successful **whole deployment workflow**, not the previous push. Added, changed and removed URLs are included; identical HTML sends nothing. Changes to HTML asset references also change the hash.
- Before sending, the job verifies the live key file and each affected URL. Added/changed HTML must match the built hash (ignoring only the known empty Cloudflare beacon script injected by the CDN); removed URLs must return 301/308/404/410, or 200 with `noindex`.
- The first run, or a run without a retained successful manifest, bootstraps from all current published URLs. Artifacts are retained for 90 days; historical deletions cannot be recovered if the baseline has expired. Do not treat bootstrap as proof all pages recently changed.
- HTTP 200 means notifications were received; 202 means receipt with key validation pending. Neither confirms indexing, ranking or AI citations. The `indexnow-receipt` artifact records the status and exact submitted URL list, without the key.

## Failure and recovery

The notification job runs **after** deployment. A red notification job does not roll back an already published site. Failed notifications do not advance the successful baseline. Errors such as stale CDN HTML, invalid key, timeouts or HTTP 429 are surfaced rather than silently ignored; there is no automatic POST retry loop.

Check the failed step, resolve the problem, then use **Re-run failed jobs** for that run, provided it is still the current deployment. For a superseded run, use a fresh **Run workflow** on `master` instead; live-hash verification intentionally rejects obsolete content. Keep workflow concurrency enabled so a new deployment cannot overtake its predecessor's notification job. If the successful notification was received but saving its receipt failed, retrying may send the same set again.

Do not rotate the key by committing it. Update the repository secret and redeploy so the root verification file and notification key match. Loss of this secret causes preparation to fail before deployment, preserving the previously deployed site.

## Verification

```sh
cd site
pnpm build
pnpm test:seo
```

Tests cover manifest deltas, unchanged builds, removed URLs, mismatched origins, live-content and ownership gates, no-op behavior, 200/202 receipt semantics and error responses. Network requests are replaced only in unit tests; a successful live submission must be verified from the actual workflow and receipt artifact.

Manual acceptance: open the **Deploy Site to GitHub Pages** Actions run, confirm `build`, `deploy`, and `notify` pass, then inspect its summary and download `indexnow-receipt`. Re-running a complete workflow without changing published content should report `no content changes; no request sent`.

Protocol reference: https://www.indexnow.org/documentation
