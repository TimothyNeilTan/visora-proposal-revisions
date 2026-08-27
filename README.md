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
  config.js           the deployed /exec URL — edit after deploying, no rebuild
  appsscript/Code.gs  the API (Google Apps Script)
  devserver.py        local stand-in for the backend, for testing
```

**This repo is `site/` only, and it is safe to make public.** `data/` is
gitignored — the proposals, the comments and the contributor emails live in the
Sheet. Do not put the parent folder in the repo: it holds the task inputs,
including a 309 MB TIFF that GitHub will reject outright.

`index.html` is generated. Edit `../revision_console.html`, then rebuild:

```
python3 ../build_site.py
```

## Deploy

Already done for you in Drive — the folder **Proposal Revisions**, the Sheet
**Proposal Revisions — data**, and **tokens.json**. Their ids are already filled
in at the top of `appsscript/Code.gs`.

**1. Add the script**

- Open the Sheet → **Extensions → Apps Script**. Paste in `appsscript/Code.gs`.
- Run **`setup`** once (authorise it when asked). Creates the `tokens`, `tasks`
  and `state` tabs.

**2. Load the data**

- Drop `data/tasks.json` into the **Proposal Revisions** folder in your Drive.
  (It is 84 KB — too big to push through the Drive connector, so this one is a
  drag-and-drop.)
- Run **`loadFromDrive`**. It fills the `tasks` and `tokens` tabs from Drive.
  Re-runnable: it never touches the `state` tab.

**3. Publish the web app**

- **Deploy → New deployment → Web app**
- *Execute as*: **Me**
- *Who has access*: **Anyone**  ← required; the token in the URL is the real check
- Copy the `/exec` URL.

**4. Point the page at your deployment**

Open `config.js`, replace the placeholder with your `/exec` URL, and commit:

```js
window.PROPOSAL_API = "https://script.google.com/macros/s/<ID>/exec";
```

That is the only place the URL appears — **no rebuild needed**. If it is still
the placeholder, the page says so instead of failing silently.

Then push and turn on GitHub Pages
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
python3 devserver.py       # serves the site AND a stand-in API on :8801
# then set config.js to "http://localhost:8801" temporarily
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
