/**
 * Peace Country Wagyu — Meat Inventory backend
 * ---------------------------------------------------------------
 * A Google Apps Script Web App that sits on top of one Google Sheet and
 * serves the PCW Inventory phone app (PWA).
 *
 * Design:
 *   MOVEMENTS is the ledger — every intake, sale, adjustment and transfer
 *   is one signed row. Nothing is ever edited in place.
 *   INVENTORY and STOCK BY PRODUCT are rebuilt from the ledger, so the
 *   sheet can never drift away from what actually happened.
 *
 * First run:  Extensions ▸ Apps Script ▸ paste this file ▸ run setup()
 * Then:       Deploy ▸ New deployment ▸ Web app ▸ Execute as: Me ▸
 *             Who has access: Anyone with the link ▸ copy the /exec URL.
 *
 * Version 1.0
 */

/* ============================== CONFIG ============================== */

var TABS = {
  PRODUCTS:  'PRODUCTS',
  BATCHES:   'BATCHES',
  FREEZERS:  'FREEZERS',
  INVENTORY: 'INVENTORY',
  SUMMARY:   'STOCK BY PRODUCT',
  ORDERS:    'ORDERS',
  ORDERITEMS:'ORDER ITEMS',
  MOVEMENTS: 'MOVEMENTS',
  SCANS:     'SCANS',
  BOXES:     'BOX RECIPES',
  STEERS:    'STEER PERFORMANCE',
  CUSTOMERS: 'CUSTOMERS',
  WHOLESALE: 'WHOLESALE',
  WAITLIST:  'CUT WAITLIST',
  YIELD:     'CUT YIELD MODEL',
  HISTORY:   'SALES HISTORY',
  FOLLOWUPS: 'FOLLOW-UPS',
  SETTINGS:  'SETTINGS'
};

var HEADERS = {
  PRODUCTS: ['SKU', 'Product', 'Category', 'Content', 'Sizes', 'Avg weight (lb)', 'Default grade',
             'Price / pack', 'Price / lb', 'Price / kg',
             'Market / pack', 'Market / lb', 'Reorder point', 'Active', 'Notes'],
  BATCHES:  ['Batch ID', 'Animal / tag', 'Outfit', 'Butcher', 'Kill date', 'Pack date',
             'Grade (BMS)', 'Active', 'Notes'],
  FREEZERS: ['Freezer ID', 'Name', 'Location', 'Active', 'Notes'],
  INVENTORY:['SKU', 'Product', 'Content', 'Size', 'Grade', 'Batch', 'Freezer', 'Packages',
             'Weight (lb)', 'Avg wt / pkg', 'Last movement'],
  SUMMARY:  ['SKU', 'Product', 'Content', 'Packages', 'Committed', 'Available',
             'Weight (lb)', 'Reorder point', 'Status', 'Freezers', 'Batches'],
  ORDERS:   ['Order ID', 'Customer', 'Contact', 'Delivery date', 'Method', 'Status',
             'Packages ordered', 'Packages packed', 'Value', 'Notes', 'Created', 'Created by',
             'Packed at', 'Delivered at'],
  ORDERITEMS:['Order ID', 'SKU', 'Product', 'Content', 'Packages', 'Packed', 'Line note'],
  MOVEMENTS:['Move ID', 'Timestamp', 'Type', 'SKU', 'Product', 'Content', 'Size', 'Grade', 'Batch',
             'Freezer', 'Packages', 'Weight (lb)', 'Party / reason', 'User', 'Note', 'Client key'],
  SCANS:    ['Scan ID', 'Taken', 'By', 'Status', 'Photo', 'What the label says',
             'Batch', 'Freezer', 'Note', 'Filed as'],
  BOXES:    ['Box SKU', 'Box', 'Component SKU', 'Component', 'Packages per box', 'Notes'],
  STEERS:   ['Steer ID', 'Tag', 'Outfit', 'Butcher', 'Kill date', 'Pack date', 'Grade (BMS)',
             'Live weight (lb)', 'Hanging weight (lb)', 'Purchase cost', 'Butcher cost',
             'Other cost', 'Total cost', 'Packages cut', 'Saleable weight (lb)', 'Yield %',
             'Cost / saleable lb', 'Model saleable lb', 'Model revenue', 'Potential revenue',
             'Sold so far', 'Still in the freezer', 'Variance vs model', 'Notes'],
  CUSTOMERS:['Customer', 'Email', 'Phone', 'Town', 'First order', 'Last order', 'Orders',
             'Orders before the app', 'Packages', 'Spend', 'Spend before the app',
             'Source', 'In Google Contacts', 'Bought before', 'Notes'],
  WHOLESALE:['Customer', 'Phone', 'Email', 'Wants', 'Status', 'Priority', 'Wanted by',
             'Deposit', 'Weight (lb)', 'Price', 'Invoice', 'Paid', 'Added', 'Notes'],
  WAITLIST: ['Customer', 'Phone', 'Email', 'Waiting for', 'Their words', 'Size', 'Grade',
             'Packages', 'Added', 'Status', 'Told them on'],
  YIELD:    ['Cut', 'SKU', 'Category', 'lb per 100 lb rail', 'Packages per 100 lb rail',
             '$ / lb', 'Grade', 'Use?', 'Notes'],
  HISTORY:  ['Date', 'Customer', 'Sold by', 'What', 'Amount', 'Kind', 'Payment',
             'Counted in stock?', 'Notes'],
  FOLLOWUPS:['Customer', 'Email', 'Phone', 'Bought', 'Share', 'Bought on', 'Due on',
             'Status', 'Flags', 'Subject', 'Draft', 'Written by', 'Hold until',
             'Last contacted', 'Contacted by', 'Notes', 'Updated'],
  SETTINGS: ['Key', 'Value', 'What it does']
};

var MOVEMENT_TYPES = ['INTAKE', 'SALE', 'ADJUST', 'WEIGH', 'TRANSFER_OUT', 'TRANSFER_IN'];

var LB_PER_KG = 2.2046226218;

// Old column names, so an upgrade never loses what is already in the sheet.
var RENAMED = { 'Price / pack': ['Price', 'Price per pack'] };

// Types that add stock (positive packages) vs remove it (negative).
var POSITIVE_TYPES = { INTAKE: true, TRANSFER_IN: true };
var NEGATIVE_TYPES = { SALE: true, TRANSFER_OUT: true };

/* ============================== SETUP ============================== */

/**
 * Run this once. Creates every tab, headers, formatting, validation,
 * a starter freezer list, the API token, and the rebuild trigger.
 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  Object.keys(TABS).forEach(function (key) {
    var name = TABS[key];
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var headers = HEADERS[key];
    migrateTab_(sh, headers);
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#3c2415').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    if (sh.getMaxColumns() > headers.length) {
      sh.deleteColumns(headers.length + 1, sh.getMaxColumns() - headers.length);
    }
    sh.autoResizeColumns(1, headers.length);
  });

  // Seed settings if empty.
  var settings = ss.getSheetByName(TABS.SETTINGS);
  if (settings.getLastRow() < 2) {
    var seed = [
      ['BUSINESS',        'Peace Country Wagyu',  'Shown in the app header'],
      ['WEIGHT_UNIT',     'lb',                   'lb or kg — labelling only'],
      ['LOW_STOCK_EMAIL', '',                     'Email address for the low-stock digest (blank = off)'],
      ['ALLOW_NEGATIVE',  'WARN',                 'BLOCK = refuse a sale with no stock, WARN = allow and flag'],
      ['DEFAULT_FREEZER', 'MAIN',                 'Freezer pre-selected in the app'],
      ['AGE_WARN_DAYS',   '180',                  'Flag a lot once it has been in the freezer this long'],
      ['AGE_URGENT_DAYS', '300',                  'Second, louder flag'],
      ['CALENDAR_ID',     '',                     'PCW calendar for delivery dates (blank = off)'],
      ['CONTACTS_LABEL',  'PCW Customers',        'Google Contacts label new buyers are filed under'],
      ['ORDER_EMAIL_FROM','squarespace.com',      'Sender that website order emails come from'],
      ['BOX_TARGETS',     '89, 119, 159, 229',    'Price points new box ideas are built toward'],
      ['SALES_SHEET_ID',  '',                     'The "1. 2026 sales sheet" file ID — the lists and customers are read from it'],
      ['FOLLOWUP_SEND_AS','sales@pcwagyu.com',    'Address follow-up emails come from. Must be a "Send mail as" alias on the account that owns the script'],
      ['FOLLOWUP_FROM',   'Peace Country Wagyu',  'Name shown beside that address'],
      ['FOLLOWUP_BCC',    '',                     'Address BCC\'d on every follow-up (blank = off)'],
      ['RADAR_FILE',      'pcw-followups.json',   'File the weekly reorder radar drops in Drive for the app to pick up'],
      ['QUARTER_MONTHS',  '3',                    'Months after a quarter before the freezer is likely low'],
      ['HALF_MONTHS',     '6',                    'Months after a half'],
      ['WHOLE_MONTHS',    '10',                   'Months after a whole animal'],
      ['FOLLOWUP_WINDOW', '30',                   'Days a follow-up stays "due now" before it reads overdue']
    ];
    settings.getRange(2, 1, seed.length, 3).setValues(seed);
  }

  // Seed freezers if empty.
  var fz = ss.getSheetByName(TABS.FREEZERS);
  if (fz.getLastRow() < 2) {
    fz.getRange(2, 1, 3, 5).setValues([
      ['MAIN',  'Main chest freezer', 'Home shop',   'Yes', ''],
      ['SHOP',  'Shop upright',       'Shop',        'Yes', ''],
      ['TRUCK', 'Delivery cooler',    'Truck / runs','Yes', 'Stock out on a delivery run']
    ]);
  }

  // Number formats.
  var mv = ss.getSheetByName(TABS.MOVEMENTS);
  mv.getRange('B2:B').setNumberFormat('yyyy-mm-dd hh:mm');
  mv.getRange('K2:L').setNumberFormat('0.00');
  ss.getSheetByName(TABS.INVENTORY).getRange('H2:J').setNumberFormat('0.00');
  ss.getSheetByName(TABS.SUMMARY).getRange('D2:G').setNumberFormat('0.00');
  ss.getSheetByName(TABS.PRODUCTS).getRange('H2:L').setNumberFormat('$#,##0.00');
  ss.getSheetByName(TABS.ORDERS).getRange('D2:D').setNumberFormat('yyyy-mm-dd');
  ss.getSheetByName(TABS.ORDERS).getRange('I2:I').setNumberFormat('$#,##0.00');
  ss.getSheetByName(TABS.ORDERS).getRange('K2:K').setNumberFormat('yyyy-mm-dd hh:mm');

  // API token.
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('API_TOKEN')) {
    props.setProperty('API_TOKEN', Utilities.getUuid().replace(/-/g, '').slice(0, 24));
  }

  // Rebuild trigger every 5 minutes, so edits made straight in the sheet
  // (or by Claude) flow through to the stock views.
  var existing = ScriptApp.getProjectTriggers();
  var hasRebuild = existing.some(function (t) { return t.getHandlerFunction() === 'rebuildInventory'; });
  if (!hasRebuild) {
    ScriptApp.newTrigger('rebuildInventory').timeBased().everyMinutes(5).create();
  }

  rebuildInventory();

  SpreadsheetApp.getUi().alert(
    'PCW Inventory is set up.\n\n' +
    'API token: ' + props.getProperty('API_TOKEN') + '\n\n' +
    'Deploy ▸ New deployment ▸ Web app, then paste the /exec URL and this ' +
    'token into the phone app settings screen.'
  );
}

/**
 * If a tab was built by an older version, move each row's values into the
 * columns their headers now sit in, so adding a column never scrambles data.
 */
function migrateTab_(sh, headers) {
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return;

  var old = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  if (!old.filter(String).length) return;                    // brand new tab
  var same = headers.length === old.filter(String).length &&
             headers.every(function (h, i) { return old[i] === h; });
  if (same) return;

  var body = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
  var remapped = body.map(function (row) {
    return headers.map(function (h) {
      var at = old.indexOf(h);
      if (at === -1) {                       // column was renamed at some point
        var was = RENAMED[h] || [];
        for (var i = 0; i < was.length && at === -1; i++) at = old.indexOf(was[i]);
      }
      return at === -1 ? '' : row[at];
    });
  });
  sh.getRange(1, 1, lastRow, Math.max(lastCol, headers.length)).clearContent();
  if (remapped.length) sh.getRange(2, 1, remapped.length, headers.length).setValues(remapped);
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('PCW Inventory')
    .addItem('Rebuild stock from ledger', 'rebuildInventory')
    .addItem('Show API token', 'showToken')
    .addItem('Email low-stock digest now', 'sendLowStockDigest')
    .addItem('Open the label-photo folder', 'openScanFolder')
    .addSeparator()
    .addItem('Fetch website orders now', 'sweepWebsiteOrders_')
    .addItem('Import the lists from the 2026 sales sheet', 'importFromSalesSheet_')
    .addItem('Pick up this week\'s reorder radar', 'pullRadar_')
    .addItem('Put orders on the calendar', 'syncCalendar_')
    .addItem('File customers in Google Contacts', 'syncContacts_')
    .addSeparator()
    .addItem('Run first-time setup', 'setup')
    .addToUi();
}

function openScanFolder() {
  SpreadsheetApp.getUi().alert('Label photos are filed here:\n\n' + scanFolder_().getUrl());
}

function showToken() {
  var t = PropertiesService.getScriptProperties().getProperty('API_TOKEN') || '(not set — run setup)';
  SpreadsheetApp.getUi().alert('API token:\n\n' + t);
}

/* ============================ SHEET I/O ============================ */

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Missing tab: ' + name + ' — run setup() first.');
  return sh;
}

/** Reads a tab into an array of objects keyed by header text. */
function readTable_(name) {
  var sh = sheet_(name);
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 2) return [];
  var values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var head = values.shift().map(function (h) { return String(h).trim(); });
  return values.map(function (row) {
    var obj = {};
    head.forEach(function (h, i) { if (h) obj[h] = row[i]; });
    return obj;
  }).filter(function (o) {
    return Object.keys(o).some(function (k) { return o[k] !== '' && o[k] !== null; });
  });
}

/** Overwrites a tab's body (keeps the header row). */
function writeTable_(name, headers, rows) {
  var sh = sheet_(name);
  var lastRow = sh.getLastRow();
  if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, headers.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
}

function str_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function num_(v) {
  if (v === null || v === undefined || v === '') return 0;
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}
function yes_(v) {
  var s = str_(v).toLowerCase();
  return s === '' || s === 'yes' || s === 'true' || s === 'y' || s === '1';
}

/* ====================== STOCK REBUILD (LEDGER) ====================== */

/**
 * Rebuilds INVENTORY and STOCK BY PRODUCT from the MOVEMENTS ledger.
 * Safe to run any time; it is the single source of truth for stock levels.
 */
function rebuildInventory() {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { return; }
  try {
    normalizePrices_();
    var moves = readTable_(TABS.MOVEMENTS);
    var products = indexProducts_();
    var lines = {};   // key -> line totals

    moves.forEach(function (m) {
      var sku = str_(m['SKU']);
      if (!sku) return;
      var key = [sku, str_(m['Size']), str_(m['Grade']), str_(m['Batch']), str_(m['Freezer'])].join('|');
      if (!lines[key]) {
        lines[key] = {
          sku: sku,
          product: str_(m['Product']) || (products[sku] ? products[sku].product : sku),
          content: str_(m['Content']) || (products[sku] ? products[sku].content : ''),
          size: str_(m['Size']),
          grade: str_(m['Grade']),
          batch: str_(m['Batch']),
          freezer: str_(m['Freezer']),
          packages: 0,
          weight: 0,
          last: ''
        };
      }
      var line = lines[key];
      line.packages += num_(m['Packages']);
      line.weight += num_(m['Weight (lb)']);
      var ts = m['Timestamp'];
      if (ts instanceof Date) {
        if (!line.lastDate || ts > line.lastDate) { line.lastDate = ts; }
      }
    });

    var invRows = [];
    var byProduct = {};
    Object.keys(lines).forEach(function (key) {
      var l = lines[key];
      var rounded = Math.round(l.packages * 1000) / 1000;
      if (rounded === 0 && Math.abs(l.weight) < 0.005) return;   // fully consumed line
      invRows.push([
        l.sku, l.product, l.content, l.size, l.grade, l.batch, l.freezer,
        rounded, l.weight ? Math.round(l.weight * 100) / 100 : '',
        rounded && l.weight ? Math.round((l.weight / rounded) * 100) / 100 : '',
        l.lastDate || ''
      ]);
      var p = byProduct[l.sku] || (byProduct[l.sku] = {
        sku: l.sku, product: l.product, content: l.content,
        packages: 0, weight: 0, freezers: {}, batches: {}
      });
      p.packages += rounded;
      p.weight += l.weight;
      if (l.freezer) p.freezers[l.freezer] = true;
      if (l.batch) p.batches[l.batch] = true;
    });

    invRows.sort(function (a, b) {
      return String(a[1]).localeCompare(String(b[1])) || String(a[4]).localeCompare(String(b[4]));
    });
    writeTable_(TABS.INVENTORY, HEADERS.INVENTORY, invRows);

    // Summary — include catalogued products with zero stock so gaps are visible.
    Object.keys(products).forEach(function (sku) {
      if (!byProduct[sku] && products[sku].active) {
        byProduct[sku] = {
          sku: sku, product: products[sku].product, content: products[sku].content,
          packages: 0, weight: 0, freezers: {}, batches: {}
        };
      }
    });

    var committed = committedBySku_();
    var sumRows = Object.keys(byProduct).map(function (sku) {
      var p = byProduct[sku];
      var reorder = products[sku] ? products[sku].reorder : '';
      var owed = Math.round((committed[sku] || 0) * 1000) / 1000;
      var onHand = Math.round(p.packages * 1000) / 1000;
      var available = Math.round((onHand - owed) * 1000) / 1000;
      // Status is judged on what is actually free to sell, not what is stacked
      // in the freezer — meat promised to an order is already gone.
      var status = 'OK';
      if (available < 0) status = 'OVERSOLD';
      else if (available === 0) status = 'OUT';
      else if (reorder !== '' && available <= num_(reorder)) status = 'LOW';
      return [
        p.sku, p.product, p.content, onHand, owed, available,
        p.weight ? Math.round(p.weight * 100) / 100 : '',
        reorder, status,
        Object.keys(p.freezers).join(', '),
        Object.keys(p.batches).join(', ')
      ];
    }).sort(function (a, b) { return String(a[1]).localeCompare(String(b[1])); });

    writeTable_(TABS.SUMMARY, HEADERS.SUMMARY, sumRows);
    rebuildOrderTotals_();
    rebuildSteers_();
    rebuildCustomers_();
    rebuildFollowups_();

    // Colour the status column.
    var sh = sheet_(TABS.SUMMARY);
    if (sumRows.length) {
      var rng = sh.getRange(2, 9, sumRows.length, 1);
      var colours = sumRows.map(function (r) {
        var st = r[8];
        return [st === 'OVERSOLD' ? '#e8b7b7'
              : st === 'OUT' ? '#f4cccc'
              : st === 'LOW' ? '#fce5cd' : '#d9ead3'];
      });
      rng.setBackgrounds(colours);
    }
  } finally {
    lock.releaseLock();
  }
}

function indexProducts_() {
  var out = {};
  readTable_(TABS.PRODUCTS).forEach(function (p) {
    var sku = str_(p['SKU']);
    if (!sku) return;
    out[sku] = {
      sku: sku,
      product: str_(p['Product']),
      category: str_(p['Category']),
      content: str_(p['Content']),
      sizes: str_(p['Sizes']),
      avgWeight: num_(p['Avg weight (lb)']),
      grade: str_(p['Default grade']),
      price: num_(p['Price / pack']),
      pricePerLb: num_(p['Price / lb']),
      pricePerKg: num_(p['Price / kg']),
      marketPrice: num_(p['Market / pack']),
      marketPerLb: num_(p['Market / lb']),
      reorder: p['Reorder point'] === '' ? '' : num_(p['Reorder point']),
      active: yes_(p['Active']),
      notes: str_(p['Notes'])
    };
  });
  return out;
}

/**
 * Keeps the three price columns agreeing with each other. Whichever one you
 * type, the others fill themselves in:
 *   • per lb entered  → per kg = per lb × 2.2046
 *   • per kg entered  → per lb = per kg ÷ 2.2046
 *   • only a pack price and an average weight → both per-weight prices
 *   • only per-lb and an average weight → pack price
 * Anything you typed yourself is left exactly as you typed it.
 */
function normalizePrices_() {
  var sh = sheet_(TABS.PRODUCTS);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return;

  var head = sh.getRange(1, 1, 1, HEADERS.PRODUCTS.length).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var cPack = head.indexOf('Price / pack');
  var cLb   = head.indexOf('Price / lb');
  var cKg   = head.indexOf('Price / kg');
  var cWt   = head.indexOf('Avg weight (lb)');
  if (cPack === -1 || cLb === -1 || cKg === -1) return;

  var rng = sh.getRange(2, 1, lastRow - 1, HEADERS.PRODUCTS.length);
  var rows = rng.getValues();
  var changed = false;

  rows.forEach(function (row) {
    var pack = num_(row[cPack]);
    var lb = num_(row[cLb]);
    var kg = num_(row[cKg]);
    var wt = cWt === -1 ? 0 : num_(row[cWt]);

    if (!lb && kg) { lb = kg / LB_PER_KG; row[cLb] = Math.round(lb * 100) / 100; changed = true; }
    if (!lb && !kg && pack && wt) { lb = pack / wt; row[cLb] = Math.round(lb * 100) / 100; changed = true; }
    if (lb && !kg) { row[cKg] = Math.round(lb * LB_PER_KG * 100) / 100; changed = true; }
    if (!pack && lb && wt) { row[cPack] = Math.round(lb * wt * 100) / 100; changed = true; }
  });

  if (changed) rng.setValues(rows);
}

function indexBatches_() {
  return readTable_(TABS.BATCHES).map(function (b) {
    return {
      id: str_(b['Batch ID']),
      animal: str_(b['Animal / tag']),
      outfit: str_(b['Outfit']),
      butcher: str_(b['Butcher']),
      killDate: b['Kill date'] instanceof Date ? b['Kill date'].toISOString().slice(0, 10) : str_(b['Kill date']),
      packDate: b['Pack date'] instanceof Date ? b['Pack date'].toISOString().slice(0, 10) : str_(b['Pack date']),
      grade: str_(b['Grade (BMS)']),
      active: yes_(b['Active']),
      notes: str_(b['Notes'])
    };
  }).filter(function (b) { return b.id; });
}

function indexFreezers_() {
  return readTable_(TABS.FREEZERS).map(function (f) {
    return {
      id: str_(f['Freezer ID']),
      name: str_(f['Name']),
      location: str_(f['Location']),
      active: yes_(f['Active'])
    };
  }).filter(function (f) { return f.id; });
}

function settings_() {
  var out = {};
  readTable_(TABS.SETTINGS).forEach(function (r) {
    var k = str_(r['Key']);
    if (k) out[k] = str_(r['Value']);
  });
  return out;
}

/** Current stock lines straight from the ledger (does not touch the sheet). */
function currentStock_() {
  var moves = readTable_(TABS.MOVEMENTS);
  var lines = {};
  moves.forEach(function (m) {
    var sku = str_(m['SKU']);
    if (!sku) return;
    var key = [sku, str_(m['Size']), str_(m['Grade']), str_(m['Batch']), str_(m['Freezer'])].join('|');
    if (!lines[key]) {
      lines[key] = {
        key: key, sku: sku, product: str_(m['Product']), content: str_(m['Content']),
        size: str_(m['Size']), grade: str_(m['Grade']), batch: str_(m['Batch']),
        freezer: str_(m['Freezer']), packages: 0, weight: 0
      };
    }
    lines[key].packages += num_(m['Packages']);
    lines[key].weight += num_(m['Weight (lb)']);
    var ts = m['Timestamp'];
    if (ts instanceof Date && num_(m['Packages']) > 0) {
      if (!lines[key].firstIn || ts < lines[key].firstIn) lines[key].firstIn = ts;
    }
  });
  var today = new Date();
  return Object.keys(lines).map(function (k) {
    var l = lines[k];
    l.packages = Math.round(l.packages * 1000) / 1000;
    l.weight = Math.round(l.weight * 100) / 100;
    l.days = l.firstIn ? Math.floor((today - l.firstIn) / 86400000) : '';
    l.firstIn = l.firstIn ? Utilities.formatDate(l.firstIn, Session.getScriptTimeZone(), 'yyyy-MM-dd') : '';
    return l;
  }).filter(function (l) { return l.packages !== 0 || Math.abs(l.weight) >= 0.005; });
}

/* =============================== ORDERS =============================== */

var ORDER_STATUSES = ['Open', 'Packed', 'Delivered', 'Cancelled'];

/** Every order with its lines, newest delivery date last. */
function readOrders_() {
  var items = {};
  readTable_(TABS.ORDERITEMS).forEach(function (r) {
    var id = str_(r['Order ID']);
    if (!id) return;
    (items[id] || (items[id] = [])).push({
      sku: str_(r['SKU']),
      product: str_(r['Product']),
      content: str_(r['Content']),
      packages: num_(r['Packages']),
      packed: num_(r['Packed']),
      note: str_(r['Line note'])
    });
  });

  return readTable_(TABS.ORDERS).map(function (o) {
    var id = str_(o['Order ID']);
    return {
      id: id,
      customer: str_(o['Customer']),
      contact: str_(o['Contact']),
      deliveryDate: dateStr_(o['Delivery date']),
      method: str_(o['Method']),
      status: str_(o['Status']) || 'Open',
      notes: str_(o['Notes']),
      created: dateStr_(o['Created']),
      createdBy: str_(o['Created by']),
      packedAt: dateStr_(o['Packed at']),
      deliveredAt: dateStr_(o['Delivered at']),
      items: items[id] || []
    };
  }).filter(function (o) { return o.id; })
    .sort(function (a, b) { return String(a.deliveryDate).localeCompare(String(b.deliveryDate)); });
}

function dateStr_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return str_(v);
}

function orderRowIndex_(id) {
  var sh = sheet_(TABS.ORDERS);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return -1;
  var ids = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (str_(ids[i][0]) === id) return i + 2;
  return -1;
}

/** Creates an order. The phone makes the ID so it works with no signal. */
function orderNew_(op, products) {
  var id = str_(op.orderId) || ('ORD-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss'));
  if (orderRowIndex_(id) !== -1) return { ok: true, orderId: id };   // already sent

  var customer = str_(op.customer);
  if (!customer) return { error: 'An order needs a customer name.' };
  var lines = (op.lines || []).filter(function (l) { return str_(l.sku) && num_(l.packages) > 0; });
  if (!lines.length) return { error: 'Order for ' + customer + ' had no items.' };

  sheet_(TABS.ORDERS).appendRow([
    id, customer, str_(op.contact), str_(op.deliveryDate), str_(op.method) || 'Pickup',
    'Open', '', '', '', str_(op.notes), new Date(), str_(op.user), '', ''
  ]);

  var itemRows = lines.map(function (l) {
    var p = products[str_(l.sku)] || {};
    return [id, str_(l.sku), str_(l.product) || p.product || l.sku,
            str_(l.content) || p.content || '', num_(l.packages), '', str_(l.note)];
  });
  var sh = sheet_(TABS.ORDERITEMS);
  sh.getRange(sh.getLastRow() + 1, 1, itemRows.length, HEADERS.ORDERITEMS.length).setValues(itemRows);
  return { ok: true, orderId: id };
}

/** Sets an order's status, delivery date or notes. */
function orderStatus_(op) {
  var id = str_(op.orderId);
  var row = orderRowIndex_(id);
  if (row === -1) return { error: 'Order ' + id + ' was not found.' };
  var sh = sheet_(TABS.ORDERS);

  if (op.status) {
    var status = str_(op.status);
    if (ORDER_STATUSES.indexOf(status) === -1) return { error: 'Unknown order status: ' + status };
    sh.getRange(row, 6).setValue(status);
    if (status === 'Delivered') sh.getRange(row, 14).setValue(new Date());
  }
  if (op.deliveryDate !== undefined && op.deliveryDate !== null) sh.getRange(row, 4).setValue(str_(op.deliveryDate));
  if (op.method) sh.getRange(row, 5).setValue(str_(op.method));
  if (op.notes !== undefined && op.notes !== null) sh.getRange(row, 10).setValue(str_(op.notes));
  return { ok: true, orderId: id };
}

/**
 * Packing an order is what takes the meat out of the freezer: each line
 * becomes a SALE movement, oldest batch first, and the order goes to Packed.
 */
function orderPackRows_(op, products, stock, allowNegative, warnings) {
  var id = str_(op.orderId);
  var row = orderRowIndex_(id);
  if (row === -1) return { error: 'Order ' + id + ' was not found.' };

  var orders = readOrders_().filter(function (o) { return o.id === id; })[0];
  if (!orders) return { error: 'Order ' + id + ' has no lines.' };
  if (orders.status === 'Packed' || orders.status === 'Delivered') return { rows: [] };

  // What was actually packed — defaults to what was ordered.
  var packedBy = {};
  (op.lines || []).forEach(function (l) { packedBy[str_(l.sku)] = num_(l.packages); });

  var rows = [];
  orders.items.forEach(function (item) {
    var qty = packedBy[item.sku] === undefined ? item.packages : packedBy[item.sku];
    if (!qty) return;
    var saleOp = {
      type: 'SALE', sku: item.sku, product: item.product, content: item.content,
      freezer: str_(op.freezer), packages: qty,
      party: orders.customer, user: str_(op.user),
      note: 'Order ' + id + (item.note ? ' — ' + item.note : ''),
      clientKey: str_(op.clientKey) + ':' + item.sku,
      timestamp: op.timestamp
    };
    var res = expandOp_(saleOp, products, stock, allowNegative, warnings);
    if (res.error) { warnings.push(res.error); return; }
    res.rows.forEach(function (r) { rows.push(r); });
  });

  // Write the packed quantities back onto the lines.
  var sh = sheet_(TABS.ORDERITEMS);
  var lastRow = sh.getLastRow();
  if (lastRow > 1) {
    var vals = sh.getRange(2, 1, lastRow - 1, HEADERS.ORDERITEMS.length).getValues();
    var changed = false;
    vals.forEach(function (r) {
      if (str_(r[0]) !== id) return;
      var sku = str_(r[1]);
      r[5] = packedBy[sku] === undefined ? num_(r[4]) : packedBy[sku];
      changed = true;
    });
    if (changed) sh.getRange(2, 1, vals.length, HEADERS.ORDERITEMS.length).setValues(vals);
  }

  var osh = sheet_(TABS.ORDERS);
  osh.getRange(row, 6).setValue('Packed');
  osh.getRange(row, 13).setValue(new Date());
  return { rows: rows };
}

/**
 * Packages promised to orders that haven't been packed yet, by SKU.
 * An order is a commitment: that meat is spoken for even though it is
 * still physically in the freezer.
 */
function committedBySku_() {
  var out = {};
  readOrders_().forEach(function (o) {
    if (o.status !== 'Open') return;
    o.items.forEach(function (i) {
      var owed = i.packages - i.packed;
      if (owed > 0) out[i.sku] = (out[i.sku] || 0) + owed;
    });
  });
  return out;
}

/** Fills in the per-order totals shown in the Sheet. */
function rebuildOrderTotals_() {
  var sh = sheet_(TABS.ORDERS);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return;
  var products = indexProducts_();
  var orders = readOrders_();
  var byId = {};
  orders.forEach(function (o) { byId[o.id] = o; });

  var rng = sh.getRange(2, 1, lastRow - 1, HEADERS.ORDERS.length);
  var vals = rng.getValues();
  vals.forEach(function (r) {
    var o = byId[str_(r[0])];
    if (!o) return;
    var ordered = 0, packed = 0, value = 0;
    o.items.forEach(function (it) {
      ordered += it.packages;
      packed += it.packed;
      var p = products[it.sku] || {};
      var per = num_(p.price) || (num_(p.pricePerLb) * num_(p.avgWeight));
      value += per * it.packages;
    });
    r[6] = ordered;
    r[7] = packed;
    r[8] = Math.round(value * 100) / 100;
  });
  rng.setValues(vals);
}

/* ============================== SCANS ============================== */

/** The Drive folder photographed labels land in; made on first use. */
function scanFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SCAN_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* deleted — remake it */ }
  }
  var folder = DriveApp.createFolder('PCW Inventory — label photos');
  props.setProperty('SCAN_FOLDER_ID', folder.getId());
  return folder;
}

/**
 * Takes one photographed label from the phone, files the image in Drive and
 * queues a row for someone (or Kenji) to read and turn into stock.
 */
function saveScan_(req) {
  var data = str_(req.image);
  if (!data) return { ok: false, error: 'No photo came through.' };
  data = data.replace(/^data:[^;]+;base64,/, '');

  var clientKey = str_(req.clientKey);
  var sh = sheet_(TABS.SCANS);
  if (clientKey) {
    var lastRow = sh.getLastRow();
    if (lastRow > 1) {
      var ids = sh.getRange(2, 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) {
        if (str_(ids[i][0]) === clientKey) return { ok: true, scanId: clientKey, duplicate: true };
      }
    }
  }

  var id = clientKey || ('SCAN-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss'));
  var blob = Utilities.newBlob(Utilities.base64Decode(data), str_(req.mime) || 'image/jpeg', id + '.jpg');
  var file = scanFolder_().createFile(blob);

  sh.appendRow([id, new Date(), str_(req.user), 'Pending', file.getUrl(), '',
                str_(req.batch), str_(req.freezer), str_(req.note), '']);
  return { ok: true, scanId: id, url: file.getUrl() };
}

function listScans_(status) {
  var want = str_(status);
  return {
    ok: true,
    scans: readTable_(TABS.SCANS).map(function (r) {
      return {
        id: str_(r['Scan ID']),
        taken: r['Taken'] instanceof Date ? r['Taken'].toISOString() : str_(r['Taken']),
        by: str_(r['By']), status: str_(r['Status']) || 'Pending',
        photo: str_(r['Photo']), read: str_(r['What the label says']),
        batch: str_(r['Batch']), freezer: str_(r['Freezer']),
        note: str_(r['Note']), filedAs: str_(r['Filed as'])
      };
    }).filter(function (s) { return s.id && (!want || s.status === want); })
  };
}

/**
 * Turns a pending scan into stock. `ops` are ordinary movements, so a label
 * read as "Ribeye, L, Gold, 1.7 lb" files exactly like a typed intake.
 */
function fileScan_(req) {
  var id = str_(req.scanId);
  var sh = sheet_(TABS.SCANS);
  var lastRow = sh.getLastRow();
  var row = -1;
  if (lastRow > 1) {
    var ids = sh.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) if (str_(ids[i][0]) === id) { row = i + 2; break; }
  }
  if (row === -1) return { ok: false, error: 'Scan ' + id + ' was not found.' };

  var status = str_(req.status) || 'Filed';
  var result = { ok: true, accepted: [], warnings: [] };
  if (req.ops && req.ops.length) result = submit_({ ops: req.ops });

  sh.getRange(row, 4).setValue(status);
  if (req.read !== undefined) sh.getRange(row, 6).setValue(str_(req.read));
  sh.getRange(row, 10).setValue((req.ops || []).map(function (o) {
    return str_(o.sku) + ' ×' + num_(o.packages);
  }).join(', '));
  return { ok: true, scanId: id, status: status, warnings: result.warnings || [] };
}

/* ============================ AGEING ============================ */

/**
 * Lots that have sat too long. Meat does not spoil on a schedule, but a pack
 * that has been in the freezer since spring is money quietly turning into
 * freezer burn — so the app says so, and says where it could go.
 */
function ageing_() {
  var st = settings_();
  var warn = num_(st.AGE_WARN_DAYS) || 180;
  var urgent = num_(st.AGE_URGENT_DAYS) || 300;
  var products = indexProducts_();

  return currentStock_().filter(function (l) {
    return l.packages > 0 && l.days !== '' && l.days >= warn;
  }).map(function (l) {
    var p = products[l.sku] || {};
    return {
      sku: l.sku, product: l.product || l.sku, size: l.size, grade: l.grade,
      batch: l.batch, freezer: l.freezer, packages: l.packages,
      days: l.days, since: l.firstIn,
      level: l.days >= urgent ? 'urgent' : 'warn',
      value: Math.round((num_(p.price) * l.packages ||
                         num_(p.pricePerLb) * l.weight) * 100) / 100,
      suggestion: ageSuggestion_(p, l)
    };
  }).sort(function (a, b) { return b.days - a.days; });
}

function ageSuggestion_(p, l) {
  var cat = str_(p.category).toLowerCase();
  if (cat === 'box') return 'Break it up — the cuts inside will move faster than the box.';
  if (cat === 'steak') return 'Put it in a box or take it to the market table.';
  if (cat === 'roast') return 'Market table, or offer it to the wholesale waiting list.';
  if (cat === 'ground') return 'Bundle it — ground moves in volume at the market.';
  if (cat === 'sausage & deli') return 'Market table. Sausage is the easiest impulse buy you have.';
  return 'Discount it or use it up before it goes to waste.';
}

/* ========================= BOXES: BUILD & BREAK ========================= */

/** Box recipes, as { boxSku: [{sku, qty}] }. */
function boxRecipes_() {
  var out = {};
  readTable_(TABS.BOXES).forEach(function (r) {
    var box = str_(r['Box SKU']);
    var part = str_(r['Component SKU']);
    if (!box || !part) return;
    (out[box] || (out[box] = [])).push({
      sku: part, product: str_(r['Component']), qty: num_(r['Packages per box']) || 1
    });
  });
  return out;
}

/** How many of each box could be built right now, and what is short. */
function buildable_() {
  var recipes = boxRecipes_();
  var products = indexProducts_();
  var committed = committedBySku_();
  var onHand = {};
  currentStock_().forEach(function (l) { onHand[l.sku] = (onHand[l.sku] || 0) + l.packages; });

  return Object.keys(recipes).map(function (box) {
    var parts = recipes[box].map(function (c) {
      var free = (onHand[c.sku] || 0) - (committed[c.sku] || 0);
      return {
        sku: c.sku, product: c.product || (products[c.sku] || {}).product || c.sku,
        needPerBox: c.qty, free: Math.round(free * 100) / 100,
        boxesWorth: c.qty ? Math.floor(free / c.qty) : 0
      };
    });
    var can = parts.reduce(function (m, c) { return Math.min(m, c.boxesWorth); }, Infinity);
    can = can === Infinity ? 0 : Math.max(can, 0);
    return {
      sku: box, product: (products[box] || {}).product || box,
      canBuild: can, onHand: Math.round((onHand[box] || 0) * 100) / 100,
      shortOf: parts.filter(function (c) { return c.boxesWorth <= can; }).map(function (c) { return c.product; }),
      parts: parts
    };
  }).sort(function (a, b) { return b.canBuild - a.canBuild; });
}

/**
 * Building a box takes the cuts out and puts the box in. Breaking one does the
 * reverse — which is what happened to the Christmas boxes.
 */
function buildBoxOps_(op) {
  var box = str_(op.boxSku);
  var count = Math.abs(num_(op.count)) || 1;
  var breaking = str_(op.type).toUpperCase() === 'BREAK_BOX';
  var recipe = boxRecipes_()[box];
  if (!recipe) return { error: 'No recipe for ' + box + ' on the BOX RECIPES tab.' };

  var freezer = str_(op.freezer);
  var batch = str_(op.batch);
  var user = str_(op.user);
  var key = str_(op.clientKey);
  var ops = [];

  recipe.forEach(function (c, i) {
    ops.push({
      type: 'ADJUST', sku: c.sku, packages: (breaking ? 1 : -1) * c.qty * count,
      freezer: freezer, batch: batch, user: user,
      party: breaking ? 'Box broken up' : 'Into ' + box,
      note: box + ' ×' + count, clientKey: key + ':part' + i, timestamp: op.timestamp
    });
  });
  ops.push({
    type: breaking ? 'ADJUST' : 'INTAKE', sku: box,
    packages: breaking ? -count : count,
    freezer: freezer, batch: batch, user: user,
    party: breaking ? 'Box broken up' : 'Box assembled',
    clientKey: key + ':box', timestamp: op.timestamp
  });
  return { ops: ops };
}

/**
 * Box ideas that do not exist yet. Works from what is actually free in the
 * freezer, oldest first, and fills toward the price points you sell at — so
 * the answer to "what do I do with 26 packs of old sausage" is a box, priced.
 */
function suggestBoxes_(req) {
  var st = settings_();
  var market = str_((req || {}).channel).toLowerCase() === 'market';
  var targets = (st.BOX_TARGETS || '89, 119, 159, 229').split(',')
    .map(function (t) { return num_(t); }).filter(function (t) { return t > 0; });

  var products = indexProducts_();
  var committed = committedBySku_();
  var recipes = boxRecipes_();

  // One candidate per product: what is free, how old the oldest pack is.
  var pool = {};
  currentStock_().forEach(function (l) {
    if (l.packages <= 0) return;
    var p = products[l.sku] || {};
    if (str_(p.category).toLowerCase() === 'box' || recipes[l.sku]) return;   // never box a box
    var each = market ? (num_(p.marketPrice) || num_(p.price)) : num_(p.price);
    if (!each) {
      var perLb = market ? (num_(p.marketPerLb) || num_(p.pricePerLb)) : num_(p.pricePerLb);
      var w = l.packages ? l.weight / l.packages : num_(p.avgWeight);
      each = perLb * (w || num_(p.avgWeight));
    }
    if (!each) return;                                   // nothing priced, nothing quotable
    var c = pool[l.sku] || (pool[l.sku] = {
      sku: l.sku, product: l.product || p.product || l.sku, each: Math.round(each * 100) / 100,
      free: 0, days: 0, reorder: p.reorder === '' ? null : num_(p.reorder)
    });
    c.free += l.packages;
    if (l.days !== '' && l.days > c.days) c.days = l.days;
  });

  var candidates = Object.keys(pool).map(function (k) { return pool[k]; }).filter(function (c) {
    c.free = Math.round((c.free - (committed[c.sku] || 0)) * 100) / 100;
    c.surplus = c.reorder != null ? c.free - c.reorder : c.free;
    return c.free > 0;
  });
  if (!candidates.length) return [];

  // Oldest first, then whatever there is most spare of.
  candidates.sort(function (a, b) { return (b.days - a.days) || (b.surplus - a.surplus); });

  return targets.map(function (target) {
    var left = Object.create(null);
    candidates.forEach(function (c) { left[c.sku] = Math.floor(c.free); });
    var items = [], total = 0;

    // Two passes: spread across cuts first, then top up with whatever fits.
    [1, 3].forEach(function (maxEach) {
      candidates.forEach(function (c) {
        for (var n = 0; n < maxEach; n++) {
          if (total + c.each > target * 1.08) return;
          if (left[c.sku] <= 0) return;
          left[c.sku]--;
          total = Math.round((total + c.each) * 100) / 100;
          var line = items.filter(function (i) { return i.sku === c.sku; })[0];
          if (line) line.qty++;
          else items.push({ sku: c.sku, product: c.product, qty: 1, each: c.each, days: c.days });
        }
      });
    });

    if (!items.length || total < target * 0.8) return null;
    var oldest = items.reduce(function (m, i) { return Math.max(m, i.days); }, 0);
    var warnAt = num_(st.AGE_WARN_DAYS) || 180;
    var clears = items.filter(function (i) { return i.days >= warnAt; });
    return {
      target: target, raw: total, items: items,
      packages: items.reduce(function (s, i) { return s + i.qty; }, 0),
      oldestDays: oldest,
      clears: clears.map(function (i) { return i.product; }),
      clearsPackages: clears.reduce(function (s, i) { return s + i.qty; }, 0),
      clearsValue: Math.round(clears.reduce(function (s, i) { return s + i.qty * i.each; }, 0) * 100) / 100
    };
  }).filter(Boolean).map(function (b) {
    // House rule: prices end in 5 or 9.
    var p = Math.round(b.raw);
    while (p % 10 !== 5 && p % 10 !== 9) p--;
    b.price = p;
    b.discount = Math.round((b.raw - p) * 100) / 100;
    b.reason = boxReason_(b);
    return b;
  });
}

/** Says in plain words why a proposed box is worth making. */
function boxReason_(b) {
  var bits = [];
  if (b.clearsPackages) {
    bits.push('Moves ' + b.clearsPackages + ' package' + (b.clearsPackages === 1 ? '' : 's') +
      ' that have been in the freezer ' + Math.round(b.oldestDays / 30) +
      ' months — about $' + b.clearsValue + ' that is otherwise heading for freezer burn');
  }
  var kinds = b.items.length;
  if (kinds >= 4) bits.push('spreads across ' + kinds + ' cuts, so no single line gets stripped');
  if (b.discount > 0) bits.push('priced at $' + b.price + ', $' + b.discount +
    ' under the sum of its parts — enough to feel like a deal without discounting a headline cut');
  else bits.push('priced at $' + b.price + ', which is what the contents are worth');
  return bits.join('. ') + '.';
}

/** Turns a box idea into a box you can actually build. */
function saveBoxIdea_(req) {
  var name = str_(req.name);
  var items = req.items || [];
  if (!name) return { ok: false, error: 'Give the box a name.' };
  if (!items.length) return { ok: false, error: 'A box needs contents.' };

  var made = addProduct_({
    product: name, category: 'Box', content: 'box',
    price: num_(req.price), marketPrice: num_(req.marketPrice),
    notes: str_(req.why) || 'Built from a box idea'
  });
  if (!made.ok) return made;

  var rows = items.map(function (i) {
    return [made.sku, name, str_(i.sku), str_(i.product), num_(i.qty) || 1, ''];
  });
  var sh = sheet_(TABS.BOXES);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.BOXES.length).setValues(rows);
  return { ok: true, sku: made.sku, boxes: buildable_() };
}

/* ======================= STEER PERFORMANCE ======================= */

/**
 * What each steer actually produced. Everything here is derived from the
 * ledger rows carrying that steer's batch, so it stays true as stock moves.
 */
function rebuildSteers_() {
  var sh = sheet_(TABS.STEERS);
  var products = indexProducts_();

  // Any batch that has had meat booked against it gets a performance row on
  // its own, so entering a steer's cuts is the only entry anyone has to make.
  var known = {};
  readTable_(TABS.STEERS).forEach(function (r) { known[str_(r['Steer ID'])] = true; });
  var batches = indexBatches_();
  var seen = {};
  readTable_(TABS.MOVEMENTS).forEach(function (m) {
    if (str_(m['Type']) !== 'INTAKE') return;
    var b = str_(m['Batch']);
    if (b && !known[b]) seen[b] = true;
  });
  Object.keys(seen).forEach(function (b) {
    var meta = batches.filter(function (x) { return x.id === b; })[0] || {};
    sh.appendRow([b, meta.animal || '', meta.outfit || 'PCW', meta.butcher || '',
                  meta.killDate || '', meta.packDate || '', meta.grade || '',
                  '', '', '', '', '', '', '', '', '', '', '', '', '',
                  'Row added automatically when stock was first booked to this batch.']);
    known[b] = true;
  });

  var lastRow = sh.getLastRow();
  if (lastRow < 2) return;
  var moves = readTable_(TABS.MOVEMENTS);
  var cut = {}, sold = {}, left = {}, weight = {}, revenue = {}, potential = {};

  moves.forEach(function (m) {
    var b = str_(m['Batch']);
    if (!b) return;
    var pkgs = num_(m['Packages']);
    var type = str_(m['Type']);
    if (type === 'INTAKE') {
      cut[b] = (cut[b] || 0) + pkgs;
      weight[b] = (weight[b] || 0) + num_(m['Weight (lb)']);
    } else if (type === 'WEIGH') {
      weight[b] = (weight[b] || 0) + num_(m['Weight (lb)']);
    } else if (type === 'SALE') {
      sold[b] = (sold[b] || 0) - pkgs;
      var p = products[str_(m['SKU'])] || {};
      var each = num_(p.price) || (num_(p.pricePerLb) * (pkgs ? Math.abs(num_(m['Weight (lb)']) / pkgs) : 0));
      revenue[b] = (revenue[b] || 0) + each * Math.abs(pkgs);
    }
  });

  currentStock_().forEach(function (l) {
    if (!l.batch) return;
    left[l.batch] = (left[l.batch] || 0) + l.packages;
    var p = products[l.sku] || {};
    var each = num_(p.price) || (l.packages ? num_(p.pricePerLb) * (l.weight / l.packages) : 0);
    potential[l.batch] = (potential[l.batch] || 0) + each * l.packages;
  });

  var head = sh.getRange(1, 1, 1, HEADERS.STEERS.length).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var col = function (n) { return head.indexOf(n); };
  var rng = sh.getRange(2, 1, lastRow - 1, HEADERS.STEERS.length);
  var rows = rng.getValues();

  rows.forEach(function (r) {
    var id = str_(r[col('Steer ID')]);
    if (!id) return;
    var total = num_(r[col('Purchase cost')]) + num_(r[col('Butcher cost')]) + num_(r[col('Other cost')]);
    var saleable = Math.round((weight[id] || 0) * 100) / 100;
    var hanging = num_(r[col('Hanging weight (lb)')]);
    r[col('Total cost')] = total || '';
    r[col('Packages cut')] = cut[id] || '';
    r[col('Saleable weight (lb)')] = saleable || '';
    r[col('Yield %')] = hanging && saleable ? Math.round((saleable / hanging) * 1000) / 10 : '';
    r[col('Cost / saleable lb')] = total && saleable ? Math.round((total / saleable) * 100) / 100 : '';
    var got = Math.round(((revenue[id] || 0) + (potential[id] || 0)) * 100) / 100;
    r[col('Potential revenue')] = got || '';
    r[col('Sold so far')] = Math.round((revenue[id] || 0) * 100) / 100 || '';
    r[col('Still in the freezer')] = Math.round((potential[id] || 0) * 100) / 100 || '';

    // What the yield model says this rail should have produced.
    var model = hanging ? modelFor_(hanging) : null;
    r[col('Model saleable lb')] = model ? model.lb : '';
    r[col('Model revenue')] = model ? model.revenue : '';
    r[col('Variance vs model')] = model && got ? Math.round((got - model.revenue) * 100) / 100 : '';
  });
  rng.setValues(rows);
}

/**
 * What a rail of a given weight should yield, from the CUT YIELD MODEL tab.
 * The model is held per 100 lb of rail weight so it scales to any animal.
 */
function yieldModel_() {
  return readTable_(TABS.YIELD).map(function (r) {
    return {
      cut: str_(r['Cut']), sku: str_(r['SKU']), category: str_(r['Category']),
      lbPer100: num_(r['lb per 100 lb rail']), pkgPer100: num_(r['Packages per 100 lb rail']),
      perLb: num_(r['$ / lb']), grade: str_(r['Grade']),
      use: yes_(r['Use?'])
    };
  }).filter(function (r) { return r.cut && r.use; });
}

/** Scales the model to one rail weight. */
function modelFor_(railWeight) {
  var f = num_(railWeight) / 100;
  if (!f) return { lb: 0, revenue: 0, cuts: [] };
  var cuts = yieldModel_().map(function (c) {
    return {
      cut: c.cut, sku: c.sku, category: c.category,
      lb: Math.round(c.lbPer100 * f * 10) / 10,
      packages: Math.round(c.pkgPer100 * f),
      revenue: Math.round(c.lbPer100 * f * c.perLb * 100) / 100
    };
  });
  return {
    lb: Math.round(cuts.reduce(function (s, c) { return s + c.lb; }, 0) * 10) / 10,
    revenue: Math.round(cuts.reduce(function (s, c) { return s + c.revenue; }, 0) * 100) / 100,
    cuts: cuts
  };
}

/** Cost per saleable pound for every steer, so the app can show a floor offline. */
function steerCosts_() {
  var out = {};
  readTable_(TABS.STEERS).forEach(function (r) {
    var id = str_(r['Steer ID']);
    var c = num_(r['Cost / saleable lb']);
    if (id && c) out[id] = c;
  });
  return out;
}

/** Cost per saleable pound for one batch — the floor under a quote. */
function steerCost_(batch) {
  var rows = readTable_(TABS.STEERS);
  for (var i = 0; i < rows.length; i++) {
    if (str_(rows[i]['Steer ID']) === batch) return num_(rows[i]['Cost / saleable lb']);
  }
  return 0;
}

/* ============================ CUSTOMERS ============================ */

/** Folds every order into the CUSTOMERS tab. Matched on email, else name. */
function rebuildCustomers_() {
  var orders = readOrders_();
  var products = indexProducts_();
  var existing = readTable_(TABS.CUSTOMERS);
  var byKey = {};
  var rows = existing.map(function (r) {
    var k = (str_(r['Email']) || str_(r['Customer'])).toLowerCase();
    byKey[k] = r;
    return r;
  });

  // Counts come from the orders every time, so a rebuild can't inflate them.
  rows.forEach(function (c) { c['Orders'] = 0; c['Packages'] = 0; c['Spend'] = 0; });

  orders.forEach(function (o) {
    if (o.status === 'Cancelled') return;
    var k = (o.contact.indexOf('@') > -1 ? o.contact : o.customer).toLowerCase();
    var c = byKey[k];
    if (!c) {
      c = { 'Customer': o.customer,
            'Email': o.contact.indexOf('@') > -1 ? o.contact : '',
            'Phone': o.contact.indexOf('@') > -1 ? '' : o.contact,
            'Town': '', 'First order': o.deliveryDate, 'Last order': '', 'Orders': 0,
            'Orders before the app': '', 'Packages': 0, 'Spend': 0,
            'Spend before the app': '',
            'Source': o.id.indexOf('WEB') > -1 ? 'Website' : 'Direct',
            'In Google Contacts': '', 'Bought before': '', 'Notes': '' };
      byKey[k] = c;
      rows.push(c);
    }
    c['Orders'] = num_(c['Orders']) + 1;
    o.items.forEach(function (i) {
      c['Packages'] = num_(c['Packages']) + i.packages;
      var p = products[i.sku] || {};
      c['Spend'] = Math.round((num_(c['Spend']) + (num_(p.price) || 0) * i.packages) * 100) / 100;
    });
    if (!c['First order'] || String(o.deliveryDate) < String(c['First order'])) c['First order'] = o.deliveryDate;
    if (!c['Last order'] || String(o.deliveryDate) > String(c['Last order'])) c['Last order'] = o.deliveryDate;
  });

  // Counts are rebuilt from scratch each time, so zero them before folding.
  writeTable_(TABS.CUSTOMERS, HEADERS.CUSTOMERS, rows.map(function (c) {
    return HEADERS.CUSTOMERS.map(function (h) { return c[h] === undefined ? '' : c[h]; });
  }));
}

/* ================== THE 2026 SALES SHEET ================== */

/**
 * Reads the two waiting lists and the customer book out of "1. 2026 sales
 * sheet" and folds them into this workbook. Matching is on name, so running it
 * again updates rather than duplicates — edit the sales sheet, run it again.
 */
function importFromSalesSheet_() {
  var id = settings_().SALES_SHEET_ID;
  if (!id) return { ok: false, error: 'Put the sales sheet file ID in SETTINGS ▸ SALES_SHEET_ID first.' };
  var src;
  try { src = SpreadsheetApp.openById(id); }
  catch (e) { return { ok: false, error: 'Could not open that sheet: ' + e.message }; }

  var out = { ok: true, wholesale: 0, waitlist: 0, customers: 0, skipped: [] };
  out.wholesale = importWholesale_(src) + importWholeSteer_(src);
  out.waitlist = importWaitlist_(src);
  out.customers = importCustomers_(src);
  out.history = importHistory_(src);
  foldHistoryIntoCustomers_();
  return out;
}

/** Reads one tab of the source sheet into objects. Blank rows are dropped. */
function readForeign_(src, tabName, headerRow) {
  var sh = src.getSheetByName(tabName);
  if (!sh) return [];
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow <= headerRow) return [];
  var values = sh.getRange(headerRow, 1, lastRow - headerRow + 1, lastCol).getValues();
  var head = values.shift().map(function (h) { return String(h).trim(); });
  return values.map(function (row) {
    var o = {};
    // Two columns can carry the same name — Whole Steer Sales has "Date" in
    // both A and N. The first one is the real one; a later empty twin must not
    // wipe it out.
    head.forEach(function (h, i) {
      if (!h) return;
      if (o.hasOwnProperty(h) && str_(o[h]) !== '') return;
      o[h] = row[i];
    });
    return o;
  }).filter(function (o) {
    return Object.keys(o).some(function (k) { return str_(o[k]) !== ''; });
  });
}

var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
               jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/**
 * Dates in the sales sheet are typed by hand, every which way: "Jan 9/26",
 * "January 15 2026", "Mar 3/2026", "3/16/2026", and sometimes a real date cell.
 * All of them come back as yyyy-MM-dd, or '' if it really cannot be read.
 */
function looseDate_(v) {
  if (v instanceof Date) return dateStr_(v);
  var t = str_(v);
  if (!t) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);

  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var year = function (y) { y = Number(y); return y < 100 ? 2000 + y : y; };

  // "Jan 9/26", "January 15 2026", "February 9/26"
  var m = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*[\/,\s-]\s*(\d{2,4})/);
  if (m) {
    var mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return year(m[3]) + '-' + pad(mo) + '-' + pad(Number(m[2]));
  }
  // "3/16/2026", "2/28/26" — month first, the way they write it
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return year(m[3]) + '-' + pad(Number(m[1])) + '-' + pad(Number(m[2]));

  return t;
}

/**
 * The last number in a string is the one that matters: "295 - Stripe fees =
 * 286.14" is 286.14, "$7/lb x 580 lbs = S4060" is 4060.
 */
function parseAmount_(text) {
  var t = String(text == null ? '' : text).replace(/,/g, '');
  var nums = t.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || !nums.length) return 0;
  return num_(nums[nums.length - 1]);
}

function importWholesale_(src) {
  var rows = readForeign_(src, 'Wholesale Waiting List', 1);
  var sh = sheet_(TABS.WHOLESALE);
  var existing = {};
  readTable_(TABS.WHOLESALE).forEach(function (r) { existing[str_(r['Customer']).toLowerCase()] = true; });
  var added = [];

  rows.forEach(function (r) {
    var name = str_(r['Customer Name']);
    if (!name || existing[name.toLowerCase()]) return;
    var status = str_(r['Order Status']);
    added.push([
      name, str_(r['Cell #']), str_(r['Email']),
      str_(r['Product, Weight and Price']),
      /await/i.test(status) || !status ? 'Waiting' : status,
      str_(r['Priority']) || 'Normal',
      '', parseAmount_(r['Deposit']), '', '', '', '',
      looseDate_(r['Date booked']),
      [str_(r['Notes']), str_(r['Form of Contact'])].filter(String).join(' · ')
    ]);
    existing[name.toLowerCase()] = true;
  });
  if (added.length) sh.getRange(sh.getLastRow() + 1, 1, added.length, HEADERS.WHOLESALE.length).setValues(added);
  return added.length;
}

function importWaitlist_(src) {
  var rows = readForeign_(src, 'Product Waiting List', 1);
  var sh = sheet_(TABS.WAITLIST);
  var existing = {};
  readTable_(TABS.WAITLIST).forEach(function (r) {
    // Keyed on what they actually said, since that is what the source holds.
    existing[(str_(r['Customer']) + '|' + (str_(r['Their words']) || str_(r['Waiting for']))).toLowerCase()] = true;
  });
  var products = indexProducts_();
  var added = [];

  rows.forEach(function (r) {
    var name = str_(r['Customer Name']);
    var wants = str_(r['Product, Weight and Price']);
    if (!name || !wants) return;
    var key = (name + '|' + wants).toLowerCase();
    if (existing[key]) return;

    // If the wording plainly names a product, point at it; otherwise keep the words.
    var matched = '';
    Object.keys(products).forEach(function (sku) {
      var p = products[sku].product.toLowerCase();
      if (!matched && p && wants.toLowerCase().indexOf(p) > -1) matched = sku;
    });

    added.push([
      name, str_(r['Cell #']), str_(r['Email']),
      matched || wants, wants, '', '', 1,
      looseDate_(r['Date booked']),
      str_(r['Order Status']) || 'Waiting',
      ''
    ]);
    existing[key] = true;
  });
  if (added.length) sh.getRange(sh.getLastRow() + 1, 1, added.length, HEADERS.WAITLIST.length).setValues(added);
  return added.length;
}

/** Whole, half and quarter sales — wholesale orders that already went out. */
function importWholeSteer_(src) {
  var rows = readForeign_(src, 'Whole Steer Sales', 1);
  var sh = sheet_(TABS.WHOLESALE);
  var existing = {};
  readTable_(TABS.WHOLESALE).forEach(function (r) {
    existing[(str_(r['Customer']) + '|' + str_(r['Invoice'])).toLowerCase()] = true;
  });
  var added = [];

  rows.forEach(function (r) {
    var name = str_(r["Customer's name"]);
    if (!name) return;
    var invoice = str_(r['Final invoice']) || str_(r['Deposit invoice']);
    if (existing[(name + '|' + invoice).toLowerCase()]) return;
    var paid = String(r['Paid']).toLowerCase() === 'true';
    added.push([
      name, str_(r['Phone']), str_(r['Email']),
      str_(r['Purchased part']) || 'Whole animal',
      paid ? 'Done' : 'Active', 'Normal', '',
      parseAmount_(r['Deposit']),
      parseAmount_(r['Weight']),
      parseAmount_(r['Price (Price per pound - deposit) (Whole $8/lb, Half $9/lb, Quarter $10/lb)']),
      invoice, paid ? 'Yes' : 'No',
      looseDate_(r['Date']),
      [str_(r['Payment']), str_(r['Total owing to Dynastar'])
        ? 'Owing to Dynastar: ' + str_(r['Total owing to Dynastar']) : ''].filter(String).join(' · ')
    ]);
    existing[(name + '|' + invoice).toLowerCase()] = true;
  });
  if (added.length) sh.getRange(sh.getLastRow() + 1, 1, added.length, HEADERS.WHOLESALE.length).setValues(added);
  return added.length;
}

/**
 * Sales, promotions and whole-animal sales, kept as a record only.
 * These all happened before the opening count, so deducting them now would
 * take the same meat out of the freezer twice.
 */
function importHistory_(src) {
  var sh = sheet_(TABS.HISTORY);
  var existing = {};
  readTable_(TABS.HISTORY).forEach(function (r) {
    existing[[dateStr_(r['Date']), str_(r['Customer']), str_(r['What'])].join('|').toLowerCase()] = true;
  });

  var added = [];

  var take = function (tab, kindOf, dateCol, whoCol, whatCol, amountCol, byCol, payCol, noteCol) {
    readForeign_(src, tab, 1).forEach(function (r) {
      var who = str_(r[whoCol]);
      var what = str_(r[whatCol]);
      if (!who && !what) return;
      var date = looseDate_(r[dateCol]);
      var key = [date, who, what].join('|').toLowerCase();
      if (existing[key]) return;
      var kind = kindOf(r);
      added.push([date, who, str_(r[byCol]), what, parseAmount_(r[amountCol]), kind,
                  str_(r[payCol]), 'No — before the opening count', str_(r[noteCol])]);
      existing[key] = true;
    });
  };

  take('Sales', function () { return 'Sale'; },
       'Date of sale', 'Customer', 'Type of cuts/order (weights)', 'Total price',
       'Salesman', 'Payment type', 'Comments');

  take('Promotions', function (r) {
    // "Other" is the photoshoot meat — still meat we gave away, not revenue.
    return /quality/i.test(str_(r['Payment type'])) ? 'Quality control' : 'Promotion';
  }, 'Date of sale', 'Customer', 'Type of cuts/order (weights)', 'Total price',
     'Salesman', 'Payment type', 'Comments');

  take('Whole Steer Sales', function () { return 'Whole animal'; },
       'Date', "Customer's name", 'Purchased part',
       'Price (Price per pound - deposit) (Whole $8/lb, Half $9/lb, Quarter $10/lb)',
       'Payment', 'Payment', 'Final invoice');

  if (added.length) sh.getRange(sh.getLastRow() + 1, 1, added.length, HEADERS.HISTORY.length).setValues(added);
  return added.length;
}

function importCustomers_(src) {
  // That tab has a merged banner above the real header.
  var rows = readForeign_(src, "Customers' info", 2);
  var sh = sheet_(TABS.CUSTOMERS);
  var byName = {};
  var existing = readTable_(TABS.CUSTOMERS);
  existing.forEach(function (r) { byName[str_(r['Customer']).toLowerCase()] = r; });
  var added = [];

  rows.forEach(function (r) {
    var name = str_(r['Customer']);
    if (!name || name.toLowerCase() === 'customer') return;
    if (byName[name.toLowerCase()]) return;
    added.push([
      name, str_(r['email address']), str_(r['Phone number']), str_(r['address/location']),
      '', '', 0, num_(r['# of order']), 0, 0, 0,
      str_(r['Sales person']) || 'Before the app', '',
      str_(r['Purchase history']), ''
    ]);
    byName[name.toLowerCase()] = true;
  });
  if (added.length) sh.getRange(sh.getLastRow() + 1, 1, added.length, HEADERS.CUSTOMERS.length).setValues(added);
  return added.length;
}

/** What each customer spent before the app existed, from SALES HISTORY. */
function foldHistoryIntoCustomers_() {
  var spend = {}, last = {};
  readTable_(TABS.HISTORY).forEach(function (r) {
    var who = str_(r['Customer']).toLowerCase();
    if (!who) return;
    if (str_(r['Kind']) === 'Sale' || str_(r['Kind']) === 'Whole animal') {
      spend[who] = (spend[who] || 0) + num_(r['Amount']);
    }
    var d = dateStr_(r['Date']);
    if (d && (!last[who] || d > last[who])) last[who] = d;
  });

  var sh = sheet_(TABS.CUSTOMERS);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return;
  var head = sh.getRange(1, 1, 1, HEADERS.CUSTOMERS.length).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var iName = head.indexOf('Customer');
  var iSpend = head.indexOf('Spend before the app');
  var iLast = head.indexOf('Last order');
  var rng = sh.getRange(2, 1, lastRow - 1, HEADERS.CUSTOMERS.length);
  var rows = rng.getValues();
  rows.forEach(function (r) {
    var who = str_(r[iName]).toLowerCase();
    if (!who) return;
    if (spend[who]) r[iSpend] = Math.round(spend[who] * 100) / 100;
    if (last[who] && !str_(r[iLast])) r[iLast] = last[who];
  });
  rng.setValues(rows);
}


/* ========================= REORDER FOLLOW-UPS =========================
 * A bulk buyer's freezer empties on a fairly predictable clock, so the app
 * should say who is likely running low before they think to call.
 *
 * Two things feed this tab and they do different jobs:
 *   - This script does the arithmetic. It reads the whole, half and quarter
 *     sales and works out when each freezer is probably low. That runs every
 *     rebuild, so the list is never stale or empty.
 *   - The weekly reorder radar does the judgement: whose own stated timing
 *     overrides the clock, what to say to them, and anything odd worth
 *     flagging. It drops a file in Drive and this script folds it in.
 * Nothing is ever sent without somebody tapping Send.
 */

/** Months from the purchase to the day the freezer is likely getting low. */
function shareClock_(share, weight, st) {
  var s = String(share || '').toLowerCase();
  var inferred = '';
  if (!s) {
    // No part written down, so read it off the rail weight and say we guessed.
    var w = num_(weight);
    if (!w) return null;
    s = w > 1000 ? 'whole' : (w >= 480 ? 'half' : 'quarter');
    inferred = 'Share size guessed from ' + w + ' lb';
  }
  var months = /whole/.test(s) ? (num_(st.WHOLE_MONTHS) || 10)
             : /half/.test(s) ? (num_(st.HALF_MONTHS) || 6)
             : (num_(st.QUARTER_MONTHS) || 3);
  var label = /whole/.test(s) ? 'Whole' : (/half/.test(s) ? 'Half' : 'Quarter');
  return { months: months, share: label, inferred: inferred };
}

/** "true", true, "yes", 1 all mean yes; anything else does not. */
function yes_(v) {
  return v === true || /^(true|yes|1)$/i.test(String(v == null ? '' : v));
}

function addMonths_(iso, months) {
  var parts = String(iso).slice(0, 10).split('-');
  if (parts.length !== 3) return '';
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (isNaN(d.getTime())) return '';
  var day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) d.setDate(0);          // Jan 31 + 1 month = Feb 28
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function daysBetween_(fromIso, toIso) {
  var a = new Date(String(fromIso).slice(0, 10) + 'T12:00:00');
  var b = new Date(String(toIso).slice(0, 10) + 'T12:00:00');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  return Math.round((b - a) / 86400000);
}

function today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/**
 * Rebuilds the FOLLOW-UPS tab from the whole-animal sales, keeping everything
 * a person or the radar put there: the draft, the flags, when to hold off and
 * who has already been contacted.
 */
function rebuildFollowups_() {
  var st = settings_();
  var window = num_(st.FOLLOWUP_WINDOW) || 30;
  var now = today_();

  // What is already on the tab, so nothing typed by hand is lost.
  var kept = {};
  readTable_(TABS.FOLLOWUPS).forEach(function (r) {
    var key = (str_(r['Customer']) + '|' + dateStr_(r['Bought on'])).toLowerCase();
    kept[key] = r;
  });

  var rows = [];
  var seen = {};
  var consider = function (customer, email, phone, bought, share, weight, boughtOn, source) {
    if (!customer || !boughtOn) return;
    var clock = shareClock_(share, weight, st);
    if (!clock) return;
    var key = (customer + '|' + boughtOn).toLowerCase();
    if (seen[key]) return;
    seen[key] = true;

    var prev = kept[key] || {};
    var due = addMonths_(boughtOn, clock.months);
    if (!due) return;

    var hold = dateStr_(prev['Hold until']);
    var contacted = dateStr_(prev['Last contacted']);
    var flags = [];
    if (clock.inferred) flags.push(clock.inferred);
    if (str_(prev['Flags'])) {
      // Keep the radar's own flags, minus a stale copy of ours.
      str_(prev['Flags']).split(' · ').forEach(function (f) {
        if (f && flags.indexOf(f) === -1 && f.indexOf('Share size guessed') !== 0) flags.push(f);
      });
    }

    var status;
    if (contacted && contacted >= due) status = 'Done';
    else if (hold && hold > now) status = 'Held';
    else if (now < due) status = 'Upcoming';
    else if (daysBetween_(due, now) <= window) status = 'Due now';
    else status = 'Overdue';

    rows.push([
      customer, email || str_(prev['Email']), phone || str_(prev['Phone']),
      bought, clock.share, boughtOn, due, status, flags.join(' · '),
      str_(prev['Subject']), str_(prev['Draft']), str_(prev['Written by']),
      hold, contacted, str_(prev['Contacted by']),
      [str_(prev['Notes']), source].filter(String).join(' · ').slice(0, 500),
      now
    ]);
  };

  // The wholesale tab is the live record of who bought an animal.
  readTable_(TABS.WHOLESALE).forEach(function (r) {
    // Somebody still on the waiting list has not taken an animal yet, so the
    // date on their row is when they asked, not when their freezer filled.
    if (str_(r['Status']) === 'Waiting') return;
    consider(str_(r['Customer']), str_(r['Email']), str_(r['Phone']),
             str_(r['Wants']), str_(r['Wants']), num_(r['Weight (lb)']),
             dateStr_(r['Added']), 'From the wholesale list');
  });
  // Anything sold before the app only exists on the history tab.
  readTable_(TABS.HISTORY).forEach(function (r) {
    if (str_(r['Kind']) !== 'Whole animal') return;
    consider(str_(r['Customer']), '', '', str_(r['What']), str_(r['What']), 0,
             dateStr_(r['Date']), 'From the sales history');
  });

  // Rows the radar added for somebody with no animal on file stay put.
  Object.keys(kept).forEach(function (key) {
    if (seen[key]) return;
    var r = kept[key];
    if (!str_(r['Subject']) && !str_(r['Draft']) && !str_(r['Hold until'])) return;
    rows.push(HEADERS.FOLLOWUPS.map(function (h) {
      return h === 'Updated' ? now : (r[h] === undefined ? '' : r[h]);
    }));
  });

  // Soonest first, and anything already dealt with at the bottom.
  var rank = { 'Overdue': 0, 'Due now': 1, 'Upcoming': 2, 'Held': 3, 'Done': 4 };
  rows.sort(function (a, b) {
    return (rank[a[7]] === undefined ? 9 : rank[a[7]]) - (rank[b[7]] === undefined ? 9 : rank[b[7]])
        || String(a[6]).localeCompare(String(b[6]));
  });

  writeTable_(TABS.FOLLOWUPS, HEADERS.FOLLOWUPS, rows);
  return rows.length;
}

function followups_() {
  var now = today_();
  return readTable_(TABS.FOLLOWUPS).map(function (r) {
    var due = dateStr_(r['Due on']);
    return {
      customer: str_(r['Customer']), email: str_(r['Email']), phone: str_(r['Phone']),
      bought: str_(r['Bought']), share: str_(r['Share']),
      boughtOn: dateStr_(r['Bought on']), due: due,
      status: str_(r['Status']) || 'Upcoming',
      days: due ? daysBetween_(due, now) : 0,
      flags: str_(r['Flags']), subject: str_(r['Subject']), draft: str_(r['Draft']),
      writtenBy: str_(r['Written by']), holdUntil: dateStr_(r['Hold until']),
      lastContacted: dateStr_(r['Last contacted']), contactedBy: str_(r['Contacted by']),
      notes: str_(r['Notes'])
    };
  }).filter(function (r) { return r.customer; });
}


/**
 * What we know about one person, gathered from everywhere it is written down.
 * This is what makes a draft sound like it came from somebody who knows them.
 */
function customerStory_(name) {
  var key = String(name || '').toLowerCase();
  var story = { name: str_(name), email: '', phone: '', shares: [], bought: [],
                waiting: [], spend: 0, lastOrder: '' };

  readTable_(TABS.CUSTOMERS).forEach(function (r) {
    if (str_(r['Customer']).toLowerCase() !== key) return;
    story.email = story.email || str_(r['Email']);
    story.phone = story.phone || str_(r['Phone']);
    story.spend += num_(r['Spend']) + num_(r['Spend before the app']);
    story.lastOrder = dateStr_(r['Last order']) || story.lastOrder;
    str_(r['Bought before']).split(',').forEach(function (b) {
      b = b.trim();
      if (b && story.bought.indexOf(b) === -1) story.bought.push(b);
    });
  });

  readTable_(TABS.WHOLESALE).forEach(function (r) {
    if (str_(r['Customer']).toLowerCase() !== key) return;
    story.email = story.email || str_(r['Email']);
    story.phone = story.phone || str_(r['Phone']);
    if (str_(r['Status']) === 'Waiting') {
      if (str_(r['Wants'])) story.waiting.push(str_(r['Wants']));
    } else if (dateStr_(r['Added'])) {
      story.shares.push({ what: str_(r['Wants']), on: dateStr_(r['Added']),
                          weight: num_(r['Weight (lb)']) });
    }
  });

  readTable_(TABS.WAITLIST).forEach(function (r) {
    if (str_(r['Customer']).toLowerCase() !== key) return;
    story.email = story.email || str_(r['Email']);
    story.phone = story.phone || str_(r['Phone']);
    var w = str_(r['Their words']) || str_(r['Waiting for']);
    if (w && story.waiting.indexOf(w) === -1) story.waiting.push(w);
  });

  readTable_(TABS.HISTORY).forEach(function (r) {
    if (str_(r['Customer']).toLowerCase() !== key) return;
    var kind = str_(r['Kind']);
    if (kind !== 'Sale' && kind !== 'Whole animal') return;
    var what = str_(r['What']);
    if (what && story.bought.indexOf(what) === -1) story.bought.push(what);
    var d = dateStr_(r['Date']);
    if (d && d > story.lastOrder) story.lastOrder = d;
  });

  readTable_(TABS.ORDERS).forEach(function (r) {
    if (str_(r['Customer']).toLowerCase() !== key) return;
    story.email = story.email || str_(r['Contact']);
    var d = dateStr_(r['Delivery date']);
    if (d && d > story.lastOrder) story.lastOrder = d;
  });

  return story;
}

/** "about seven months ago", in words, because nobody wants "213 days". */
function howLong_(iso) {
  if (!iso) return '';
  var days = daysBetween_(iso, today_());
  if (days < 45) return 'a few weeks ago';
  var months = Math.round(days / 30.44);
  if (months < 12) return 'about ' + months + ' months ago';
  var years = Math.round(months / 12);
  if (years === 1 && months < 18) return 'about a year ago';
  return 'about ' + years + ' years ago';
}

function listWords_(items) {
  var a = (items || []).filter(String).slice(0, 3);
  if (!a.length) return '';
  if (a.length === 1) return a[0];
  if (a.length === 2) return a[0] + ' and ' + a[1];
  return a[0] + ', ' + a[1] + ' and ' + a[2];
}

/**
 * The draft the app shows. If the radar already wrote one it wins, because it
 * had the whole picture in front of it. Otherwise this composes one from what
 * the person actually bought, which is a decent starting point to edit.
 *
 * House style, same as the radar: no dashes used as punctuation.
 */
function draftFollowup_(req) {
  var name = str_(req.customer);
  if (!name) return { ok: false, error: 'Which customer?' };
  var rows = followups_();
  var row = null;
  rows.forEach(function (r) {
    if (r.customer.toLowerCase() !== name.toLowerCase()) return;
    if (!row || (str_(req.boughtOn) && r.boughtOn === str_(req.boughtOn))) row = r;
  });

  var story = customerStory_(name);
  if (row && row.draft && !yes_(req.rewrite)) {
    return { ok: true, customer: name, to: row.email || story.email,
             subject: row.subject || 'Checking in from Peace Country Wagyu',
             body: row.draft, writtenBy: row.writtenBy || 'The weekly radar',
             story: story, row: row };
  }

  var st = settings_();
  var signer = st.FOLLOWUP_FROM || 'Paul';
  var first = story.name.split(/\s|&/)[0];
  var share = row ? row.share : '';
  var when = howLong_(row ? row.boughtOn : story.lastOrder);

  var lines = ['Hi ' + first + ','];
  if (share && when) {
    lines.push('You took ' + (share === 'Whole' ? 'a whole animal' :
      (share === 'Half' ? 'a half' : 'a quarter')) + ' from us ' + when +
      ', so I am guessing the freezer is getting light.');
  } else if (when) {
    lines.push('It has been ' + when + ' since your last order, so I thought I would check in.');
  } else {
    lines.push('I thought I would check in and see how you are doing for beef.');
  }
  if (story.bought.length) {
    lines.push('Last time you went with ' + listWords_(story.bought) +
               '. Happy to put the same together again, or something different if you would rather.');
  }
  if (story.waiting.length) {
    lines.push('I also have you down for ' + listWords_(story.waiting) +
               ', so say the word if you still want that.');
  }
  lines.push('We have animals coming through over the next while. Want me to put you on the list for the next one?');
  lines.push('Let me know what suits and I will get it sorted.');
  lines.push('');
  lines.push('Thanks,');
  lines.push(signer);
  lines.push('Peace Country Wagyu');

  var body = lines.join('\n\n').replace(/—|–/g, ',');
  var subject = share
    ? 'Time for another ' + share.toLowerCase() + '?'
    : 'Checking in from Peace Country Wagyu';

  return { ok: true, customer: name, to: row ? (row.email || story.email) : story.email,
           subject: subject, body: body, writtenBy: 'Composed by the app',
           story: story, row: row };
}

/** Finds a follow-up row by customer, and by purchase date when given. */
function followupRow_(customer, boughtOn) {
  var sh = sheet_(TABS.FOLLOWUPS);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return -1;
  var head = HEADERS.FOLLOWUPS;
  var vals = sh.getRange(2, 1, lastRow - 1, head.length).getValues();
  var iName = head.indexOf('Customer'), iOn = head.indexOf('Bought on');
  var fallback = -1;
  for (var i = 0; i < vals.length; i++) {
    if (str_(vals[i][iName]).toLowerCase() !== String(customer).toLowerCase()) continue;
    if (boughtOn && dateStr_(vals[i][iOn]) === boughtOn) return i + 2;
    if (fallback === -1) fallback = i + 2;
  }
  return fallback;
}

function setFollowupCells_(rowIndex, patch) {
  if (rowIndex < 2) return;
  var sh = sheet_(TABS.FOLLOWUPS);
  var head = HEADERS.FOLLOWUPS;
  var rng = sh.getRange(rowIndex, 1, 1, head.length);
  var row = rng.getValues()[0];
  Object.keys(patch).forEach(function (k) {
    var i = head.indexOf(k);
    if (i > -1) row[i] = patch[k];
  });
  rng.setValues([row]);
}

/**
 * Sends one follow-up through the company Gmail, as the account that owns the
 * script. A person has to tap Send for this to run; nothing here is automatic.
 */
function sendFollowup_(req) {
  var to = str_(req.to);
  var name = str_(req.customer);
  if (!to || to.indexOf('@') === -1) {
    return { ok: false, error: 'No email address for ' + (name || 'that customer') + '.' };
  }
  var subject = str_(req.subject) || 'Checking in from Peace Country Wagyu';
  var body = str_(req.body);
  if (!body) return { ok: false, error: 'Nothing to send — the draft is empty.' };

  // The phone may replay a queued send, so the same tap must not send twice.
  var clientKey = str_(req.clientKey);
  var props = PropertiesService.getScriptProperties();
  if (clientKey) {
    if (props.getProperty('SENT_' + clientKey)) {
      return { ok: true, already: true, to: to, followups: followups_() };
    }
  }

  var st = settings_();
  var opts = { name: st.FOLLOWUP_FROM || st.BUSINESS || 'Peace Country Wagyu' };
  if (st.FOLLOWUP_BCC) opts.bcc = st.FOLLOWUP_BCC;

  var as = sendAs_();
  if (as.address) {
    // Replies go to the sales inbox whether or not Gmail will let us send
    // from it, so nothing lands in a personal inbox by accident.
    opts.replyTo = as.address;
    if (as.usable) opts.from = as.address;
  }
  GmailApp.sendEmail(to, subject, body, opts);
  if (clientKey) props.setProperty('SENT_' + clientKey, today_());

  var rowIndex = followupRow_(name, str_(req.boughtOn));
  if (rowIndex > 1) {
    setFollowupCells_(rowIndex, {
      'Status': 'Done', 'Subject': subject, 'Draft': body,
      'Last contacted': today_(), 'Contacted by': str_(req.user) || 'the app',
      'Email': to, 'Updated': today_()
    });
  }
  return { ok: true, sent: to, from: as.address || as.account,
           warning: as.warning, followups: followups_() };
}

/**
 * Which address follow-ups go out as. Gmail will only send from an address the
 * owning account holds as a "Send mail as" alias, so this checks rather than
 * assuming: if the alias is not there the mail still goes, from the owning
 * account, with replies pointed at the sales inbox and a warning the app shows.
 */
function sendAs_() {
  var st = settings_();
  var want = str_(st.FOLLOWUP_SEND_AS);
  var account = '';
  try { account = Session.getEffectiveUser().getEmail(); } catch (e) {}
  if (!want) return { address: '', usable: false, account: account, warning: '' };
  if (want.toLowerCase() === String(account).toLowerCase()) {
    return { address: want, usable: false, account: account, warning: '' };
  }

  var aliases = [];
  try { aliases = GmailApp.getAliases() || []; } catch (e) {}
  var usable = aliases.some(function (a) {
    return String(a).toLowerCase() === want.toLowerCase();
  });
  return {
    address: want, usable: usable, account: account, aliases: aliases,
    warning: usable ? '' :
      want + ' is not set up as a "Send mail as" address on ' +
      (account || 'this account') + ', so the email goes out from ' +
      (account || 'the script account') + ' with replies pointed at ' + want +
      '. Add it in Gmail ▸ Settings ▸ Accounts ▸ Send mail as to fix that.'
  };
}

/** Not now: hold somebody off for a while, or just record that you called. */
function markFollowup_(req) {
  var name = str_(req.customer);
  var rowIndex = followupRow_(name, str_(req.boughtOn));
  if (rowIndex < 2) return { ok: false, error: 'No follow-up on file for ' + name + '.' };
  var what = str_(req.what).toLowerCase();

  if (what === 'snooze') {
    var days = num_(req.days) || 30;
    var until = Utilities.formatDate(new Date(Date.now() + days * 86400000),
                                     Session.getScriptTimeZone(), 'yyyy-MM-dd');
    setFollowupCells_(rowIndex, { 'Status': 'Held', 'Hold until': until, 'Updated': today_(),
                                  'Notes': str_(req.note) });
  } else if (what === 'contacted') {
    setFollowupCells_(rowIndex, { 'Status': 'Done', 'Last contacted': today_(),
                                  'Contacted by': str_(req.user) || 'the app',
                                  'Updated': today_(), 'Notes': str_(req.note) });
  } else if (what === 'reopen') {
    setFollowupCells_(rowIndex, { 'Status': 'Due now', 'Hold until': '', 'Last contacted': '',
                                  'Updated': today_() });
  } else {
    return { ok: false, error: 'Unknown: ' + what };
  }
  return { ok: true, followups: followups_() };
}


/**
 * The weekly reorder radar drops a small JSON file in Drive. This picks it up,
 * folds its drafts and flags into FOLLOW-UPS, and renames the file so the same
 * week never lands twice. Shape:
 *
 *   { "generated": "2026-10-05",
 *     "people": [ { "customer": "...", "email": "...", "boughtOn": "2026-02-28",
 *                   "status": "Overdue", "flags": "two addresses on file",
 *                   "holdUntil": "2027-01-15", "subject": "...", "body": "..." } ] }
 *
 * Only the judgement columns are taken. Dates and share sizes stay this
 * script's business, so the two can never disagree about the arithmetic.
 */
function pullRadar_() {
  var st = settings_();
  var wanted = st.RADAR_FILE || 'pcw-followups.json';
  var files = DriveApp.getFilesByName(wanted);
  if (!files.hasNext()) return { ok: true, applied: 0, note: 'No ' + wanted + ' waiting in Drive.' };

  var file = files.next();
  var payload;
  try { payload = JSON.parse(file.getBlob().getDataAsString()); }
  catch (e) { return { ok: false, error: 'Could not read ' + wanted + ': ' + e.message }; }

  var people = (payload && payload.people) || [];
  var applied = 0, added = 0;
  var sh = sheet_(TABS.FOLLOWUPS);

  people.forEach(function (p) {
    var name = str_(p.customer);
    if (!name) return;
    var on = str_(p.boughtOn).slice(0, 10);
    var rowIndex = followupRow_(name, on);
    var patch = { 'Written by': 'The weekly radar', 'Updated': today_() };
    if (str_(p.subject)) patch['Subject'] = str_(p.subject);
    if (str_(p.body)) patch['Draft'] = str_(p.body);
    if (str_(p.flags)) patch['Flags'] = str_(p.flags);
    if (str_(p.holdUntil)) { patch['Hold until'] = str_(p.holdUntil).slice(0, 10); }
    if (str_(p.email)) patch['Email'] = str_(p.email);
    if (str_(p.phone)) patch['Phone'] = str_(p.phone);

    if (rowIndex > 1) {
      setFollowupCells_(rowIndex, patch);
      applied++;
    } else {
      // Somebody the arithmetic does not know about. Keep them anyway.
      var row = HEADERS.FOLLOWUPS.map(function (h) {
        if (patch.hasOwnProperty(h)) return patch[h];
        if (h === 'Customer') return name;
        if (h === 'Bought on') return on;
        if (h === 'Status') return str_(p.status) || 'Due now';
        if (h === 'Share') return str_(p.share);
        if (h === 'Bought') return str_(p.bought);
        if (h === 'Due on') return str_(p.due).slice(0, 10);
        return '';
      });
      sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setValues([row]);
      added++;
    }
  });

  // Out of the way, so it is not applied again next rebuild.
  file.setName(wanted.replace(/\.json$/, '') + ' ' +
               (str_(payload.generated) || today_()) + '.json');
  rebuildFollowups_();
  return { ok: true, applied: applied, added: added,
           generated: str_(payload.generated) || today_() };
}

/* ================= WEBSITE ORDERS (SQUARESPACE) ================= */

/**
 * Reads the order emails Squarespace sends to admin@pcwagyu.com and turns each
 * into an order. Run on a trigger, or from the menu. Anything it cannot read
 * cleanly still becomes an order, flagged in the notes for a human to finish.
 */
function sweepWebsiteOrders_() {
  var st = settings_();
  var from = st.ORDER_EMAIL_FROM || 'squarespace.com';
  var threads = GmailApp.search('from:' + from + ' newer_than:14d -label:pcw-filed', 0, 25);
  var label = GmailApp.getUserLabelByName('pcw-filed') || GmailApp.createLabel('pcw-filed');
  var made = 0;

  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      var parsed = parseOrderEmail_(m.getPlainBody(), m.getSubject());
      if (!parsed) return;
      var res = submit_({ ops: [{
        type: 'ORDER_NEW', orderId: parsed.orderId, customer: parsed.customer,
        contact: parsed.email, deliveryDate: parsed.deliveryDate, method: parsed.method,
        notes: parsed.notes, user: 'Website', lines: parsed.lines,
        clientKey: 'web-' + parsed.orderId
      }]});
      if (res.ok) made++;
    });
    t.addLabel(label);
  });
  if (made) syncCalendar_();
  return made;
}

/** Pulls what it can out of one order email. Matches items by product name. */
function parseOrderEmail_(body, subject) {
  if (!body) return null;
  var num = (subject || '').match(/#\s*(\d+)/) || body.match(/Order\s*#\s*(\d+)/i);
  if (!num) return null;

  var email = (body.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [''])[0];
  var name = (body.match(/(?:Ship to|Bill to|Customer)[:\s]*\n?\s*([A-Z][^\n]{1,60})/i) || [])[1] || '';
  var pickup = /pick\s*-?\s*up|local pickup/i.test(body);

  var products = indexProducts_();
  var byName = {};
  Object.keys(products).forEach(function (k) {
    byName[products[k].product.toLowerCase().replace(/[^a-z0-9]/g, '')] = k;
  });

  var lines = [];
  var unmatched = [];
  // Squarespace lists items as "2 x Dinner for Two" or "Dinner for Two  x2".
  (body.match(/^.*\bx\s*\d+.*$|^\s*\d+\s*x\s+.*$/gim) || []).forEach(function (raw) {
    var qty = Number((raw.match(/(\d+)\s*x/i) || raw.match(/x\s*(\d+)/i) || [])[1] || 0);
    var text = raw.replace(/\d+\s*x|x\s*\d+/i, '').replace(/\$[\d.,]+/g, '').trim();
    var key = text.toLowerCase().replace(/[^a-z0-9]/g, '');
    var sku = byName[key];
    if (!sku) {
      Object.keys(byName).forEach(function (n) {
        if (!sku && n && (key.indexOf(n) > -1 || n.indexOf(key) > -1)) sku = byName[n];
      });
    }
    if (sku && qty > 0) lines.push({ sku: sku, packages: qty });
    else if (text) unmatched.push(raw.trim());
  });

  return {
    orderId: 'WEB-' + num[1],
    customer: str_(name) || email || ('Website order ' + num[1]),
    email: email,
    deliveryDate: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    method: pickup ? 'Pickup' : 'Delivery',
    notes: 'From the website.' + (unmatched.length ? ' COULD NOT MATCH: ' + unmatched.join(' | ') : ''),
    lines: lines
  };
}

/* ========================= GOOGLE CALENDAR ========================= */

/** Puts every open or packed order on the PCW calendar on its delivery day. */
function syncCalendar_() {
  var id = settings_().CALENDAR_ID;
  if (!id) return 0;
  var cal = CalendarApp.getCalendarById(id);
  if (!cal) return 0;
  var made = 0;

  readOrders_().forEach(function (o) {
    if (o.status !== 'Open' && o.status !== 'Packed') return;
    if (!o.deliveryDate) return;
    var day = new Date(o.deliveryDate + 'T12:00:00');
    var title = (o.method || 'Order') + ' — ' + o.customer;
    var existing = cal.getEventsForDay(day).filter(function (e) {
      return e.getTitle().indexOf(o.id) > -1 || e.getDescription().indexOf(o.id) > -1;
    });
    var body = o.id + '\n' + o.items.map(function (i) {
      return i.packages + ' × ' + i.product;
    }).join('\n') + (o.notes ? '\n\n' + o.notes : '');

    if (existing.length) {
      existing[0].setTitle(title);
      existing[0].setDescription(body);
    } else {
      cal.createAllDayEvent(title, day, { description: body });
      made++;
    }
  });
  return made;
}

/* ========================= GOOGLE CONTACTS ========================= */

/**
 * Files customers into Google Contacts under the PCW Customers label.
 * Needs one scope in appsscript.json — see docs/SETUP.md.
 */
function syncContacts_() {
  var st = settings_();
  var labelName = st.CONTACTS_LABEL || 'PCW Customers';
  var token = ScriptApp.getOAuthToken();
  var base = 'https://people.googleapis.com/v1/';
  var opts = { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };

  // Find or make the label (a "contact group" in the API).
  var groups = JSON.parse(UrlFetchApp.fetch(base + 'contactGroups?pageSize=200', opts).getContentText());
  var group = (groups.contactGroups || []).filter(function (g) { return g.name === labelName; })[0];
  if (!group) {
    group = JSON.parse(UrlFetchApp.fetch(base + 'contactGroups', {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ contactGroup: { name: labelName } }), muteHttpExceptions: true
    }).getContentText());
  }

  var sh = sheet_(TABS.CUSTOMERS);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;
  var head = sh.getRange(1, 1, 1, HEADERS.CUSTOMERS.length).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var rng = sh.getRange(2, 1, lastRow - 1, HEADERS.CUSTOMERS.length);
  var rows = rng.getValues();
  var iName = head.indexOf('Customer'), iEmail = head.indexOf('Email');
  var iPhone = head.indexOf('Phone'), iDone = head.indexOf('In Google Contacts');
  var added = 0;

  rows.forEach(function (r) {
    if (str_(r[iDone]) || !str_(r[iName])) return;
    var person = { names: [{ givenName: str_(r[iName]) }] };
    if (str_(r[iEmail])) person.emailAddresses = [{ value: str_(r[iEmail]) }];
    if (str_(r[iPhone])) person.phoneNumbers = [{ value: str_(r[iPhone]) }];
    person.memberships = [{ contactGroupMembership: { contactGroupResourceName: group.resourceName } }];

    var res = UrlFetchApp.fetch(base + 'people:createContact', {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify(person), muteHttpExceptions: true
    });
    if (res.getResponseCode() < 300) { r[iDone] = 'Yes'; added++; }
    else { r[iDone] = 'Failed: ' + res.getResponseCode(); }
  });
  rng.setValues(rows);
  return added;
}

/* ============================== WEB API ============================== */

function doGet(e) { return handle_(e, null); }

function doPost(e) {
  var body = null;
  try {
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Body was not valid JSON' });
  }
  return handle_(e, body);
}

function handle_(e, body) {
  try {
    var params = (e && e.parameter) || {};
    var req = body || params;
    var token = str_(req.token || params.token);
    var expected = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
    if (!expected) return json_({ ok: false, error: 'Backend not set up — run setup().' });
    if (token !== expected) return json_({ ok: false, error: 'Bad or missing token' });

    var action = str_(req.action) || 'bootstrap';
    switch (action) {
      case 'ping':        return json_({ ok: true, serverTime: new Date().toISOString() });
      case 'bootstrap':   return json_(bootstrap_());
      case 'submit':      return json_(submit_(req));
      case 'addProduct':  return json_(addProduct_(req.product || {}));
      case 'addBatch':    return json_(addBatch_(req.batch || {}));
      case 'addFreezer':  return json_(addFreezer_(req.freezer || {}));
      case 'history':     return json_(history_(num_(req.limit) || 50));
      case 'scan':        return json_(saveScan_(req));
      case 'scans':       return json_(listScans_(req.status));
      case 'fileScan':    return json_(fileScan_(req));
      case 'ageing':      return json_({ ok: true, lots: ageing_() });
      case 'boxes':       return json_({ ok: true, boxes: buildable_() });
      case 'boxIdeas':    return json_({ ok: true, ideas: suggestBoxes_(req) });
      case 'saveBoxIdea': return json_(saveBoxIdea_(req));
      case 'quote':       return json_(quote_(req));
      case 'lists':       return json_(lists_());
      case 'addToList':   return json_(addToList_(req));
      case 'addSteer':    return json_(addSteer_(req));
      case 'model':       return json_({ ok: true, model: modelFor_(num_(req.railWeight)) });
      case 'sweepWeb':    return json_({ ok: true, made: sweepWebsiteOrders_() });
      case 'importSales': return json_(importFromSalesSheet_());
      case 'followups':   return json_({ ok: true, followups: followups_() });
      case 'sendAs':      return json_(Object.assign({ ok: true }, sendAs_()));
      case 'draft':       return json_(draftFollowup_(req));
      case 'sendFollowup':return json_(sendFollowup_(req));
      case 'markFollowup':return json_(markFollowup_(req));
      case 'pullRadar':   return json_(pullRadar_());
      default:            return json_({ ok: false, error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function bootstrap_() {
  rebuildInventory();
  var products = indexProducts_();
  return {
    ok: true,
    serverTime: new Date().toISOString(),
    settings: settings_(),
    products: Object.keys(products).map(function (k) { return products[k]; }),
    batches: indexBatches_(),
    freezers: indexFreezers_(),
    stock: currentStock_(),
    orders: readOrders_(),
    committed: committedBySku_(),
    scansPending: listScans_('Pending').scans.length,
    ageing: ageing_(),
    boxes: buildable_(),
    lists: lists_(),
    followups: followups_(),
    sendAs: sendAs_(),
    steerCosts: steerCosts_()
  };
}

function history_(limit) {
  var moves = readTable_(TABS.MOVEMENTS);
  var recent = moves.slice(Math.max(0, moves.length - limit)).reverse().map(function (m) {
    return {
      id: str_(m['Move ID']),
      ts: m['Timestamp'] instanceof Date ? m['Timestamp'].toISOString() : str_(m['Timestamp']),
      type: str_(m['Type']),
      sku: str_(m['SKU']),
      product: str_(m['Product']),
      size: str_(m['Size']),
      grade: str_(m['Grade']),
      batch: str_(m['Batch']),
      freezer: str_(m['Freezer']),
      packages: num_(m['Packages']),
      weight: num_(m['Weight (lb)']),
      party: str_(m['Party / reason']),
      user: str_(m['User']),
      note: str_(m['Note'])
    };
  });
  return { ok: true, moves: recent };
}

/* ========================== WRITING MOVEMENTS ========================== */

/**
 * Accepts a batch of operations from the app (including a replayed offline
 * queue) and appends the resulting ledger rows.
 *
 * Each op: {
 *   clientKey, type: INTAKE|SALE|ADJUST|TRANSFER|COUNT,
 *   sku, grade, batch, freezer, toFreezer, packages, weight,
 *   party, note, user, timestamp
 * }
 */
function submit_(req) {
  var ops = req.ops || req.moves || [];
  if (!ops.length) return { ok: true, accepted: [], warnings: [] };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = sheet_(TABS.MOVEMENTS);
    var products = indexProducts_();
    var stock = currentStock_();
    var settings = settings_();
    var allowNegative = (settings.ALLOW_NEGATIVE || 'WARN').toUpperCase() !== 'BLOCK';

    // Existing client keys for idempotent replay of the offline queue.
    var seen = {};
    var lastRow = sh.getLastRow();
    if (lastRow > 1) {
      sh.getRange(2, 16, lastRow - 1, 1).getValues().forEach(function (r) {
        var k = str_(r[0]);
        if (k) seen[k] = true;
      });
    }

    var rows = [];
    var accepted = [];
    var warnings = [];
    var counter = 0;

    ops.forEach(function (op) {
      var clientKey = str_(op.clientKey);
      if (clientKey && seen[clientKey]) { accepted.push(clientKey); return; }

      var type = str_(op.type).toUpperCase();
      var result;
      if (type === 'ORDER_NEW') {
        result = orderNew_(op, products);
        if (!result.error) result.rows = [];
      } else if (type === 'ORDER_STATUS') {
        result = orderStatus_(op);
        if (!result.error) result.rows = [];
      } else if (type === 'BUILD_BOX' || type === 'BREAK_BOX') {
        var built = buildBoxOps_(op);
        if (built.error) { result = { error: built.error }; }
        else {
          result = { rows: [] };
          built.ops.forEach(function (sub) {
            var r = expandOp_(sub, products, stock, allowNegative, warnings);
            if (r.error) warnings.push(r.error);
            else r.rows.forEach(function (x) { result.rows.push(x); });
          });
        }
      } else if (type === 'ORDER_PACK') {
        result = orderPackRows_(op, products, stock, allowNegative, warnings);
      } else {
        result = expandOp_(op, products, stock, allowNegative, warnings);
      }
      if (result.error) { warnings.push(result.error); return; }

      result.rows.forEach(function (r) {
        counter++;
        var id = 'MV' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMddHHmmss') +
                 '-' + counter;
        rows.push([
          id, r.timestamp, r.type, r.sku, r.product, r.content, r.size, r.grade, r.batch,
          r.freezer, r.packages, r.weight, r.party, r.user, r.note, r.clientKey
        ]);
        applyToStock_(stock, r);
      });
      if (clientKey) { seen[clientKey] = true; accepted.push(clientKey); }
    });

    if (rows.length) {
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.MOVEMENTS.length).setValues(rows);
    }
  } finally {
    lock.releaseLock();
  }

  rebuildInventory();
  return { ok: true, accepted: accepted, warnings: warnings,
           stock: currentStock_(), orders: readOrders_() };
}

/** Turns one app operation into one or more signed ledger rows. */
function expandOp_(op, products, stock, allowNegative, warnings) {
  var type = str_(op.type).toUpperCase();
  var sku = str_(op.sku);
  if (!sku) return { error: 'A line had no product (SKU) and was skipped.' };

  var p = products[sku] || {};
  // Only a grade the app actually sent is used to match existing stock —
  // the product's default grade must never hide a line of another grade.
  var pickedGrade = str_(op.grade);
  var pickedSize = str_(op.size);
  var timestamp = op.timestamp ? new Date(op.timestamp) : new Date();
  if (isNaN(timestamp.getTime())) timestamp = new Date();

  var base = {
    sku: sku,
    product: str_(op.product) || p.product || sku,
    content: str_(op.content) || p.content || '',
    size: str_(op.size),
    grade: str_(op.grade) || p.grade || '',
    batch: str_(op.batch),
    freezer: str_(op.freezer),
    party: str_(op.party),
    user: str_(op.user),
    note: str_(op.note),
    clientKey: str_(op.clientKey),
    timestamp: timestamp
  };

  var qty = Math.abs(num_(op.packages));
  var weight = op.weight === '' || op.weight === undefined || op.weight === null
    ? null : Math.abs(num_(op.weight));
  if (weight === null) weight = qty * num_(p.avgWeight);

  switch (type) {
    case 'INTAKE':
      if (!qty) return { error: 'Intake of ' + base.product + ' had no package count.' };
      return { rows: [merge_(base, { type: 'INTAKE', packages: qty, weight: round2_(weight) })] };

    case 'ADJUST': {
      // Signed: negative for spoilage/personal use, positive for a found pack.
      var signed = num_(op.packages);
      if (!signed) return { error: 'Adjustment for ' + base.product + ' was zero.' };
      var w = op.weight === '' || op.weight === undefined || op.weight === null
        ? Math.abs(signed) * num_(p.avgWeight) : Math.abs(num_(op.weight));
      return { rows: [merge_(base, {
        type: 'ADJUST', packages: signed, weight: round2_(signed < 0 ? -w : w)
      })] };
    }

    case 'COUNT': {
      // Absolute recount of one line — writes the difference.
      var line = findLine_(stock, sku, pickedSize, pickedGrade, base.batch, base.freezer);
      var have = line ? line.packages : 0;
      var target = num_(op.packages);
      var delta = round3_(target - have);
      if (!delta) return { rows: [] };
      var perPkg = line && line.packages ? line.weight / line.packages : num_(p.avgWeight);
      return { rows: [merge_(base, {
        type: 'ADJUST', packages: delta, weight: round2_(delta * perPkg),
        grade: line && line.grade ? line.grade : base.grade,
        note: (base.note ? base.note + ' — ' : '') + 'recount: ' + have + ' → ' + target,
        party: base.party || 'Freezer count'
      })] };
    }

    case 'WEIGH': {
      // Weighing a lot that was counted before anyone put it on a scale.
      // Packages stay where they are; only the weight moves.
      var wl = findLine_(stock, sku, pickedSize, pickedGrade, base.batch, base.freezer);
      var have = wl ? wl.weight : 0;
      var target = op.perPackage
        ? num_(op.weight) * (wl ? wl.packages : num_(op.packages))
        : num_(op.weight);
      var diff = round2_(target - have);
      if (!diff) return { rows: [] };
      return { rows: [merge_(base, {
        type: 'WEIGH', packages: 0, weight: diff,
        grade: wl && wl.grade ? wl.grade : base.grade,
        size: wl && wl.size ? wl.size : base.size,
        party: base.party || 'Weighed',
        note: (base.note ? base.note + ' — ' : '') +
              'weight ' + round2_(have) + ' → ' + round2_(target) + ' lb'
      })] };
    }

    case 'TRANSFER': {
      var to = str_(op.toFreezer);
      if (!to || to === base.freezer) return { error: 'Transfer of ' + base.product + ' needs a different destination freezer.' };
      if (!qty) return { error: 'Transfer of ' + base.product + ' had no package count.' };
      var src = findLine_(stock, sku, pickedSize, pickedGrade, base.batch, base.freezer);
      var grade = src && src.grade ? src.grade : base.grade;
      var pw = src && src.packages ? src.weight / src.packages : num_(p.avgWeight);
      var mvWeight = round2_(qty * pw);
      if (src && qty > src.packages && !allowNegative) {
        return { error: 'Only ' + src.packages + ' of ' + base.product + ' in ' + base.freezer + '.' };
      }
      return { rows: [
        merge_(base, { type: 'TRANSFER_OUT', packages: -qty, weight: -mvWeight,
                       grade: grade, party: base.party || ('to ' + to) }),
        merge_(base, { type: 'TRANSFER_IN', packages: qty, weight: mvWeight,
                       grade: grade, freezer: to, party: base.party || ('from ' + base.freezer) })
      ] };
    }

    case 'SALE': {
      if (!qty) return { error: 'Sale of ' + base.product + ' had no package count.' };
      // A specific batch was chosen — take it straight off that line.
      if (base.batch) {
        var l = findLine_(stock, sku, pickedSize, pickedGrade, base.batch, base.freezer);
        if (!l && !allowNegative) return { error: 'No stock of ' + base.product + ' in batch ' + base.batch + '.' };
        if (l && qty > l.packages) {
          if (!allowNegative) return { error: 'Only ' + l.packages + ' of ' + base.product + ' in batch ' + base.batch + '.' };
          warnings.push('Sold ' + qty + ' of ' + base.product + ' but only ' + l.packages + ' were on hand — stock now shows negative.');
        }
        var ppw = l && l.packages ? l.weight / l.packages : num_(p.avgWeight);
        return { rows: [merge_(base, {
          type: 'SALE', packages: -qty, weight: round2_(-qty * ppw),
          grade: l && l.grade ? l.grade : base.grade,
          freezer: base.freezer || (l ? l.freezer : '')
        })] };
      }
      // No batch chosen — allocate oldest batch first.
      return allocateSale_(base, qty, stock, products, allowNegative, warnings, pickedGrade, pickedSize);
    }

    default:
      return { error: 'Unknown movement type: ' + type };
  }
}

/** Oldest-batch-first allocation for a sale where no batch was picked. */
function allocateSale_(base, qty, stock, products, allowNegative, warnings, pickedGrade, pickedSize) {
  var batchOrder = {};
  indexBatches_().forEach(function (b, i) { batchOrder[b.id] = b.packDate || b.killDate || ('zz' + i); });

  var candidates = stock.filter(function (l) {
    return l.sku === base.sku && l.packages > 0 &&
           (!base.freezer || l.freezer === base.freezer) &&
           (!pickedSize || !l.size || l.size === pickedSize) &&
           (!pickedGrade || !l.grade || l.grade === pickedGrade);
  }).sort(function (a, b) {
    return String(batchOrder[a.batch] || 'zz').localeCompare(String(batchOrder[b.batch] || 'zz'));
  });

  var rows = [];
  var remaining = qty;
  candidates.forEach(function (l) {
    if (remaining <= 0) return;
    var take = Math.min(remaining, l.packages);
    var perPkg = l.packages ? l.weight / l.packages : 0;
    rows.push(merge_(base, {
      type: 'SALE', packages: -take, weight: round2_(-take * perPkg),
      size: l.size || base.size, grade: l.grade || base.grade, batch: l.batch, freezer: l.freezer
    }));
    remaining = round3_(remaining - take);
  });

  if (remaining > 0) {
    if (!allowNegative) {
      return { error: 'Short ' + remaining + ' package(s) of ' + base.product + ' — sale not recorded.' };
    }
    warnings.push('Sold ' + remaining + ' more ' + base.product + ' than the sheet shows on hand.');
    var p = products[base.sku] || {};
    rows.push(merge_(base, {
      type: 'SALE', packages: -remaining,
      weight: round2_(-remaining * num_(p.avgWeight))
    }));
  }
  return { rows: rows };
}

function findLine_(stock, sku, size, grade, batch, freezer) {
  for (var i = 0; i < stock.length; i++) {
    var l = stock[i];
    if (l.sku !== sku) continue;
    if (batch && l.batch !== batch) continue;
    if (freezer && l.freezer !== freezer) continue;
    if (size && l.size && l.size !== size) continue;
    if (grade && l.grade && l.grade !== grade) continue;
    return l;
  }
  return null;
}

/** Keeps the in-memory stock picture current while a batch of ops is processed. */
function applyToStock_(stock, r) {
  var line = null;
  for (var i = 0; i < stock.length; i++) {
    var l = stock[i];
    if (l.sku === r.sku && l.size === r.size && l.grade === r.grade &&
        l.batch === r.batch && l.freezer === r.freezer) {
      line = l; break;
    }
  }
  if (!line) {
    line = { sku: r.sku, product: r.product, content: r.content, size: r.size,
             grade: r.grade, batch: r.batch, freezer: r.freezer, packages: 0, weight: 0 };
    stock.push(line);
  }
  line.packages = round3_(line.packages + r.packages);
  line.weight = round2_(line.weight + r.weight);
}

function merge_(base, extra) {
  var out = {};
  Object.keys(base).forEach(function (k) { out[k] = base[k]; });
  Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
  return out;
}

function round2_(n) { return Math.round(num_(n) * 100) / 100; }
function round3_(n) { return Math.round(num_(n) * 1000) / 1000; }

/* ======================== CATALOGUE ADDITIONS ======================== */

function addProduct_(p) {
  var sku = str_(p.sku).toUpperCase();
  var name = str_(p.product);
  if (!name) return { ok: false, error: 'A product needs a name.' };
  if (!sku) sku = makeSku_(name);

  var existing = indexProducts_();
  if (existing[sku]) return { ok: false, error: 'SKU ' + sku + ' already exists.' };
  // Guard against the same product being added twice from two phones.
  var content = str_(p.content);
  var sameName = Object.keys(existing).filter(function (k) {
    return existing[k].product.toLowerCase() === name.toLowerCase();
  });
  if (sameName.length) {
    var sameContent = sameName.filter(function (k) {
      return existing[k].content.toLowerCase() === content.toLowerCase();
    })[0];
    if (sameContent || !content) {
      return { ok: false, error: '"' + name + '" already exists (' + (sameContent || sameName[0]) +
               '). If this is a different pack size, put that size in the pack contents.' };
    }
  }

  sheet_(TABS.PRODUCTS).appendRow([
    sku, name, str_(p.category), content, str_(p.sizes), num_(p.avgWeight), str_(p.grade),
    p.price === '' || p.price === undefined ? '' : num_(p.price),
    p.pricePerLb === '' || p.pricePerLb === undefined ? '' : num_(p.pricePerLb),
    p.pricePerKg === '' || p.pricePerKg === undefined ? '' : num_(p.pricePerKg),
    p.marketPrice === '' || p.marketPrice === undefined ? '' : num_(p.marketPrice),
    p.marketPerLb === '' || p.marketPerLb === undefined ? '' : num_(p.marketPerLb),
    p.reorder === '' || p.reorder === undefined ? '' : num_(p.reorder),
    'Yes', str_(p.notes)
  ]);
  normalizePrices_();
  var all = indexProducts_();
  return { ok: true, sku: sku, products: Object.keys(all).map(function (k) { return all[k]; }) };
}

function makeSku_(name) {
  var base = name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  var existing = indexProducts_();
  if (!existing[base]) return base;
  var i = 2;
  while (existing[base + '-' + i]) i++;
  return base + '-' + i;
}

function addBatch_(b) {
  var id = str_(b.id) || str_(b.batch);
  if (!id) return { ok: false, error: 'A batch needs an ID (for example 2026-STEER-01).' };
  var exists = indexBatches_().some(function (x) { return x.id === id; });
  if (exists) return { ok: false, error: 'Batch ' + id + ' already exists.' };
  sheet_(TABS.BATCHES).appendRow([
    id, str_(b.animal), str_(b.outfit) || 'PCW', str_(b.butcher),
    str_(b.killDate), str_(b.packDate), str_(b.grade), 'Yes', str_(b.notes)
  ]);
  return { ok: true, batches: indexBatches_() };
}

function addFreezer_(f) {
  var id = str_(f.id).toUpperCase();
  if (!id) return { ok: false, error: 'A freezer needs an ID.' };
  if (indexFreezers_().some(function (x) { return x.id === id; })) {
    return { ok: false, error: 'Freezer ' + id + ' already exists.' };
  }
  sheet_(TABS.FREEZERS).appendRow([id, str_(f.name) || id, str_(f.location), 'Yes', str_(f.notes)]);
  return { ok: true, freezers: indexFreezers_() };
}

/* ===================== QUOTES, LISTS, STEER INPUT ===================== */

/**
 * What to charge for a particular piece. Weight wins when it is given —
 * a 1.1 lb ribeye and a 0.7 lb ribeye are not the same money.
 */
function quote_(req) {
  var sku = str_(req.sku);
  var p = indexProducts_()[sku];
  if (!p) return { ok: false, error: 'No product called ' + sku + '.' };

  var channel = (str_(req.channel) || 'website').toLowerCase();
  var market = channel === 'market' || channel === 'farmers market';
  var weight = num_(req.weight);
  var kg = !!req.kg;
  if (kg && weight) weight = weight * LB_PER_KG;

  var perLb = market && p.marketPerLb ? p.marketPerLb : p.pricePerLb;
  var perPack = market && p.marketPrice ? p.marketPrice : p.price;

  var price = 0, basis = '';
  if (weight && perLb) {
    price = weight * perLb;
    basis = weight.toFixed(2) + ' lb × $' + perLb.toFixed(2) + '/lb';
  } else if (perPack) {
    price = perPack;
    basis = 'set price for one ' + p.product;
  } else if (perLb && p.avgWeight) {
    price = perLb * p.avgWeight;
    basis = 'average ' + p.avgWeight + ' lb × $' + perLb.toFixed(2) + '/lb';
  } else {
    return { ok: false, error: 'No price on file for ' + p.product + '.' };
  }

  // What that piece cost to produce, if the steer's numbers are in.
  var floor = 0, batch = str_(req.batch);
  if (!batch) {
    var lots = currentStock_().filter(function (l) { return l.sku === sku && l.packages > 0; });
    if (lots.length) batch = lots[0].batch;
  }
  var costPerLb = batch ? steerCost_(batch) : 0;
  if (costPerLb && weight) floor = Math.round(costPerLb * weight * 100) / 100;

  return {
    ok: true, product: p.product, content: p.content, channel: market ? 'market' : 'website',
    price: Math.round(price * 100) / 100, basis: basis,
    perLb: perLb || '', perKg: perLb ? Math.round(perLb * LB_PER_KG * 100) / 100 : '',
    cost: floor, margin: floor ? Math.round((price - floor) * 100) / 100 : '',
    batch: batch
  };
}

/** The two waiting lists and the customer book, for the Menu tab. */
function lists_() {
  return {
    ok: true,
    wholesale: readTable_(TABS.WHOLESALE).map(function (r) {
      return { customer: str_(r['Customer']), phone: str_(r['Phone']), email: str_(r['Email']),
               wants: str_(r['Wants']), status: str_(r['Status']) || 'Waiting',
               priority: str_(r['Priority']), wantedBy: dateStr_(r['Wanted by']),
               deposit: num_(r['Deposit']), weight: num_(r['Weight (lb)']),
               price: num_(r['Price']), invoice: str_(r['Invoice']), paid: str_(r['Paid']),
               added: dateStr_(r['Added']), notes: str_(r['Notes']) };
    }).filter(function (r) { return r.customer; }),
    waitlist: readTable_(TABS.WAITLIST).map(function (r) {
      return { customer: str_(r['Customer']), phone: str_(r['Phone']), email: str_(r['Email']),
               wants: str_(r['Waiting for']), words: str_(r['Their words']),
               size: str_(r['Size']), grade: str_(r['Grade']),
               packages: num_(r['Packages']), added: dateStr_(r['Added']),
               status: str_(r['Status']) || 'Waiting', told: dateStr_(r['Told them on']) };
    }).filter(function (r) { return r.customer; }),
    customers: readTable_(TABS.CUSTOMERS).map(function (r) {
      return { customer: str_(r['Customer']), email: str_(r['Email']), phone: str_(r['Phone']),
               town: str_(r['Town']), orders: num_(r['Orders']),
               prior: num_(r['Orders before the app']), packages: num_(r['Packages']),
               spend: num_(r['Spend']), priorSpend: num_(r['Spend before the app']),
               first: dateStr_(r['First order']),
               last: dateStr_(r['Last order']), source: str_(r['Source']),
               bought: str_(r['Bought before']) };
    }).filter(function (r) { return r.customer; })
  };
}

function addToList_(req) {
  var which = str_(req.list).toLowerCase();
  var e = req.entry || {};
  if (!str_(e.customer)) return { ok: false, error: 'Needs a name.' };
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  if (which === 'wholesale') {
    sheet_(TABS.WHOLESALE).appendRow([str_(e.customer), str_(e.phone), str_(e.email),
      str_(e.wants), str_(e.status) || 'Waiting', str_(e.priority) || 'Normal',
      str_(e.wantedBy), num_(e.deposit), num_(e.weight), num_(e.price),
      str_(e.invoice), str_(e.paid), today, str_(e.notes)]);
  } else if (which === 'waitlist') {
    sheet_(TABS.WAITLIST).appendRow([str_(e.customer), str_(e.phone), str_(e.email),
      str_(e.wants), str_(e.words), str_(e.size), str_(e.grade), num_(e.packages) || 1,
      today, str_(e.status) || 'Waiting', '']);
  } else {
    return { ok: false, error: 'Unknown list: ' + which };
  }
  return lists_();
}

/** A steer coming back from the butcher: the animal's own numbers. */
function addSteer_(req) {
  var s = req.steer || {};
  var id = str_(s.id);
  if (!id) return { ok: false, error: 'A steer needs an ID (for example 2026-09-STEER-02).' };
  if (readTable_(TABS.STEERS).some(function (r) { return str_(r['Steer ID']) === id; })) {
    return { ok: false, error: 'Steer ' + id + ' is already on the sheet.' };
  }

  sheet_(TABS.STEERS).appendRow([
    id, str_(s.tag), str_(s.outfit) || 'PCW', str_(s.butcher), str_(s.killDate), str_(s.packDate),
    str_(s.grade), num_(s.liveWeight), num_(s.hangingWeight),
    num_(s.purchaseCost), num_(s.butcherCost), num_(s.otherCost),
    '', '', '', '', '', '', '', '', str_(s.notes)
  ]);

  // The steer is also a batch, so stock can point at it.
  if (!indexBatches_().some(function (b) { return b.id === id; })) {
    addBatch_({ id: id, animal: s.tag, outfit: s.outfit, butcher: s.butcher,
                killDate: s.killDate, packDate: s.packDate, grade: s.grade,
                notes: 'Added with the steer performance row' });
  }
  rebuildSteers_();
  return { ok: true, steerId: id };
}

/* ========================== LOW STOCK DIGEST ========================== */

function sendLowStockDigest() {
  rebuildInventory();
  var to = settings_().LOW_STOCK_EMAIL;
  if (!to) return;
  var rows = readTable_(TABS.SUMMARY).filter(function (r) {
    var s = str_(r['Status']);
    return s === 'LOW' || s === 'OUT' || s === 'OVERSOLD';
  });
  if (!rows.length) return;
  var body = rows.map(function (r) {
    return '• ' + str_(r['Product']) + ' (' + str_(r['Content']) + ') — ' +
           num_(r['Available']) + ' free to sell (' + num_(r['Packages']) + ' on hand, ' +
           num_(r['Committed']) + ' promised to orders), reorder at ' + str_(r['Reorder point']);
  }).join('\n');
  MailApp.sendEmail(to, 'PCW inventory — ' + rows.length + ' product(s) low or out',
    'Running low or out of stock:\n\n' + body + '\n\n' + ss_().getUrl());
}
