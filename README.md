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
  version.json        the current build stamp (built) — how a stale page notices
  appsscript/Code.gs  the API (Google Apps Script) — redeploy after editing
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

`version.json` is written by the same command and **must be published with
`index.html`**. The page carries its own content hash and compares it against
`version.json` (fetched `no-store`) on load and whenever the tab is refocused;
a mismatch means the browser is running a cached copy, so it re-fetches under
`?v=<stamp>` — a URL the cache has never seen. Without this, anyone whose tab
predates a deploy keeps seeing the old build's error messages, which describe
problems the current backend no longer has. `config.js` is re-run uncached at
boot for the same reason: it changes without a rebuild, so a stamped query
would not budge it.

### Reviewer comment edits need a redeployed script

`appsscript/Code.gs` gained a `comments` tab and a `path=comments` endpoint, so a
reviewer rewriting, withdrawing or adding a comment writes one row per task **in
place** rather than appending to `versions`. Editing a comment is not a revision
of the proposal, and it no longer rides on **Save responses**.

Until the script is redeployed the page still loads, but **Publish comment
changes** fails — the endpoint answers `not_found`. To pick it up:

1. open the Apps Script editor and paste in the current `appsscript/Code.gs`
2. **Deploy → Manage deployments → edit → Version: New version**

The `comments` tab creates itself with its header on first write, so `setup()`
does not have to be re-run.

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

## Iterations

Every save appends a new iteration rather than overwriting the last, so the whole
history of a proposal is kept. The header shows one chip per iteration —
`v1 · as submitted`, `v2`, `v3`, `v4 · latest` — and switching between them swaps
the answers and the rubric. Only the newest is editable; earlier ones are the record.
History lives in the `versions` tab, one row per save.

## Signing in

There are no links to send. Each person opens
`https://timothyneiltan.github.io/visora-proposal-revisions/`, types the email address
they submitted with, and receives a **six-digit code** at that address. Entering it
signs them in for 30 days, so the code is asked for once rather than every visit.

Possessing an address is therefore not enough — you have to be able to read its mail.
Codes expire after 10 minutes, are single-use, and are capped at five per address per
hour so nobody can be mail-bombed. Codes are sent from the Google account that owns the
script and count against its daily mail quota (100/day on a consumer account,
1,500 on Workspace) — ample for a batch of this size.

**Any `@sievedata.com` address gets reviewer access** to every proposal and every
iteration, without being listed anywhere — but still has to pass the emailed code,
so the domain rule cannot be used by typing a plausible address. Contributors are listed individually in
`data/people.json` (email -> name, proposals, reviewer flag), which lives in the Drive
folder and is gitignored. To add or remove a contributor, edit it, re-upload, run `reload`.

Note on the threat model: an email address is guessable in a way a random token is not,
so anyone who knows a contributor's address could read that contributor's feedback.
For a small programme that is usually acceptable. If it is not, Apps Script can email a
short-lived code to the address and verify it before granting a session.

## Updating the findings

The proposals and comments live in a **secret gist**, not in Drive, so a refresh needs
no upload:

```
python3 ../build_site.py                     # if the page itself changed
gh gist edit 37b3db9e7618c6d183efda767cc09791 -a data/tasks.min.json
curl -sL "<exec-url>?path=refresh&email=tim@sievedata.com"
```

That last call re-reads the gist into the Sheet. Saved revisions live in the `state`
tab and are never touched by a refresh.

The access list is the one thing still in Drive, because it holds email addresses:
drop `data/people.json` into the **Proposal Revisions** folder and run `reload`.

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
