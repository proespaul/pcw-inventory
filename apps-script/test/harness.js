/* Offline test harness: runs Code.gs against an in-memory fake of the
   Apps Script Spreadsheet service, so the ledger math can be verified
   before any of this touches a real sheet. */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function colToArr(v) { return v; }

class FakeRange {
  constructor(sheet, r, c, nr, nc) { this.s = sheet; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) {
        const rr = this.s.data[this.r - 1 + i] || [];
        row.push(rr[this.c - 1 + j] === undefined ? '' : rr[this.c - 1 + j]);
      }
      out.push(row);
    }
    return out;
  }
  setValues(vals) {
    for (let i = 0; i < vals.length; i++) {
      const target = this.r - 1 + i;
      if (!this.s.data[target]) this.s.data[target] = [];
      for (let j = 0; j < vals[i].length; j++) this.s.data[target][this.c - 1 + j] = vals[i][j];
    }
    return this;
  }
  clearContent() {
    for (let i = 0; i < this.nr; i++) {
      const target = this.r - 1 + i;
      if (!this.s.data[target]) continue;
      for (let j = 0; j < this.nc; j++) this.s.data[target][this.c - 1 + j] = '';
    }
    return this;
  }
  getValue() { return this.getValues()[0][0]; }
  setValue(v) { return this.setValues([[v]]); }
  setFontWeight() { return this; }
  setBackground() { return this; }
  setFontColor() { return this; }
  setNumberFormat() { return this; }
  setBackgrounds() { return this; }
}

class FakeSheet {
  constructor(name) { this.name = name; this.data = []; }
  getName() { return this.name; }
  getLastRow() {
    let last = 0;
    this.data.forEach((row, i) => {
      if (row && row.some(v => v !== '' && v !== null && v !== undefined)) last = i + 1;
    });
    return last;
  }
  getLastColumn() {
    let last = 0;
    this.data.forEach(row => { if (row) last = Math.max(last, row.length); });
    return last;
  }
  getMaxColumns() { return Math.max(this.getLastColumn(), 26); }
  getRange(a, b, c, d) {
    if (typeof a === 'string') {                      // 'B2:B' style
      const m = a.match(/^([A-Z]+)(\d+):([A-Z]+)(\d*)$/);
      const col = m[1].charCodeAt(0) - 64;
      const col2 = m[3].charCodeAt(0) - 64;
      return new FakeRange(this, Number(m[2]), col, 1000, col2 - col + 1);
    }
    return new FakeRange(this, a, b, c === undefined ? 1 : c, d === undefined ? 1 : d);
  }
  appendRow(vals) { this.data[this.getLastRow()] = vals.slice(); }
  setFrozenRows() {} autoResizeColumns() {} deleteColumns() {}
}

class FakeSS {
  constructor() { this.sheets = {}; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { return (this.sheets[n] = new FakeSheet(n)); }
  getUrl() { return 'https://sheet.test'; }
}

function buildContext() {
  const ss = new FakeSS();
  const props = {};
  const ctx = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getUi: () => ({ alert: () => {}, createMenu: () => ({ addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }) }),
      openById: id => { if (!ctx.__foreign[id]) throw new Error('not found'); return ctx.__foreign[id]; }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => props[k] || null,
        setProperty: (k, v) => { props[k] = v; }
      })
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      // Honours the pattern, because a lot of the date handling depends on it.
      formatDate: (d, tz, fmt) => {
        const t = new Date(d);
        const p = (n, w) => String(n).padStart(w || 2, '0');
        const map = {
          yyyy: t.getFullYear(), MM: p(t.getMonth() + 1), dd: p(t.getDate()),
          HH: p(t.getHours()), mm: p(t.getMinutes()), ss: p(t.getSeconds())
        };
        return String(fmt || 'yyyy-MM-dd')
          .replace(/yyyy|MM|dd|HH|mm|ss/g, k => map[k]);
      },
      newBlob: (bytes, mime, name) => ({ bytes, mime, name }),
      base64Decode: s => Buffer.from(s, 'base64')
    },
    Session: {
      getScriptTimeZone: () => 'America/Edmonton',
      getEffectiveUser: () => ({ getEmail: () => ctx.__account })
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) }) }),
      getOAuthToken: () => 'test-token'
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: t => ({ setMimeType: () => ({ _text: t }), _text: t })
    },
    MailApp: { sendEmail: () => {} },
    DriveApp: {
      _files: [],
      // ctx.__drive holds { name: jsonString } for the radar handoff tests.
      getFilesByName(name) {
        const hit = Object.prototype.hasOwnProperty.call(ctx.__drive, name);
        let served = false;
        return {
          hasNext: () => hit && !served,
          next: () => {
            served = true;
            return {
              getBlob: () => ({ getDataAsString: () => ctx.__drive[name] }),
              setName: n => { ctx.__drive[n] = ctx.__drive[name]; delete ctx.__drive[name]; }
            };
          }
        };
      },
      createFolder(name) {
        return { getId: () => 'folder-1', getUrl: () => 'https://drive/folder-1',
                 createFile(blob) {
                   const f = { name: blob.name, getUrl: () => 'https://drive/file-' + blob.name };
                   return f;
                 } };
      },
      getFolderById(id) { if (id !== 'folder-1') throw new Error('gone'); return this.createFolder(); }
    },
    GmailApp: {
      search: () => [], getUserLabelByName: () => null,
      createLabel: () => ({ getName: () => 'pcw-filed' }),
      sendEmail: (to, subject, body, opts) => { ctx.__sent.push({ to, subject, body, opts }); },
      getAliases: () => ctx.__aliases
    },
    CalendarApp: { getCalendarById: () => null },
    UrlFetchApp: { fetch: () => ({ getContentText: () => '{}', getResponseCode: () => 200 }) },
    __ss: ss, __foreign: {}, __drive: {}, __sent: [], __aliases: [], __account: 'admin@pcwagyu.com'
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), ctx);
  return ctx;
}

module.exports = { buildContext };
