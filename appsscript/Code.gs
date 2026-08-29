/**
 * Proposal Revisions API — Google Apps Script web app.
 *
 * Access is by email address: a contributor types the address they submitted
 * with and gets back only their own proposals. No tokens to distribute or lose.
 *
 * Data comes from two places:
 *   - the proposals + reviewer comments: a secret gist (no email addresses in it),
 *     so refreshing the findings needs no upload and no clicking
 *   - the access list: people.json in the Drive folder (this one holds addresses)
 *
 * Saved revisions are keyed by PROPOSAL, so what a contributor saves is what the
 * reviewer opens.
 *
 * Sign-in is a six-digit code emailed to the address, so possessing the address
 * is not enough - you have to be able to read its mail. A verified sign-in issues
 * a session that lasts 30 days, so the code is asked for once, not every visit.
 *
 * Every save appends a new iteration, so the full history of a proposal is kept
 * and can be stepped through. Anyone on @sievedata.com gets reviewer access to
 * every proposal and every iteration without being listed individually.
 *
 * Spreadsheet tabs:
 *   people   : email | name | tasks (comma-separated ids) | rev (TRUE/FALSE)
 *   tasks    : id    | json
 *   versions : taskId | n | savedAt | savedBy | answers(json) | rows(json) | responses(json)
 *   state    : legacy single-revision store, read once for anything saved before
 *   comments : taskId | json | savedAt | savedBy - the reviewer's changes to the
 *              findings (rewritten text, withdrawn ones, ones they added). Written
 *              in place, one row per task, so editing a comment is not a revision
 *              of the proposal and does not append to `versions`.
 *
 * Setup:
 *   1. run setup()      - creates the three tabs
 *   2. run reload()     - pulls proposals from the gist and people from Drive
 *   3. run mintPushToken() - logs the token that lets a script publish findings
 *   4. Deploy > Manage deployments > edit > New version
 */

var SHEET_ID  = '1T5yHoW0r8GSKozR_EyaL179ozjiPzUUqSlZ-274nIn4';  // "Proposal Revisions — data"
var FOLDER_ID = '1EKXEKmE5RA0MJG5M587IY8_0EjWc1QgM';             // "Proposal Revisions"
var TASKS_URL = 'https://gist.githubusercontent.com/TimothyNeilTan/'
              + '37b3db9e7618c6d183efda767cc09791/raw/tasks.min.json';

function sheet_(name) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  return ss.getSheetByName(name) || ss.insertSheet(name);
}
function rows_(name) {
  var v = sheet_(name).getDataRange().getValues();
  return v.length > 1 ? v.slice(1) : [];
}
function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
var norm_ = function (s) { return String(s || '').trim().toLowerCase(); };

/** Run once from the editor to create the tabs with their headers. */
function setup() {
  sheet_('people').getRange(1, 1, 1, 4).setValues([['email', 'name', 'tasks', 'rev']]);
  sheet_('tasks').getRange(1, 1, 1, 2).setValues([['id', 'json']]);
  sheet_('versions').getRange(1, 1, 1, 7).setValues([
    ['taskId', 'n', 'savedAt', 'savedBy', 'answers', 'rows', 'responses']]);
  sheet_('state').getRange(1, 1, 1, 5).setValues([['taskId', 'savedAt', 'savedBy', 'responses', 'version']]);
  sheet_('comments').getRange(1, 1, 1, 4).setValues([['taskId', 'json', 'savedAt', 'savedBy']]);
}

/**
 * Refresh proposals from the gist and the access list from Drive.
 * Re-runnable and safe: the `state` tab is never touched, so saved revisions survive.
 */
function reload() {
  var res = UrlFetchApp.fetch(TASKS_URL, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error('Could not read the task data (HTTP ' + res.getResponseCode() + ').');
  }
  var tasks = JSON.parse(res.getContentText());
  var ts = sheet_('tasks');
  ts.clear();
  var trows = [['id', 'json']];
  for (var id in tasks) trows.push([id, JSON.stringify(tasks[id])]);
  ts.getRange(1, 1, trows.length, 2).setValues(trows);

  var pf = fileInFolder_('people.json');
  var nPeople = 0;
  if (pf) {
    var people = JSON.parse(pf.getBlob().getDataAsString());
    var ps = sheet_('people');
    ps.clear();
    var prows = [['email', 'name', 'tasks', 'rev']];
    for (var em in people) {
      var p = people[em];
      prows.push([norm_(em), p.name, (p.tasks || []).join(','), p.rev ? 'TRUE' : 'FALSE']);
    }
    ps.getRange(1, 1, prows.length, 4).setValues(prows);
    nPeople = prows.length - 1;
  }
  var msg = 'loaded ' + (trows.length - 1) + ' proposals and ' + nPeople + ' people';
  Logger.log(msg);
  return msg;
}

/** Newest upload wins: Drive keeps same-named uploads side by side rather than replacing. */
function fileInFolder_(name) {
  var it = DriveApp.getFolderById(FOLDER_ID).getFilesByName(name), newest = null;
  while (it.hasNext()) {
    var f = it.next();
    if (!newest || f.getLastUpdated() > newest.getLastUpdated()) newest = f;
  }
  return newest;
}

var REVIEWER_DOMAIN = '@sievedata.com';
var CODE_TTL_SECONDS = 600;          // a code is good for 10 minutes
var SESSION_TTL_DAYS = 30;

// ---- one-time codes ----------------------------------------------------------
function sixDigits_() {
  return String(Math.floor(Math.random() * 900000) + 100000);
}
function issueCode_(email) {
  var cache = CacheService.getScriptCache();
  var code = sixDigits_();
  cache.put('code:' + email, code, CODE_TTL_SECONDS);
  MailApp.sendEmail({
    to: email,
    subject: 'Your Proposal Revisions sign-in code: ' + code,
    body: 'Your sign-in code is ' + code + '\n\n' +
          'It expires in 10 minutes and can be used once.\n\n' +
          'If you did not ask for this, you can ignore it - nobody can sign in without the code.\n'
  });
  return code;
}
function checkCode_(email, code) {
  var cache = CacheService.getScriptCache();
  var want = cache.get('code:' + email);
  if (!want || String(code || '').trim() !== want) return false;
  cache.remove('code:' + email);                          // one use only
  return true;
}

// ---- maintenance -------------------------------------------------------------
// Editor-only, and deliberately not reachable over the web app. The push token's
// whole safety story is that the only thing it can do is make the Sheet re-read
// the gist, so nothing that destroys a row hangs off it.

/** Delete every saved iteration of one task. Returns how many rows went. */
function purgeVersions_(taskId) {
  var sh = sheet_('versions'), v = sh.getDataRange().getValues(), gone = 0;
  // Bottom-up: deleting a row shifts every row below it up by one.
  for (var i = v.length - 1; i >= 1; i--) {
    if (String(v[i][0]) === taskId) { sh.deleteRow(i + 1); gone++; }
  }
  return gone;
}

/** Delete one task's rows from a tab keyed by taskId in column A. */
function purgeTabRows_(tab, taskId) {
  var sh = sheet_(tab), v = sh.getDataRange().getValues(), gone = 0;
  for (var i = v.length - 1; i >= 1; i--) {
    if (String(v[i][0]) === taskId) { sh.deleteRow(i + 1); gone++; }
  }
  return gone;
}

/**
 * Put the sandbox proposal back to as-submitted: drop its saved iterations, its
 * reviewer comment overlay and any legacy state row.
 *
 * Worth doing whenever the sandbox's findings are replaced. Dispositions are
 * keyed by comment id, and a new set of findings reuses ids like `t7` for a
 * different comment - so iterations saved against the old set would attach a
 * contributor's "fixed" to whatever now holds that id.
 */
function resetSandbox() {
  var msg = 'test: dropped ' + purgeVersions_('test') + ' iteration(s), ' +
            purgeTabRows_('comments', 'test') + ' comment-overlay row(s), ' +
            purgeTabRows_('state', 'test') + ' legacy state row(s)';
  Logger.log(msg);
  return msg;
}

/**
 * Read-only: log what the `versions` and `comments` tabs actually hold.
 *
 * Run this before clearing anything. A reviewer publishing a comment change writes
 * a row too, and the ones written before the `comments` tab existed went into
 * `versions` carrying a `__review` overlay in their answers blob. Those are the rows
 * that used to raise a version switcher on a proposal nobody had revised.
 */
function listVersions() {
  var out = [], r = rows_('versions'), own = contributorsByTask_();
  for (var i = 0; i < r.length; i++) {
    if (!r[i][0]) continue;
    var tid = String(r[i][0]);
    var a = {}, resp = {};
    try { a = JSON.parse(r[i][4] || '{}'); } catch (err) {}
    try { resp = JSON.parse(r[i][6] || '{}'); } catch (err) {}
    var fields = [];
    for (var k in a) if (k.indexOf('__') !== 0 && a[k]) fields.push(k);
    // Saves made before the postState fix left answers empty and put the text in
    // responses instead, so an empty answers blob is not an empty revision.
    var carried = [];
    for (var rk in resp) if (rk.indexOf('answer:' + tid + ':') === 0) carried.push(rk.split(':')[2]);
    var rev = revOf_(own, tid, r[i][3]);
    out.push(tid + '  v' + r[i][1] + '  by ' + r[i][3] +
             '  savedByReviewer=' + (rev === null ? 'unknown' : rev ? 'YES' : 'no') +
             '  reviewerFlag=' + (a['__savedByReviewer'] ? 'yes' : 'no') +
             '  reviewOverlay=' + (a['__review'] ? 'yes' : 'no') +
             '  answers=[' + fields.join(',') + ']' +
             '  answersInResponses=[' + carried.join(',') + ']' +
             '  rubricRows=' + (r[i][5] ? (JSON.parse(r[i][5]) || []).length : 0));
  }
  var c = rows_('comments'), cm = [];
  for (var j = 0; j < c.length; j++) {
    if (!c[j][0]) continue;
    var o = {};
    try { o = JSON.parse(c[j][1] || '{}'); } catch (err) {}
    cm.push(c[j][0] + '  edits=' + Object.keys(o.edits || {}).length +
            '  removed=' + ((o.removed || []).length) +
            '  added=' + ((o.added || []).length) + '  by ' + c[j][3]);
  }
  var msg = 'versions (' + out.length + '):\n  ' + (out.join('\n  ') || '(none)') +
            '\n\ncomments overlay (' + cm.length + '):\n  ' + (cm.join('\n  ') || '(none)');
  Logger.log(msg);
  return msg;
}

/**
 * Write every contributor revision to `revisions.json` in the Drive folder.
 *
 * Findings are audited against the task text on disk, and that is v1. Where a
 * contributor has already saved a revision, auditing v1 hands them back work they
 * have already done. This is the way to get their revision out: reading it over the
 * API needs a signed-in session, and a session needs the emailed code, which is
 * exactly what a script cannot obtain.
 *
 * Reviewer saves are skipped, so what lands in the file is the contributors' own
 * work. Answers written before the postState fix are folded back out of `responses`,
 * so a revision that stored an empty answers blob still comes out whole.
 */
function exportRevisions() {
  var hist = versionsByTask_(), all = allTasks_(), out = {}, n = 0;
  for (var tid in hist) {
    var list = hist[tid], keep = null;
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (v.rev === true) continue;                                  // a reviewer's save
      if (v.answers && v.answers['__savedByReviewer']) continue;
      if (v.answers && v.answers['__review']) continue;
      keep = v;                                                      // last one wins
    }
    if (!keep) continue;
    var a = {}, f = ['title', 'workflow', 'rubric', 'injection', 'inputs', 'anything'];
    for (var j = 0; j < f.length; j++) {
      var direct = keep.answers && keep.answers[f[j]];
      if (typeof direct === 'string' && direct.length) { a[f[j]] = direct; continue; }
      var rec = keep.responses && keep.responses['answer:' + tid + ':' + f[j]];
      if (rec && typeof rec.text === 'string') {
        var parts = [rec.text];
        for (var k = 0; k < (rec.ins || []).length; k++) parts.push(rec.ins[k].text);
        a[f[j]] = parts.join('\n\n');
      } else if (typeof direct === 'string') { a[f[j]] = direct; }
      // Nothing recorded either way means the contributor never touched this field,
      // so the iteration holds what was submitted. Leaving it out instead reads as a
      // field the contributor emptied, which is what the page's verAnswer() has
      // always known not to do - and what made a v2 look like it had lost its title.
      if (a[f[j]] === undefined) {
        var sub = all[tid] && all[tid].answers ? all[tid].answers[f[j]] : '';
        a[f[j]] = typeof sub === 'string' ? sub : '';
      }
    }
    var rows = (keep.rows && keep.rows.length) ? keep.rows : null;
    if (!rows) {
      var rr = keep.responses && keep.responses['rubricrows:' + tid];
      if (rr && rr.rows && rr.rows.length) rows = rr.rows;
    }
    // Same for the rubric: an iteration that recorded no rows kept the submitted ones.
    if (!rows) {
      var sr = all[tid] && all[tid].answers ? all[tid].answers.rubric : '';
      out[tid] = { v: keep.v, by: keep.by, at: keep.at, answers: a, rows: [],
                   rubricFromV1: typeof sr === 'string' ? sr : '',
                   responses: keep.responses || {} };
      n++; continue;
    }
    out[tid] = { v: keep.v, by: keep.by, at: keep.at, answers: a, rows: rows,
                 responses: keep.responses || {} };
    n++;
  }
  var name = 'revisions.json', body = JSON.stringify(out, null, 1);
  var folder = DriveApp.getFolderById(FOLDER_ID), old = folder.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true);                 // newest upload wins
  folder.createFile(name, body, MimeType.PLAIN_TEXT);
  var msg = 'wrote ' + name + ' to the Proposal Revisions folder: ' + n +
            ' contributor revision(s), ' + body.length + ' bytes';
  Logger.log(msg);
  return msg;
}

/**
 * Remove the staging notes from every stored revision.
 *
 * When a proposal was staged from its PDF we added parenthetical notes about the
 * form export - that one numbered a stage "(3)" twice, that another skipped (4),
 * that a typo was corrected. They went into the answer text rather than alongside
 * it, and the editor seeds its answer box from that text, so a contributor who
 * revised the proposal carried the note into their revision. It is our text, it is
 * not task content, and it would otherwise reach the agent as part of the
 * instruction.
 *
 * Only the exact strings we wrote are removed, so a contributor's own parenthetical
 * is never touched. Editor-only, like everything here that rewrites a row.
 */
var STAGING_NOTES = [
  '*(Stage numbering is verbatim from the form \u2014 "(3)" appears twice.)*',
  '*(Stage numbering is verbatim from the form \u2014 it skips (4).)*',
  '*(Verbatim from the form; the submitter wrote the workflow as a flat bullet list rather than numbered stages.)*'
];

function stripNote_(s) {
  if (typeof s !== 'string') return s;
  var out = s;
  for (var i = 0; i < STAGING_NOTES.length; i++) {
    var at = out.indexOf(STAGING_NOTES[i]);
    while (at >= 0) {
      out = out.slice(0, at) + out.slice(at + STAGING_NOTES[i].length);
      at = out.indexOf(STAGING_NOTES[i]);
    }
  }
  // A note removed from its own paragraph leaves the blank lines that framed it -
  // at the top of a field as well as the bottom, which is where map2's sat.
  return out.replace(/\n{3,}/g, '\n\n').replace(/^\s+/, '').replace(/\s+$/, '');
}

function stripStagingNotes() {
  var sh = sheet_('versions'), v = sh.getDataRange().getValues(), hits = [];
  for (var i = 1; i < v.length; i++) {
    if (!v[i][0]) continue;
    var tid = String(v[i][0]), changed = [];

    var ans = {};
    try { ans = JSON.parse(v[i][4] || '{}'); } catch (e) { ans = null; }
    if (ans) {
      for (var k in ans) {
        var was = ans[k], now = stripNote_(was);
        if (typeof was === 'string' && now !== was) { ans[k] = now; changed.push('answers.' + k); }
      }
    }

    // The pre-postState rows keep their text here instead, so both sides need it.
    var resp = {};
    try { resp = JSON.parse(v[i][6] || '{}'); } catch (e) { resp = null; }
    if (resp) {
      for (var rk in resp) {
        var rec = resp[rk];
        if (!rec || typeof rec.text !== 'string') continue;
        var n2 = stripNote_(rec.text);
        if (n2 !== rec.text) { rec.text = n2; changed.push(rk); }
      }
    }

    if (!changed.length) continue;
    if (ans)  sh.getRange(i + 1, 5).setValue(JSON.stringify(ans));
    if (resp) sh.getRange(i + 1, 7).setValue(JSON.stringify(resp));
    hits.push(tid + ' v' + v[i][1] + ' (' + changed.join(', ') + ')');
  }
  var msg = hits.length ? 'stripped the staging note from: ' + hits.join('; ')
                        : 'no stored revision carried a staging note';
  Logger.log(msg);
  return msg;
}

/**
 * Drop the reviewer comment overlay for the given tasks, so the findings render
 * exactly as the gist has them.
 *
 * Needed after the findings are replaced wholesale: the overlay is keyed by comment
 * id, an edit or a withdrawal of an id that no longer exists is inert, but a comment
 * the reviewer *added* keeps rendering on top of the new set. A refresh cannot clear
 * it - `reload()` rewrites `tasks` and `people` and nothing else.
 *
 * Defaults to the nine contributor proposals and leaves `test` alone; resetSandbox()
 * is the one for the sandbox. Editor-only, like every function here that deletes a
 * row: the push token can only make the Sheet re-read the gist.
 */
function clearReviewerComments(taskIds) {
  var ids = taskIds || ['bedroom', 'cafe', 'desk', 'flying', 'mecha',
                        'sholl', 'dentate', 'iba1', 'map2'];
  var parts = [], total = 0;
  for (var i = 0; i < ids.length; i++) {
    var n = purgeTabRows_('comments', ids[i]);
    total += n;
    if (n) parts.push(ids[i] + ' (' + n + ')');
  }
  var msg = 'dropped ' + total + ' comment-overlay row(s)' +
            (parts.length ? ': ' + parts.join(', ') : '');
  Logger.log(msg);
  return msg;
}

// ---- push token --------------------------------------------------------------
// Refreshing the findings is a machine job: rebuild tasks.min.json, push it to the
// gist, tell the script to re-read it. The emailed-code sign-in exists to prove a
// person can read their mail - which a script cannot do, and should not have to.
// So `path=refresh` also accepts a long-lived token that authorises nothing else.
//
// Run mintPushToken() once from the editor and put the token it logs into
// site/data/push_token.txt (data/ is gitignored, so it stays out of the public
// repo). Losing it costs little: the only thing it can do is make the Sheet
// re-read the gist, and re-minting revokes the old one.
function mintPushToken() {
  var tok = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('pushToken', tok);
  Logger.log('push token: ' + tok);
  return tok;
}
function pushTokenOk_(t) {
  var want = PropertiesService.getScriptProperties().getProperty('pushToken');
  if (!want || !t) return false;
  t = String(t);
  if (t.length !== want.length) return false;      // compared without early exit
  var diff = 0;
  for (var i = 0; i < want.length; i++) diff |= t.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

// ---- sessions ----------------------------------------------------------------
function sessions_() {
  var raw = PropertiesService.getScriptProperties().getProperty('sessions');
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}
function newSession_(email) {
  var all = sessions_(), now = Date.now();
  for (var k in all) if (!all[k].exp || all[k].exp < now) delete all[k];   // prune
  var tok = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  all[tok] = { email: email, exp: now + SESSION_TTL_DAYS * 86400000 };
  PropertiesService.getScriptProperties().setProperty('sessions', JSON.stringify(all));
  return tok;
}
function emailForSession_(tok) {
  if (!tok) return null;
  var s = sessions_()[tok];
  if (!s || (s.exp && s.exp < Date.now())) return null;
  return s.email;
}

/**
 * Resolve the caller: a valid session, or a valid one-time code for the address.
 * Returns {who} on success, or {error} describing what is missing.
 */
function authed_(e) {
  var sessEmail = emailForSession_(e.parameter.s);
  if (sessEmail) {
    var w = whoFor_(sessEmail);
    return w ? { who: w } : { error: 'unknown_email' };
  }
  var email = norm_(e.parameter.email);
  if (!email) return { error: 'need_email' };
  if (!whoFor_(email)) return { error: 'unknown_email' };
  if (!e.parameter.code) return { error: 'need_code' };
  if (!checkCode_(email, e.parameter.code)) return { error: 'bad_code' };
  return { who: whoFor_(email), session: newSession_(email) };
}

function whoFor_(email) {
  var e = norm_(email);
  if (!e) return null;
  var r = rows_('people');
  for (var i = 0; i < r.length; i++) {
    if (norm_(r[i][0]) === e) {
      return {
        email: e,
        name: String(r[i][1]),
        tasks: String(r[i][2]).split(',').map(function (s) { return s.trim(); }).filter(String),
        rev: String(r[i][3]).toUpperCase() === 'TRUE'
      };
    }
  }
  // Not listed individually, but on the reviewer domain: full access.
  if (e.slice(-REVIEWER_DOMAIN.length) === REVIEWER_DOMAIN) {
    var all = [], t = rows_('tasks');
    for (var j = 0; j < t.length; j++) if (t[j][0]) all.push(String(t[j][0]));
    return { email: e, name: e.split('@')[0], tasks: all, rev: true };
  }
  return null;
}

function allTasks_() {
  var out = {}, r = rows_('tasks');
  for (var i = 0; i < r.length; i++) {
    if (!r[i][0]) continue;
    try { out[String(r[i][0])] = JSON.parse(r[i][1]); } catch (e) {}
  }
  return out;
}

/**
 * Every saved iteration per proposal, oldest first. Anything written before the
 * history tab existed is folded in as iteration 2 so nothing is lost.
 */
/**
 * taskId -> { contributor name (lowercased): true }, from the access list.
 *
 * A reviewer on the reviewer domain is never in the `people` tab - whoFor_() lets
 * them in on the domain alone and names them after the local part of their address.
 * So "who owns this proposal" is the only question that separates a contributor's
 * revision from a reviewer's save, and it is the one the client cannot answer: it
 * is told its own access, not everyone else's.
 */
function contributorsByTask_() {
  var out = {}, r = rows_('people');
  for (var i = 0; i < r.length; i++) {
    if (String(r[i][3]).toUpperCase() === 'TRUE') continue;   // reviewers own no proposal
    var name = String(r[i][1] || '').trim().toLowerCase();
    if (!name) continue;
    var ts = String(r[i][2]).split(',');
    for (var j = 0; j < ts.length; j++) {
      var t = ts[j].trim();
      if (t) (out[t] = out[t] || {})[name] = true;
    }
  }
  return out;
}

/**
 * `rev` on each iteration says whether it was saved by someone other than the
 * proposal's own contributor. Null where the access list does not name a
 * contributor for the task, so the client falls back to reading the row instead of
 * treating "unknown" as "reviewer" and hiding a real revision.
 */
function revOf_(own, tid, savedBy) {
  if (!own[tid]) return null;
  return !own[tid][String(savedBy || '').trim().toLowerCase()];
}

function versionsByTask_() {
  var out = {}, r = rows_('versions'), own = contributorsByTask_();
  for (var i = 0; i < r.length; i++) {
    var tid = String(r[i][0] || '');
    if (!tid) continue;
    (out[tid] = out[tid] || []).push({
      v: Number(r[i][1]) || 2,
      at: r[i][2] ? String(r[i][2]) : null,
      by: r[i][3] ? String(r[i][3]) : null,
      rev: revOf_(own, tid, r[i][3]),
      answers: r[i][4] ? JSON.parse(r[i][4]) : {},
      rows: r[i][5] ? JSON.parse(r[i][5]) : [],
      responses: r[i][6] ? JSON.parse(r[i][6]) : {}
    });
  }
  var legacy = stateRows_();
  for (var t in legacy) {
    if (out[t] && out[t].length) continue;         // history wins where it exists
    var s = legacy[t];
    if (!s.version) continue;
    out[t] = [{ v: 2, at: s.savedAt, by: s.savedBy, rev: revOf_(own, t, s.savedBy),
                answers: s.version.answers || {}, rows: s.version.rows || [],
                responses: s.responses || {} }];
  }
  for (var k in out) out[k].sort(function (a, b) { return a.v - b.v; });
  return out;
}

/** The reviewer's overlay on the findings, one row per task, newest write wins. */
function commentsByTask_() {
  var out = {}, r = rows_('comments');
  for (var i = 0; i < r.length; i++) {
    var tid = String(r[i][0] || '');
    if (!tid) continue;
    try { out[tid] = JSON.parse(r[i][1] || '{}'); } catch (err) { out[tid] = {}; }
  }
  return out;
}

function stateRows_() {
  var out = {}, r = rows_('state');
  for (var i = 0; i < r.length; i++) {
    if (!r[i][0]) continue;
    out[String(r[i][0])] = {
      row: i + 2,
      savedAt: r[i][1] ? String(r[i][1]) : null,
      savedBy: r[i][2] ? String(r[i][2]) : null,
      responses: r[i][3] ? JSON.parse(r[i][3]) : {},
      version: r[i][4] ? JSON.parse(r[i][4]) : null
    };
  }
  return out;
}

/** Which proposal does a stored key belong to? */
function ownerOf_(key, index) {
  if (key.indexOf('answer:') === 0) return key.split(':')[1];
  if (key.indexOf('rubricrows:') === 0) return key.substring('rubricrows:'.length);
  return index[key] || null;
}
function commentIndex_(tasks) {
  var idx = {};
  for (var tid in tasks) {
    var s = tasks[tid].sections || [];
    for (var i = 0; i < s.length; i++) {
      var items = s[i][1] || [];
      for (var j = 0; j < items.length; j++) idx[items[j][0]] = tid;
    }
  }
  return idx;
}

function doGet(e) {
  // Step one of signing in: email a six-digit code. Deliberately reports an
  // unknown address, because these are eight known people and a typo should
  // say so rather than fail silently.
  if (e.parameter.path === 'code') {
    var addr = norm_(e.parameter.email);
    if (!addr) return out_({ error: 'need_email' });
    if (!whoFor_(addr)) return out_({ error: 'unknown_email' });
    issueCode_(addr);
    return out_({ ok: true, sent: true });
  }

  // A push token refreshes the findings and does nothing else, so a script can
  // publish without holding a sign-in session only a person can obtain.
  if (e.parameter.path === 'refresh' && e.parameter.t) {
    if (!pushTokenOk_(e.parameter.t)) return out_({ error: 'bad_token' });
    return out_({ ok: true, message: reload() });
  }

  var auth = authed_(e);
  if (auth.error) return out_({ error: auth.error });
  var who = auth.who;

  // The reviewer can refresh the data without opening the editor.
  if (e.parameter.path === 'refresh') {
    if (!who.rev) return out_({ error: 'not_allowed' });
    return out_({ ok: true, message: reload() });
  }
  if (e.parameter.path !== 'session') return out_({ error: 'not_found' });

  var all = allTasks_(), hist = versionsByTask_();
  var tasks = [], responses = {}, versions = {}, savedAt = null, savedBy = null;
  for (var i = 0; i < who.tasks.length; i++) {
    var id = who.tasks[i];
    if (all[id]) tasks.push(all[id]);
    var list = hist[id];
    if (!list || !list.length) continue;
    versions[id] = list;                                   // every iteration, oldest first
    var newest = list[list.length - 1];                    // working state is the newest one
    for (var k in newest.responses) responses[k] = newest.responses[k];
    if (newest.at && (!savedAt || newest.at > savedAt)) { savedAt = newest.at; savedBy = newest.by; }
  }
  var allC = commentsByTask_(), comments = {};
  for (var c = 0; c < who.tasks.length; c++) {
    if (allC[who.tasks[c]]) comments[who.tasks[c]] = allC[who.tasks[c]];
  }
  return out_({ who: { name: who.name, rev: who.rev }, session: auth.session || null, tasks: tasks,
                comments: comments,
                state: { responses: responses, versions: versions, savedAt: savedAt, savedBy: savedBy } });
}

function doPost(e) {
  var auth = authed_(e);
  if (auth.error) return out_({ error: auth.error });
  var who = auth.who;
  // Editing a comment is the reviewer's business and not a revision of the proposal,
  // so it writes its own row in place rather than appending to `versions`.
  if (e.parameter.path === 'comments') {
    if (!who.rev) return out_({ error: 'not_allowed' });
    var cbody;
    try { cbody = JSON.parse(e.postData.contents); } catch (err) { return out_({ error: 'bad_json' }); }
    var clock = LockService.getScriptLock();
    try { clock.waitLock(20000); } catch (err) { return out_({ error: 'busy' }); }
    try {
      var csh = sheet_('comments');
      // sheet_() creates the tab but not its header, and rows_() always skips row 1.
      // Without this the first write would land in row 1 and then be read as a header.
      if (csh.getLastRow() === 0) {
        csh.getRange(1, 1, 1, 4).setValues([['taskId', 'json', 'savedAt', 'savedBy']]);
      }
      var crows = csh.getDataRange().getValues();
      var cat = new Date().toISOString(), wrote = [];
      for (var tid in cbody) {
        var json = JSON.stringify(cbody[tid] || {});
        if (json.length > 45000) return out_({ error: 'too_large', task: tid });
        var at = 0;
        for (var i = 1; i < crows.length; i++) {
          if (String(crows[i][0]) === tid) { at = i + 1; break; }
        }
        if (at) csh.getRange(at, 1, 1, 4).setValues([[tid, json, cat, who.name]]);
        else    csh.appendRow([tid, json, cat, who.name]);
        wrote.push(tid);
      }
      return out_({ ok: true, savedAt: cat, savedBy: who.name, tasks: wrote });
    } finally { clock.releaseLock(); }
  }

  if (e.parameter.path !== 'state') return out_({ error: 'not_found' });

  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ error: 'bad_json' }); }
  var responses = (body && body.responses) || {}, versions = (body && body.versions) || {};

  for (var id in versions) {
    if (who.tasks.indexOf(id) < 0) return out_({ error: 'not_your_task', task: id });
  }

  // One writer at a time: two people saving at once must not clobber a row.
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return out_({ error: 'busy' }); }
  try {
    var idx = commentIndex_(allTasks_()), slices = {};
    for (var key in responses) {
      var tid = ownerOf_(key, idx);
      if (!tid || who.tasks.indexOf(tid) < 0) continue;   // ignore anything not theirs
      if (!slices[tid]) slices[tid] = {};
      slices[tid][key] = responses[key];
    }

    var sh = sheet_('versions'), hist = versionsByTask_();
    var savedAt = new Date().toISOString(), written = [];
    for (var i = 0; i < who.tasks.length; i++) {
      var t = who.tasks[i], slice = slices[t], ver = versions[t];
      if (!slice && !ver) continue;
      var prev = hist[t] || [];
      var n = prev.length ? prev[prev.length - 1].v + 1 : 2;   // v1 is the original submission
      var answers = JSON.stringify((ver && ver.answers) || {});
      var rws     = JSON.stringify((ver && ver.rows) || []);
      var resp    = JSON.stringify(slice || {});
      if (answers.length > 45000 || rws.length > 45000 || resp.length > 45000) {
        return out_({ error: 'too_large', task: t });
      }
      sh.appendRow([t, n, savedAt, who.name, answers, rws, resp]);
      written.push({ task: t, v: n });
    }
    return out_({ ok: true, savedAt: savedAt, savedBy: who.name, tasks: written });
  } finally {
    lock.releaseLock();
  }
}
