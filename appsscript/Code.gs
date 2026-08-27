/**
 * Proposal Revisions API — Google Apps Script web app.
 *
 * Backed by one Spreadsheet with three sheets:
 *   tokens : token | name | email | tasks (comma-separated ids) | rev (TRUE/FALSE)
 *   tasks  : id    | json
 *   state  : taskId | savedAt | savedBy | responses(json) | version(json)
 *
 * The published page holds no proposal data and no email addresses; it sends
 * ?k=<token> and gets back only the proposals that token covers. State is keyed
 * by PROPOSAL, so what a contributor saves is what the reviewer opens.
 *
 * Setup, in order:
 *   1. run setup()          - creates the three sheets with headers
 *   2. drop site/data/tasks.json into the "Proposal Revisions" Drive folder
 *   3. run loadFromDrive()  - fills the sheets from Drive
 *   4. Deploy > New deployment > Web app, "Execute as: Me",
 *      "Who has access: Anyone"   (the token in the URL is the real check)
 *
 * The Sheet, the folder and tokens.json already exist; their ids are below.
 */

// Created for you — these point at the real Drive items.
var SHEET_ID       = '1T5yHoW0r8GSKozR_EyaL179ozjiPzUUqSlZ-274nIn4';  // "Proposal Revisions — data"
var FOLDER_ID      = '1EKXEKmE5RA0MJG5M587IY8_0EjWc1QgM';             // "Proposal Revisions"
var TOKENS_FILE_ID = '1hW-bOV_YB7-ybrSl4rTl9Kl31YoQyLD-';             // tokens.json

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

/** Run once from the editor to create the sheets with their headers. */
function setup() {
  sheet_('tokens').getRange(1, 1, 1, 5).setValues([['token', 'name', 'email', 'tasks', 'rev']]);
  sheet_('tasks').getRange(1, 1, 1, 2).setValues([['id', 'json']]);
  sheet_('state').getRange(1, 1, 1, 5).setValues([['taskId', 'savedAt', 'savedBy', 'responses', 'version']]);
}

/**
 * Fill the sheets from tasks.json and tokens.json uploaded to your Drive.
 * Re-runnable: refreshing the findings is upload + run this again. Saved
 * revisions live in the `state` sheet and are never touched by a reload.
 */
function loadFromDrive() {
  var tasksFile  = fileInFolder_('tasks.json');
  var tokensFile = fileInFolder_('tokens.json') || DriveApp.getFileById(TOKENS_FILE_ID);
  if (!tasksFile) {
    throw new Error('Drop tasks.json into the "Proposal Revisions" folder in your Drive, then run this again.');
  }

  var tasks = JSON.parse(tasksFile.getBlob().getDataAsString());
  var ts = sheet_('tasks');
  ts.clear();
  var trows = [['id', 'json']];
  for (var id in tasks) trows.push([id, JSON.stringify(tasks[id])]);
  ts.getRange(1, 1, trows.length, 2).setValues(trows);

  var tokens = JSON.parse(tokensFile.getBlob().getDataAsString());
  var ks = sheet_('tokens');
  ks.clear();
  var krows = [['token', 'name', 'email', 'tasks', 'rev']];
  for (var tok in tokens) {
    var v = tokens[tok];
    krows.push([tok, v.name, v.email, (v.tasks || []).join(','), v.rev ? 'TRUE' : 'FALSE']);
  }
  ks.getRange(1, 1, krows.length, 5).setValues(krows);

  Logger.log('loaded %s proposals and %s tokens', trows.length - 1, krows.length - 1);
}

/**
 * Look inside the Proposal Revisions folder and take the NEWEST match.
 * Drive keeps same-named uploads as separate files rather than replacing, so
 * re-uploading tasks.json leaves several; the most recent one is the live data.
 */
function fileInFolder_(name) {
  var it = DriveApp.getFolderById(FOLDER_ID).getFilesByName(name), newest = null;
  while (it.hasNext()) {
    var f = it.next();
    if (!newest || f.getLastUpdated() > newest.getLastUpdated()) newest = f;
  }
  return newest;
}

function whoFor_(token) {
  if (!token) return null;
  var r = rows_('tokens');
  for (var i = 0; i < r.length; i++) {
    if (String(r[i][0]) === String(token)) {
      return {
        name: String(r[i][1]),
        tasks: String(r[i][3]).split(',').map(function (s) { return s.trim(); }).filter(String),
        rev: String(r[i][4]).toUpperCase() === 'TRUE'
      };
    }
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
  var who = whoFor_(e.parameter.k);
  if (!who) return out_({ error: 'unknown_token' });
  if (e.parameter.path !== 'session') return out_({ error: 'not_found' });

  var all = allTasks_(), st = stateRows_();
  var tasks = [], responses = {}, versions = {}, savedAt = null, savedBy = null;
  for (var i = 0; i < who.tasks.length; i++) {
    var id = who.tasks[i];
    if (all[id]) tasks.push(all[id]);
    var s = st[id];
    if (!s) continue;
    for (var k in s.responses) responses[k] = s.responses[k];
    if (s.version) versions[id] = s.version;
    if (s.savedAt && (!savedAt || s.savedAt > savedAt)) { savedAt = s.savedAt; savedBy = s.savedBy; }
  }
  return out_({ who: { name: who.name, rev: who.rev }, tasks: tasks,
                state: { responses: responses, versions: versions, savedAt: savedAt, savedBy: savedBy } });
}

function doPost(e) {
  var who = whoFor_(e.parameter.k);
  if (!who) return out_({ error: 'unknown_token' });
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

    var sh = sheet_('state'), st = stateRows_();
    var savedAt = new Date().toISOString(), written = [];
    for (var i = 0; i < who.tasks.length; i++) {
      var t = who.tasks[i], slice = slices[t], ver = versions[t];
      if (!slice && !ver) continue;
      var row = [t, savedAt, who.name, JSON.stringify(slice || {}), ver ? JSON.stringify(ver) : ''];
      for (var c = 3; c <= 4; c++) {
        if (String(row[c]).length > 45000) return out_({ error: 'too_large', task: t });
      }
      if (st[t]) sh.getRange(st[t].row, 1, 1, 5).setValues([row]);
      else sh.appendRow(row);
      written.push(t);
    }
    return out_({ ok: true, savedAt: savedAt, savedBy: who.name, tasks: written });
  } finally {
    lock.releaseLock();
  }
}
