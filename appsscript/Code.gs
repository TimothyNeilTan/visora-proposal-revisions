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
 * Spreadsheet tabs:
 *   people : email | name | tasks (comma-separated ids) | rev (TRUE/FALSE)
 *   tasks  : id    | json
 *   state  : taskId | savedAt | savedBy | responses(json) | version(json)
 *
 * Setup:
 *   1. run setup()      - creates the three tabs
 *   2. run reload()     - pulls proposals from the gist and people from Drive
 *   3. Deploy > Manage deployments > edit > New version
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
  sheet_('state').getRange(1, 1, 1, 5).setValues([['taskId', 'savedAt', 'savedBy', 'responses', 'version']]);
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
  var who = whoFor_(e.parameter.email);
  if (!who) return out_({ error: 'unknown_email' });

  // The reviewer can refresh the data without opening the editor.
  if (e.parameter.path === 'refresh') {
    if (!who.rev) return out_({ error: 'not_allowed' });
    return out_({ ok: true, message: reload() });
  }
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
  var who = whoFor_(e.parameter.email);
  if (!who) return out_({ error: 'unknown_email' });
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
