# Proposal Revisions — public site

A static page on GitHub Pages plus a Google Apps Script web app that holds the data.

**The published page contains no proposal text, no comments and no email addresses.**
It reads a token from `?k=…`, asks the backend for the proposals that token covers,
and saves back to it. Saved revisions are keyed by **proposal**, so what a
contributor saves is what the reviewer opens.

```
site/
  index.html          the page that gets published   (built — do not edit by hand)
  data/tasks.json     all 8 proposals + comments     -> loaded into the Sheet
  data/tokens.json    token -> person + proposals    -> loaded into the Sheet, gitignored
  appsscript/Code.gs  the API (Google Apps Script)
  worker/             the same API as a Cloudflare Worker, if you ever switch
  devserver.py        local stand-in for the backend, speaks both dialects
```

`index.html` is generated. Edit `../revision_console.html`, then rebuild:

```
python3 ../build_site.py "https://script.google.com/macros/s/<ID>/exec" apps
```

## Deploy

**1. Make the Sheet and the script**

- Create a Google Sheet. Copy its ID from the URL
  (`docs.google.com/spreadsheets/d/`**`<THIS PART>`**`/edit`).
- In that Sheet: **Extensions → Apps Script**. Paste in `appsscript/Code.gs`.
- Set `SHEET_ID` at the top to the ID you copied.
- Run **`setup`** once (authorise it when asked). This creates three tabs:
  `tokens`, `tasks`, `state`.

**2. Load the data**

- Upload `data/tasks.json` and `data/tokens.json` to your Drive (anywhere).
- Run **`loadFromDrive`**. It fills the `tasks` and `tokens` tabs.
  Re-runnable: it never touches the `state` tab.

**3. Publish the web app**

- **Deploy → New deployment → Web app**
- *Execute as*: **Me**
- *Who has access*: **Anyone**  ← required; the token in the URL is the real check
- Copy the `/exec` URL.

**4. Build the page and publish it**

```
python3 ../build_site.py "https://script.google.com/macros/s/<ID>/exec" apps
```

Commit `site/index.html` to a repo and turn on GitHub Pages
(Settings → Pages → deploy from branch, folder `/site`). The repo can be
**public** — the page holds nothing sensitive. `data/tokens.json` is gitignored;
keep it out of the repo.

> Re-deploying the script: use **Deploy → Manage deployments → edit → Version:
> New version**, which keeps the same `/exec` URL. Creating a *new* deployment
> mints a new URL and you would have to rebuild the page.

## Sending links

Each person gets `https://<user>.github.io/<repo>/?k=<their token>` from
`data/tokens.json`. Anyone holding a link can open that person's proposals, so
send them directly, not to a shared channel.

To revoke or rotate: edit the `tokens` tab in the Sheet (or edit
`data/tokens.json` and re-run `loadFromDrive`). Changes take effect immediately.

## Updating the findings

Rebuild the console, re-export `tasks.json`, upload it to Drive, run
`loadFromDrive` again. Saved state lives in the `state` tab and survives.

## Reading what came back

The `state` tab is the log: one row per proposal, with who saved it, when, the
per-comment dispositions, and the full v2. You can also just open the site with
the reviewer token and read it in the console.

## Testing locally before you deploy

```
python3 devserver.py                                   # site + API on :8801
python3 ../build_site.py http://localhost:8801 apps
open "http://localhost:8801/index.html?k=<token from data/tokens.json>"
```

Local state goes to `.devstate/` (gitignored); delete it to start clean.

## Notes

- Saves are POSTed as `text/plain`. Apps Script cannot answer a CORS preflight,
  and a JSON content-type would trigger one. Both backends parse the body
  themselves, so this costs nothing.
- Apps Script answers `200` even for errors, so the client checks the response
  body rather than the status code.
- Concurrent saves take a script lock, so two people saving at once cannot
  clobber each other's row.
