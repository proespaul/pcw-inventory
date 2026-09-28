# PCW Inventory

Freezer inventory and orders for Peace Country Wagyu Ltd. A phone app (PWA) on
GitHub Pages, backed by a Google Sheet with an Apps Script web app.

| | |
|---|---|
| **App** | `index.html` — one file, no build step, no dependencies |
| **Backend** | `apps-script/Code.gs` — paste into the Sheet's Apps Script project |
| **Setup** | [`docs/SETUP.md`](docs/SETUP.md) |

## Publishing the app

Settings ▸ Pages ▸ Deploy from a branch ▸ `main` / `root`. The app is then at
`https://proespaul.github.io/pcw-inventory/`.

Everything the browser needs sits in the repo root — `index.html`, `sw.js`,
`manifest.json` and the two icons. Pages serves the root, so those five files
must stay there; `apps-script/` and `docs/` are along for the ride.

On each phone: open that URL, add to home screen, then **⚙ pill ▸ Settings** and
paste the web app URL and API token from the Sheet.

## Changing the app

Edit `index.html` and commit. GitHub Pages redeploys in about a minute; the
service worker picks up the new version next time the app is opened twice.

Bump `CACHE` in `sw.js` (`pcw-inv-v1` → `v2`) when a change must reach phones
immediately — that forces every cached file to be re-fetched.

## Changing the backend

Edit `apps-script/Code.gs` here, paste the whole file over the one in Apps
Script, then **Deploy ▸ Manage deployments ▸** pencil ▸ New version ▸ Deploy.
The web app URL does not change.

`setup()` remaps rows by column name before rewriting headers, so adding a
column never scrambles what is already in the tabs.

## How the data works

`MOVEMENTS` is the only tab written to — one signed row per event. `INVENTORY`
and `STOCK BY PRODUCT` are rebuilt from it every five minutes, so stock can
never drift from the record. Undo is deleting a row and rebuilding.

## Layout

```
index.html          the app
sw.js               offline cache
manifest.json       home-screen install
icon-192.png        }  app icons
icon-512.png        }
apps-script/
  Code.gs           the Sheet's backend
docs/
  SETUP.md          first-time setup, day-to-day use, troubleshooting
```
