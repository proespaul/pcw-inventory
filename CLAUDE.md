# Working in this repo

Freezer inventory and orders for Peace Country Wagyu. One HTML file served by
GitHub Pages, backed by an Apps Script web app. No build step, no dependencies.

## First move, every session

A fresh session has **no repos attached** and the git proxy will refuse to push
until this one is. Before anything else:

1. `add_repo` with `owner: proespaul`, `repo: pcw-inventory`, `access: push`
2. clone where it tells you to, one clone, generous timeout
3. `register_repo_root` so this file loads

If `add_repo` is not in the session's tools, say so plainly and stop — do not
hand Paul the changed files to paste somewhere. Pasting is the thing this repo
exists to stop. Tell him which chat it worked in and let him carry on there.

## Never

- **Never hand Paul files to paste.** The repo is the source of truth; push.
- **Never edit in the Apps Script editor.** The next commit overwrites it.
- **Never paste an older `Code.gs` over the deployed one.** Check what is live
  first: `curl "$EXEC_URL?action=ping"` reports the build it is running.

## Shipping a change

```
node apps-script/test/run.js               # backend, against a fake Sheet
npm install --no-save jsdom@31.0.1         # pinned — see below
node apps-script/test/ui.js                # the page, loaded in a headless DOM
```

Both must pass. Then bump `APP_BUILD` in `index.html` and `BACKEND_BUILD` in
`apps-script/Code.gs` to the current UTC time, commit, push to `main`.

Pushing to `main` runs **Tests**, and `apps-script/**` also runs **Deploy
backend to Apps Script**, which re-runs the backend checks before it pushes
anything live — a failing suite cannot reach the `/exec` URL. Watch the run,
then confirm the live backend reports the new build and Pages serves the new
`index.html`. Not deployed until both say so.

Bump `CACHE` in `sw.js` when a change to `index.html` must reach his phone on
the next open rather than the one after.

## Looking at it

Chrome is usually installed in the workspace (`/usr/bin/google-chrome`), so a
visual change can be rendered at phone size, light and dark, and actually
looked at before pushing. Do that for anything visual. A markup check confirms
text is present; it cannot tell you the text reads wrong. A deposit cell once
drew a bare em dash in the figure's place, same size and weight as a real
price — every markup check passed, and it still looked like a price.

Paul is a visual learner. Send him the render, not a description of it.

## Things that have bitten

- **Pin test dependencies.** jsdom unpinned resolved a different major in CI,
  which disagreed about whether a `padding-left` longhand beats a `padding`
  shorthand. The checks failed on a page that was correct. Pinned at 31.0.1,
  and the workflows run Node 22 to match.
- **`.claspignore` ships only `*.gs` and `appsscript.json`** from
  `apps-script/`. The test files live under there and must never go up.
- **The WHOLESALE tab has no key of its own** and two customers can share a
  name, so a line is edited by its sheet row. Every write quotes the row *and*
  the name the app holds for it; the backend refuses if that row reads somebody
  else now. Keep that guard on any new write path — rows get inserted and
  sorted in the Sheet by hand.
- **An invoice or a hanging weight means the animal went out**, whatever the
  Status column says. The money is the harder fact.
- **`readTable_` drops blank rows**, so its index lies about where a line is.
  Use `wholesaleRows_()` where a real row number is needed.
