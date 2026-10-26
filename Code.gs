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
  STAFF:     'STAFF',
  SIGNINLOG: 'SIGN-IN LOG',
  PRICELOG:  'PRICE CHANGES',
  FREEZERLOG:'FREEZER TEMPS',
  ALERTS:    'ALERTS',
  SETTINGS:  'SETTINGS'
};

var HEADERS = {
  // The three wholesale / pieces columns are deliberately on the end. Slotting
  // them in beside their cousins would renumber every column after them, and
  // a sheet that had not been migrated yet would quietly write prices into
  // the wrong cells. On the end, an old sheet is simply missing them.
  // 'Price / *' IS the price list — the wholesale rate, the base everything
  // else is worked out from. 'Website / *' and 'Market / *' are only there to
  // hold a price somebody set by hand; left empty, those two are the list plus
  // the markup. That is why the wholesale columns went: wholesale is not a
  // second price, it is the list itself.
  PRODUCTS: ['SKU', 'Product', 'Category', 'Content', 'Sizes', 'Avg weight (lb)', 'Default grade',
             'Price / pack', 'Price / lb', 'Price / kg',
             'Market / pack', 'Market / lb', 'Reorder point', 'Active', 'Notes',
             'Website / pack', 'Website / lb', 'Pieces / pack'],
  BATCHES:  ['Batch ID', 'Animal / tag', 'Outfit', 'Butcher', 'Kill date', 'Pack date',
             'Grade (BMS)', 'Active', 'Notes'],
  // 'Govee device' is on the end so an older sheet is simply missing it:
  // paste the sensor's ID, or the name it has in the Govee app, beside the
  // freezer it lives in. Left blank, a sensor named after the freezer is
  // matched to it anyway.
  FREEZERS: ['Freezer ID', 'Name', 'Location', 'Active', 'Notes', 'Govee device'],
  INVENTORY:['SKU', 'Product', 'Content', 'Size', 'Grade', 'Batch', 'Freezer', 'Packages',
             'Weight (lb)', 'Avg wt / pkg', 'Last movement'],
  SUMMARY:  ['SKU', 'Product', 'Content', 'Packages', 'Committed', 'Available',
             'Weight (lb)', 'Reorder point', 'Status', 'Freezers', 'Batches'],
  // The last four are appended rather than slotted in, because several writes
  // address these columns by number (status is column 6, value column 9).
  ORDERS:   ['Order ID', 'Customer', 'Contact', 'Delivery date', 'Method', 'Status',
             'Packages ordered', 'Packages packed', 'Value', 'Notes', 'Created', 'Created by',
             'Packed at', 'Delivered at',
             'Phone', 'Time', 'Venue', 'Calendar event', 'Channel',
             // Delivered and paid are two different days. An order can go out
             // on the Tuesday and be settled on the Friday, and the gap
             // between them is the money somebody still owes.
             'Paid', 'Payment type', 'Paid at',
             // "The lot for $200." The lines keep their own prices so the
             // freezer and the margin still add up; this is what the
             // customer was actually told the order comes to.
             'Total priced by hand'],
  // Weight, rate and line total so an order carries its own money rather
  // than being re-priced from a price list that may have moved since.
  // 'Priced by hand' is the difference between a price the rule worked out
  // and a price somebody agreed with a customer. Without it, moving an order
  // onto another price list would quietly undo the agreed one.
  ORDERITEMS:['Order ID', 'SKU', 'Product', 'Content', 'Packages', 'Packed', 'Line note',
              'Weight (lb)', 'Rate', 'Line total', 'Promo', 'Priced by hand'],
  /* What the price list used to say and what it says now. A price is only
     the price when it is changed here on the catalogue — in the app or typed
     into the PRODUCTS tab. A price agreed on one order is an arrangement with
     that customer and never reaches this tab. */
  PRICELOG: ['Change ID', 'When', 'SKU', 'Product', 'Which price', 'Was', 'Now',
             'Changed by', 'Where', 'Note'],
  /* What each freezer was reading when it was last looked at. One row per
     sensor per check, so there is a history to look back through when a
     freezer starts misbehaving rather than only today's number.

     'Source' says how the row got here. The sweep writes 'Govee API'; a
     reading typed in from a screenshot of the Govee app names the
     screenshot. Somebody checking this record is entitled to know which
     numbers a machine wrote down and which a person read off a phone, so
     the two are never mixed into one undifferentiated column of readings. */
  FREEZERLOG:['When', 'Freezer', 'Freezer name', 'Sensor', 'Temperature (F)',
              'Temperature (C)', 'Humidity %', 'Battery %', 'Online', 'Status',
              'Note', 'Source'],
  /* Anything the app should put a banner up about. Dismissed ones stay, so
     there is a record of what happened and who said it was dealt with. */
  /* Putting a warning away closes the banner; it does not settle the matter.
     'Answer' is what was said about it — left for now, or being looked into —
     and the next sweep that still finds the problem raises it again as a new
     line, so the record shows every day it came back and what was said each
     time. */
  ALERTS:   ['Alert ID', 'Raised', 'Kind', 'About', 'What', 'Detail', 'Last seen',
             'How bad', 'Put away', 'Answer', 'Put away by', 'Put away at',
             'Said before', 'Said when'],
  MOVEMENTS:['Move ID', 'Timestamp', 'Type', 'SKU', 'Product', 'Content', 'Size', 'Grade', 'Batch',
             'Freezer', 'Packages', 'Weight (lb)', 'Party / reason', 'User', 'Note', 'Client key'],
  SCANS:    ['Scan ID', 'Taken', 'By', 'Status', 'Photo', 'What the label says',
             'Batch', 'Freezer', 'Note', 'Filed as'],
  // 'Weight each (lb)' is the average weight of ONE of that cut IN THIS BOX,
  // which is not the same as the cut's own average: a ribeye is 14 oz in Best
  // of Both Worlds and 11 oz in Dinner for Two. 'Weight in the box (lb)' is
  // for a line sold by total weight with no piece weight known — the Rancher
  // Feast is 4.2 lb of sirloin and nobody counted the steaks.
  BOXES:    ['Box SKU', 'Box', 'Component SKU', 'Component', 'Packages per box', 'Notes',
             'Weight each (lb)', 'Weight in the box (lb)'],
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
  STAFF:    ['Email', 'Name', 'Role', 'Active', 'First signed in', 'Notes'],
  SIGNINLOG:['When', 'Account', 'What they were doing', 'Why it was refused'],
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
 * Google's Spreadsheets service throws "Service error: Spreadsheets" now and
 * then under a burst of writes — it is their side, not the file's, and the
 * same call usually goes through a moment later. Retry a few times with a
 * growing pause before giving up.
 */
function keepTrying_(what, job) {
  var waits = [500, 1500, 4000];
  for (var i = 0; ; i++) {
    try { return job(); }
    catch (err) {
      var msg = String(err && err.message ? err.message : err);
      var transient = /Service error|internal error|try again|timed out|Service invoked too many/i.test(msg);
      if (!transient || i >= waits.length) {
        throw new Error(what + ': ' + msg);
      }
      Utilities.sleep(waits[i]);
    }
  }
}

/**
 * Run this once. Creates every tab, headers, formatting, validation,
 * a starter freezer list, the API token, and the rebuild trigger.
 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // A tab whose name matches ours but whose headers do not is somebody else's
  // data. Google treats sheet names case-insensitively, so an older "Products"
  // tab answers to PRODUCTS. Move it aside rather than writing our headers over
  // the top of it, which scrambles every column that does not line up.
  // Look the tabs up by walking the real list rather than calling
  // getSheetByName. Two reasons: that call has been seen to throw
  // "Sheet 0 not found" on a file whose sheet list Google has got into a
  // muddle, which stops setup() dead; and matching the names here ourselves
  // makes the case-insensitivity explicit instead of leaning on a Google
  // quirk — the same quirk that let an old "Products" tab answer to PRODUCTS
  // and get its columns scrambled.
  var allSheets = ss.getSheets();
  var findTab = function (wanted) {
    var want = String(wanted).trim().toLowerCase();
    for (var i = 0; i < allSheets.length; i++) {
      var nm;
      try { nm = String(allSheets[i].getName()); }
      catch (err) { continue; }                 // a tab Google cannot read right now
      if (nm.trim().toLowerCase() === want) return allSheets[i];
    }
    return null;
  };

  Object.keys(TABS).forEach(function (key) {
    var name = TABS[key];
    var existing = findTab(name);
    if (!existing) return;
    var lastRow;
    // If a single tab is unreadable, say which one rather than failing the
    // whole run with a message that names nothing.
    try { lastRow = existing.getLastRow(); }
    catch (err) {
      throw new Error('Could not read the "' + name + '" tab: ' +
        (err && err.message ? err.message : err) +
        '. Try reloading the Sheet, then run setup again.');
    }
    if (lastRow < 1) return;
    var head = existing.getRange(1, 1, 1, Math.max(1, existing.getLastColumn()))
      .getValues()[0].map(function (h) { return String(h).trim(); });
    var ours = HEADERS[key] || [];
    var overlap = head.filter(function (h) { return h && ours.indexOf(h) > -1; }).length;
    // It is ours if the key column matches, or if most of the headers do. A
    // handful of incidental matches (Category, Notes, Active turn up in any
    // schema) is not enough to justify writing over somebody's data.
    if (head[0] === ours[0] || overlap >= ours.length * 0.6) return;
    // Keep the tab's own spelling, so "Products" stays "Products".
    var own = existing.getName();
    var parked = own + ' (was here first)';
    var n = 2;
    while (findTab(parked)) { parked = own + ' (was here first ' + (n++) + ')'; }
    existing.setName(parked);
  });

  Object.keys(TABS).forEach(function (key) {
    var name = TABS[key];
    var headers = HEADERS[key];

    var sh = findTab(name);
    if (!sh) {
      sh = keepTrying_('Creating the "' + name + '" tab', function () { return ss.insertSheet(name); });
      allSheets.push(sh);
    }

    // The parts that matter: the columns line up and the headers are right.
    keepTrying_('Setting up the "' + name + '" tab', function () {
      migrateTab_(sh, headers);
      sh.getRange(1, 1, 1, headers.length).setValues([headers])
        .setFontWeight('bold').setBackground('#3c2415').setFontColor('#ffffff');
      sh.setFrozenRows(1);
      if (sh.getMaxColumns() > headers.length) {
        sh.deleteColumns(headers.length + 1, sh.getMaxColumns() - headers.length);
      }
    });

    // Column widths are cosmetic, and autoResizeColumns is the single
    // greediest call in here — it is a common cause of "Service error:
    // Spreadsheets" on a file this size. Never let it stop the run.
    try { sh.autoResizeColumns(1, headers.length); } catch (err) {}
  });

  // Seed settings if empty.
  var settings = findTab(TABS.SETTINGS);
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
      ['FOLLOWUP_WINDOW', '30',                   'Days a follow-up stays "due now" before it reads overdue'],
      ['OLD_TABS_SHEET_ID','',                    'File holding the old Products/Prices/Lots tabs, if not this one']
    ];
    settings.getRange(2, 1, seed.length, 3).setValues(seed);
  }

  // Seed freezers if empty.
  var fz = findTab(TABS.FREEZERS);
  if (fz.getLastRow() < 2) {
    fz.getRange(2, 1, 3, 5).setValues([
      ['MAIN',  'Main chest freezer', 'Home shop',   'Yes', ''],
      ['SHOP',  'Shop upright',       'Shop',        'Yes', ''],
      ['TRUCK', 'Delivery cooler',    'Truck / runs','Yes', 'Stock out on a delivery run']
    ]);
  }

  // Number formats.
  var mv = findTab(TABS.MOVEMENTS);
  mv.getRange('B2:B').setNumberFormat('yyyy-mm-dd hh:mm');
  mv.getRange('K2:L').setNumberFormat('0.00');
  findTab(TABS.INVENTORY).getRange('H2:J').setNumberFormat('0.00');
  findTab(TABS.SUMMARY).getRange('D2:G').setNumberFormat('0.00');
  findTab(TABS.PRODUCTS).getRange('H2:L').setNumberFormat('$#,##0.00');
  findTab(TABS.ORDERS).getRange('D2:D').setNumberFormat('yyyy-mm-dd');
  findTab(TABS.ORDERS).getRange('I2:I').setNumberFormat('$#,##0.00');
  findTab(TABS.ORDERS).getRange('K2:K').setNumberFormat('yyyy-mm-dd hh:mm');

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

  // The token goes in the sheet, not only in a popup: a popup only appears if
  // you happen to be looking at the spreadsheet when setup runs.
  var st = sheet_(TABS.SETTINGS);
  var rows = readTable_(TABS.SETTINGS);
  var hasToken = rows.some(function (r) { return str_(r['Key']) === 'API_TOKEN'; });
  if (!hasToken) {
    st.appendRow(['API_TOKEN', props.getProperty('API_TOKEN'),
                  'Paste this into the phone app settings, with the web app URL']);
  }
  var hasGovee = rows.some(function (r) { return str_(r['Key']) === GOVEE_KEY_SETTING; });
  if (!hasGovee) {
    st.appendRow([GOVEE_KEY_SETTING, '',
                  'Govee developer API key, for reading the freezer thermometers. ' +
                  'Get it in the Govee Home app: Profile, Settings, Apply for API Key. ' +
                  'Leave blank and the freezers are not watched at all.']);
    st.appendRow([GOVEE_UNIT_SETTING, 'C',
                  'C or F — how temperatures are shown in the app, and the unit ' +
                  'the two lines below are read in.']);
    st.appendRow([GOVEE_WARM_SETTING, String(GOVEE_WARM_C_DEFAULT),
                  'Worth a look above this. Frozen storage sits around -18C, and a ' +
                  'lid left open reads warmer for a few minutes, so this is set ' +
                  'well clear of it.']);
    st.appendRow([GOVEE_HOT_SETTING, String(GOVEE_HOT_C_DEFAULT),
                  'The meat is at risk above this. Raises the red banner.']);
    st.appendRow([GOVEE_BATT_SETTING, String(GOVEE_BATT_DEFAULT),
                  'Say something when a sensor reports this battery percent. The ' +
                  'H5100 does not report its battery to the API, so this only ' +
                  'applies to a sensor that does.']);
    st.appendRow([FREEZER_EVERY_SETTING, String(FREEZER_EVERY_DEFAULT),
                  'How many hours between readings. Govee keeps no history of ' +
                  'its own, so this is how dense the log is. 1 = hourly. Run ' +
                  'setupFreezerWatch() again after changing it.']);
    st.appendRow([FREEZER_STUCK_SETTING, String(FREEZER_STUCK_DEFAULT),
                  'A reading identical for this many hours is treated as a ' +
                  'stopped sensor rather than a steady freezer.']);
    st.appendRow([GOVEE_SENDS_SETTING, GOVEE_SENDS_DEFAULT,
                  'What Govee own numbers are in. Checked against the live account ' +
                  'October 2026: Fahrenheit. Only change this if Govee changes.']);
  }
  var hasFlat = rows.some(function (r) { return str_(r['Key']) === NO_MARKUP_CATS_SETTING; });
  if (!hasFlat) {
    st.appendRow([NO_MARKUP_CATS_SETTING, NO_MARKUP_CATS_DEFAULT,
                  'Categories sold at list price with no markup, website or market.']);
    st.appendRow([NO_MARKUP_SKUS_SETTING, NO_MARKUP_SKUS_DEFAULT,
                  'Individual products with no markup, on top of the categories above.']);
  }
  var hasKey = rows.some(function (r) { return str_(r['Key']) === CLAUDE_KEY_SETTING; });
  if (!hasKey) {
    st.appendRow([CLAUDE_KEY_SETTING, '',
                  'Anthropic API key, for reading photos of meat. Blank = photo counting off. ' +
                  'Label reading needs it too.']);
    st.appendRow([CLAUDE_MODEL_SETTING, CLAUDE_MODEL_DEFAULT,
                  'The model behind the photos and behind Kenji in the app. ' +
                  'Change this if the app says the model was refused.']);
  }
  var hasJoin = rows.some(function (r) { return str_(r['Key']) === JOIN_WORD_KEY; });
  if (!hasJoin) {
    st.appendRow([JOIN_WORD_KEY, JOIN_WORD_DEFAULT,
                  'Anyone with a Google account can let themselves in by typing this once. ' +
                  'Change it here any time. Joiners land on the STAFF tab.']);
  }
  try {
    SpreadsheetApp.getUi().alert(
      'PCW Inventory is set up.\n\n' +
      'API token: ' + props.getProperty('API_TOKEN') + '\n\n' +
      'It is also in the SETTINGS tab. Deploy ▸ New deployment ▸ Web app, then ' +
      'paste the /exec URL and this token into the phone app settings screen.'
    );
  } catch (e) {
    // Run from the editor with no spreadsheet open — the SETTINGS row covers it.
  }
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
    .addSeparator()
    .addItem('Bring the old Lots across (run once)', 'migrateOldTabs_')
    .addItem('Retire the old tabs', 'retireOldTabs_')
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


/* ===================== RUNNABLE FROM THE EDITOR =====================
 * Apps Script hides functions whose names end in an underscore from the Run
 * dropdown. These are thin public wrappers so every job can be started either
 * from the sheet menu or from the editor, and each one reports what it did in
 * the execution log rather than a popup that may not be on screen.
 */
function bringOldLotsAcross() {
  var r = migrateOldTabs_();
  console.log(JSON.stringify(r, null, 2));
  if (!r.ok) throw new Error(r.error);
  console.log('Catalogue: ' + r.products + ' products. Opening count: ' +
              r.lots + ' lots, ' + r.packages + ' packages.');
  return r;
}

function retireOldTabs() {
  var r = retireOldTabs_();
  console.log('Renamed: ' + (r.renamed.join(', ') || 'nothing'));
  return r;
}

function importSalesSheet() {
  var r = importFromSalesSheet_();
  console.log(JSON.stringify(r, null, 2));
  return r;
}

function pickUpRadar() {
  var r = pullRadar_();
  console.log(JSON.stringify(r, null, 2));
  return r;
}

/** What the app is about to serve — a quick read without opening the tabs. */
function whatIsInStock() {
  var rows = readTable_(TABS.SUMMARY).filter(function (r) { return num_(r['Packages']) > 0; });
  var packs = rows.reduce(function (s, r) { return s + num_(r['Packages']); }, 0);
  console.log(rows.length + ' products with stock, ' + packs + ' packages.');
  rows.slice(0, 40).forEach(function (r) {
    console.log('  ' + str_(r['Product']) + ' ' + str_(r['Content']) + ' — ' + num_(r['Packages']));
  });
  return { products: rows.length, packages: packs };
}

/* ============================ SHEET I/O ============================ */

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

/**
 * The tab, by name.
 *
 * getSheetByName is the quick way and is tried first, but it has been seen to
 * throw "Sheet 0 not found" on a file whose sheet list Google has got into a
 * muddle — which took down setup() before it had done anything. So when it
 * throws, or comes back empty, walk the real list instead. Matching is
 * case-insensitive either way, which is what getSheetByName does natively.
 */
function sheet_(name) {
  var ss = ss_();
  var sh = null;
  try { sh = ss.getSheetByName(name); } catch (err) { sh = null; }

  if (!sh) {
    var want = String(name).trim().toLowerCase();
    var all;
    try { all = ss.getSheets(); } catch (err2) { all = []; }
    for (var i = 0; i < all.length && !sh; i++) {
      var nm;
      try { nm = String(all[i].getName()); } catch (err3) { continue; }
      if (nm.trim().toLowerCase() === want) sh = all[i];
    }
  }

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

/**
 * A cell that holds a moment, whatever shape it is in.
 *
 * Sheets usually hands back a real Date, but a column somebody formatted as
 * text hands back a string, and `instanceof Date` quietly says no to it —
 * so a perfectly good timestamp reads as missing. This takes either.
 */
function asDate_(v) {
  if (!v && v !== 0) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? null : v;
  }
  var d = new Date(typeof v === 'number' ? v : str_(v));
  return isNaN(d.getTime()) ? null : d;
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

/**
 * Paul's pricing rule: round up to the next $5, and if that lands on a 0 take
 * a dollar off, so every price ends in 5 or 9. Derived from the markup rule in
 * the PCWagyuPricingModel workbook and checked against the live website — it
 * reproduces the Gold price of every graded box to the dollar.
 */
/* ─────────────── what does and does not get marked up ───────────────
 * Processed meat is sold at list price with no markup, on the website and at
 * the market alike — Paul's rule, Oct 2026. It is why the Camping Pack sits
 * at exactly its contents value: it is nothing but smokies and patties, so
 * zero markup is correct, not an oversight.
 *
 * Which products count is kept on the SETTINGS tab rather than buried here,
 * because the line between "processed" and "a cut" is a business call, not a
 * technical one, and it will move.
 */
var NO_MARKUP_CATS_SETTING = 'NO_MARKUP_CATEGORIES';
var NO_MARKUP_SKUS_SETTING = 'NO_MARKUP_SKUS';
var NO_MARKUP_CATS_DEFAULT = 'Processed, Tallow';
var NO_MARKUP_SKUS_DEFAULT = 'BURGER-PATTIES-5-PACK, BURGER-PATTIES-30-PACK, ' +
                             'SEASONED-PATTIES-4-PACK, SEASONED-PATTIES-30-PACK';

function splitList_(raw) {
  return str_(raw).split(',').map(function (x) { return x.trim().toLowerCase(); })
            .filter(function (x) { return x; });
}

/* Read a list from SETTINGS. A cell that is there but empty means "none" —
 * only a missing row falls back to the default, or clearing the list would
 * appear to do nothing at all. */
function settingList_(cfg, key, fallback) {
  var has = Object.prototype.hasOwnProperty.call(cfg, key);
  return splitList_(has ? cfg[key] : fallback);
}

/* ═══════════════════ WHAT AN ORDER COMES TO ═══════════════════
 *
 * An order is priced when it is written and then keeps those numbers. The
 * price list moves; an order that has been quoted must not move with it.
 */

var GB_SKUS_SETTING   = 'GROUND_BEEF_SKUS';
var GB_SKUS_DEFAULT   = 'GROUND-BEEF-1-LB, GROUND-BEEF-2-LB, GROUND-BEEF-20-LB';
var GB_TIERS_SETTING  = 'GROUND_BEEF_TIERS';
/* "from pounds : dollars a pound", cheapest band last. Under ten pounds is
   thirteen dollars, ten to nineteen is twelve fifty, twenty and over is
   twelve — the same table for wholesale, website and the farmers market. */
var GB_TIERS_DEFAULT  = '0:13, 10:12.5, 20:12';
var CHANNELS          = ['wholesale', 'website', 'market'];
var PAY_SETTING       = 'PAYMENT_TYPES';
var PAY_DEFAULT       = 'Cash, E-transfer, Cheque, Helcim (website), Stripe (website), Other';
/* April to March. "Year to date" needs a starting line and Paul's is the
   first of April, so a sale in February belongs to the year that began the
   previous April. */
var FISCAL_START_SETTING = 'FISCAL_YEAR_STARTS';
var FISCAL_START_DEFAULT = '4';
var CHANNEL_DEFAULT   = 'website';

function orderChannel_(v) {
  var c = str_(v).toLowerCase().replace(/[^a-z]/g, '');
  if (c.indexOf('whole') === 0) return 'wholesale';
  if (c.indexOf('market') === 0 || c.indexOf('farmers') === 0) return 'market';
  if (c.indexOf('web') === 0 || c.indexOf('site') === 0) return 'website';
  return CHANNEL_DEFAULT;
}

function isGroundBeef_(sku, cfg) {
  return settingList_(cfg, GB_SKUS_SETTING, GB_SKUS_DEFAULT)
    .indexOf(str_(sku).toLowerCase()) !== -1;
}

/* The bands, read off the settings tab so the rates can be changed without
   touching this file. A band is "from this many pounds : this much a pound". */
function gbTiers_(cfg) {
  var raw = Object.prototype.hasOwnProperty.call(cfg || {}, GB_TIERS_SETTING)
    ? str_(cfg[GB_TIERS_SETTING]) : GB_TIERS_DEFAULT;
  var out = [];
  String(raw || '').split(',').forEach(function (bit) {
    var parts = String(bit).split(':');
    if (parts.length !== 2) return;
    var from = num_(parts[0]), rate = num_(parts[1]);
    if (rate > 0) out.push({ from: from, rate: rate });
  });
  if (!out.length) out = [{ from: 0, rate: 13 }, { from: 10, rate: 12.5 }, { from: 20, rate: 12 }];
  out.sort(function (a, b) { return a.from - b.from; });
  return out;
}

/* How much a pound of ground beef is, for an order with this many pounds of
   it on. The band is decided by the whole order, not by the line, so five
   two-pound packs and ten one-pound packs cost the same. */
function gbRate_(totalLb, cfg) {
  var tiers = gbTiers_(cfg);
  var rate = tiers[0].rate;
  tiers.forEach(function (t) { if (num_(totalLb) >= t.from) rate = t.rate; });
  return rate;
}

/**
 * The lines of an order worth keeping.
 *
 * A line is usually a product from the catalogue, but not always: a jar of
 * somebody's jam going out with the beef, a delivery charge, a cut being
 * trialled before it is on the list. Those have a name and a price and no
 * SKU, and they never touch the freezer — there is nothing in it to touch.
 * A line with neither a SKU nor a name is nothing at all and is dropped.
 */
function orderLines_(lines) {
  return (lines || []).filter(function (l) {
    if (!(num_(l.packages) > 0)) return false;
    return !!(str_(l.sku) || str_(l.product));
  });
}

/**
 * Prices every line of an order and adds them up.
 *
 * Each line comes back with the weight it was priced on, the rate, and what
 * it comes to. A line marked promo keeps its rate — so the giveaway can be
 * seen for what it was worth — and comes to nothing. A line whose total was
 * typed in by hand is left exactly as typed.
 */
function priceOrderLines_(lines, channel, products, cfg) {
  cfg = cfg || settings_();
  var ch = orderChannel_(channel);

  // Ground beef is banded on the whole order, so its pounds are counted first.
  var gbLb = 0;
  (lines || []).forEach(function (l) {
    if (!str_(l.sku) || !isGroundBeef_(l.sku, cfg)) return;
    var p = products[str_(l.sku)] || {};
    gbLb += num_(l.weight) || (num_(l.packages) * num_(p.avgWeight));
  });
  var gbPerLb = gbRate_(gbLb, cfg);

  var total = 0;
  var priced = (lines || []).map(function (l) {
    var sku = str_(l.sku);
    var p = products[sku] || {};
    var packs = num_(l.packages);

    // Not in the catalogue: there is no rule to price it by, so whatever
    // was typed is the price, and nothing is weighed or marked up.
    if (!sku || !products[sku]) {
      var typed = Math.round(num_(l.total) * 100) / 100;
      var own = !!l.promo ? 0 : typed;
      total += own;
      return { sku: '', product: str_(l.product) || 'Something else',
               content: str_(l.content), packages: packs, weight: 0,
               rate: packs ? Math.round((typed / packs) * 100) / 100 : 0,
               basis: 'each', worth: typed, total: own, promo: !!l.promo,
               manual: true, offCatalogue: true, needsWeight: false,
               note: str_(l.note) };
    }

    var weight = num_(l.weight) || packs * num_(p.avgWeight);
    var cp = channelPrices_(p, cfg);

    /* Weighed or counted.
       A cut with a price a pound is weighed — even with nothing on the scale
       yet, because that is the line that needs a weight typed into it and it
       cannot ask for one if it has decided it is sold by the pack. Twenty
       eight of the cuts have a pound price and no average weight on file, so
       making the weight decide the basis left every steak line reading $0
       with nowhere to put the number. Something with a real pack price and
       nothing to weigh — patties, smokies — is counted. */
    var rate, basis;
    var perLb = num_(cp[ch + 'PerLb']);
    if (isGroundBeef_(sku, cfg)) {
      rate = gbPerLb; basis = 'lb';
    } else if (perLb && (weight || !num_(cp.listPerPack))) {
      rate = perLb; basis = 'lb';
    } else {
      rate = num_(cp[ch + 'PerPack']); basis = 'pack';
    }

    var worth = basis === 'lb' ? rate * weight : rate * packs;
    worth = Math.round(worth * 100) / 100;

    var promo = !!l.promo;
    var manual = !promo && l.manual && num_(l.total) >= 0 && l.total !== '' && l.total !== null;
    var lineTotal = promo ? 0 : (manual ? Math.round(num_(l.total) * 100) / 100 : worth);
    // Sold by the pound with nothing on the scale: it is not worth nothing,
    // it is not known yet, and the difference matters on a quote.
    var needsWeight = !promo && !manual && basis === 'lb' && !weight;
    total += lineTotal;

    return {
      sku: sku,
      product: str_(l.product) || p.product || sku,
      content: str_(l.content) || p.content || '',
      packages: packs,
      weight: Math.round(weight * 100) / 100,
      rate: Math.round(rate * 100) / 100,
      basis: basis,
      worth: worth,                 // what the rule says, even when overridden
      total: lineTotal,
      promo: promo,
      manual: !!manual,
      needsWeight: needsWeight,
      note: str_(l.note)
    };
  });

  var waiting = priced.filter(function (l) { return l.needsWeight; }).length;
  return { channel: ch, lines: priced,
           groundBeefLb: Math.round(gbLb * 100) / 100,
           groundBeefRate: gbPerLb,
           needsWeight: waiting,
           total: Math.round(total * 100) / 100 };
}

/** Is this product sold at list price, with no markup on top? */
function noMarkup_(product, cfg) {
  if (!product) return false;
  cfg = cfg || settings_();
  var cats = settingList_(cfg, NO_MARKUP_CATS_SETTING, NO_MARKUP_CATS_DEFAULT);
  var skus = settingList_(cfg, NO_MARKUP_SKUS_SETTING, NO_MARKUP_SKUS_DEFAULT);
  if (skus.indexOf(str_(product.sku).toLowerCase()) !== -1) return true;
  return cats.indexOf(str_(product.category).toLowerCase()) !== -1;
}

/**
 * The three prices for one product.
 *
 * The price list — the "1. PCW Product Price List" rates that live in the
 * Price / lb and Price / pack columns — IS the wholesale price. Nothing is
 * added to it and it is never rounded, because a wholesale quote of $84.37
 * is right and $84.99 is wrong.
 *
 * Website and farmers market are that list plus their markup, rounded up to
 * the next $5 and then back a dollar if it lands on a zero, so every retail
 * price ends in 5 or 9. A price typed into the Website / * or Market / *
 * columns wins over the rule — that is what those columns are for.
 *
 * Two exceptions:
 *  • Processed meat sells at one price everywhere for now, so all three match.
 *  • A box's prices were set by hand against the website, so they are read as
 *    typed; its base is the contents, which boxesForApp_ already works out.
 */
function channelPrices_(product, cfg) {
  cfg = cfg || settings_();
  var p = product || {};
  var listLb   = num_(p.pricePerLb) || num_(p.strayWholesalePerLb);
  var listPack = num_(p.price)      || num_(p.strayWholesale);

  var flat = noMarkup_(p, cfg);
  var box  = !!p.isBox;
  var webPct = flat || box ? 0 : pctOf_(cfg.WEBSITE_MARKUP, 30);
  var mktPct = flat || box ? 0 : pctOf_(cfg.MARKET_MARKUP, 15);

  var marked = function (base, pct) {
    if (!base) return 0;
    if (!pct) return Math.round(base * 100) / 100;   // no markup, no rounding
    return round59_(base * (1 + pct / 100));
  };

  // A box's typed price is the website price, not the list, so it is not
  // also offered as the wholesale rate.
  return {
    listPerLb: listLb,
    listPerPack: listPack,
    wholesalePerLb:  box ? num_(p.webSetPerLb) : listLb,
    wholesalePerPack: box ? num_(p.webSet)     : listPack,
    websitePerLb:   num_(p.webSetPerLb) || (box ? listLb   : marked(listLb, webPct)),
    websitePerPack: num_(p.webSet)      || (box ? listPack : marked(listPack, webPct)),
    marketPerLb:    num_(p.marketPerLb) || (box ? 0 : marked(listLb, mktPct)),
    marketPerPack:  num_(p.marketPrice) || (box ? 0 : marked(listPack, mktPct)),
    flat: flat, box: box, webPct: webPct, mktPct: mktPct
  };
}

/* A markup typed as "30%", "30" or "1.3" all mean the same thing to a person.
 * Read whichever was typed and fall back to the agreed default. */
function pctOf_(value, fallback) {
  var raw = str_(value).replace('%', '').trim();
  if (raw === '') return fallback;
  var n = Number(raw);
  if (!isFinite(n) || n <= 0) return fallback;
  /* Three ways a person writes the same markup, and all three have to mean
     thirty per cent:
        "30" or "30%"  a percentage
        "1.3"          a multiplier
        "0.3"          a fraction
     This used to read anything under 2 as a multiplier, so a plain "0.3" in
     SETTINGS came out as MINUS seventy per cent. That priced a $63 ribeye at
     $19 on the website and $9 at the farmers market — every retail price in
     the app was wrong, and Kenji read them out faithfully. */
  if (n < 1) return Math.round(n * 1000) / 10;                  // 0.3 → 30
  if (n < 2) return Math.round((n - 1) * 1000) / 10;            // 1.3 → 30
  return n;
}

function round59_(v) {
  v = num_(v);
  if (v <= 0) return 0;
  var p = Math.ceil(v / 5) * 5;
  return p % 10 === 0 ? p - 1 : p;
}

/* ====================== STOCK REBUILD (LEDGER) ====================== */

/**
 * Rebuilds INVENTORY and STOCK BY PRODUCT from the MOVEMENTS ledger.
 * Safe to run any time; it is the single source of truth for stock levels.
 */
/* ===================================================================
 * KNOWING WHETHER ANYTHING CHANGED
 *
 * bootstrap_ is expensive: it reads a dozen tabs and opens the sales
 * sheet as well. Most of the time it is called, nothing has changed
 * since the last call, and every one of those reads is wasted.
 *
 * So we keep a cheap stamp of "the state of the data". Two parts:
 *   - a counter this script bumps whenever it writes anything, and
 *   - when each spreadsheet was last touched, which catches edits made
 *     by hand in the sheet, and sales Hannah adds to the sales sheet.
 * Three quick calls stand in for fifteen slow ones.
 * =================================================================== */
var DATA_VERSION_KEY = 'DATA_VERSION';

/** Call after anything is written. Cheap: one property write. */
function bumpDataVersion_() {
  var props = PropertiesService.getScriptProperties();
  var n = num_(props.getProperty(DATA_VERSION_KEY)) + 1;
  try { props.setProperty(DATA_VERSION_KEY, String(n)); } catch (err) {}
  return n;
}

function fileTouched_(id) {
  if (!id) return '';
  try { return String(DriveApp.getFileById(id).getLastUpdated().getTime()); }
  catch (err) { return ''; }
}

/** A short string that changes whenever anything the app shows could have. */
function dataStamp_() {
  var v = str_(PropertiesService.getScriptProperties().getProperty(DATA_VERSION_KEY)) || '0';
  var here = '';
  try { here = fileTouched_(ss_().getId()); } catch (err) {}
  var sales = fileTouched_(str_(settings_().SALES_SHEET_ID));
  return v + '.' + here + '.' + sales;
}

/* The inventory recount is derived data: the same ledger always gives the
 * same totals. Re-running it when the ledger has not moved rewrites two tabs
 * for nothing. This remembers what the last recount was built from. */
var INV_BUILT_KEY = 'INVENTORY_BUILT_FOR';

/* A fingerprint of everything the recount reads. Row counts are cheap — no
 * data comes back — and the last Move ID catches a ledger that was appended
 * to and trimmed back to the same length. In-place edits (an order quantity,
 * a price typed over) do not change a row count, so the version counter and
 * the file's modified time cover those. */
function ledgerStamp_() {
  var parts = [];
  var tabs = [TABS.MOVEMENTS, TABS.PRODUCTS, TABS.ORDERS, TABS.ORDERITEMS,
              TABS.BATCHES, TABS.FREEZERS, TABS.SETTINGS];
  for (var i = 0; i < tabs.length; i++) {
    var n = 0;
    try { n = sheet_(tabs[i]).getLastRow(); } catch (err) { n = -1; }
    parts.push(n);
  }
  var mv = 0, lastId = '';
  try {
    var sh = sheet_(TABS.MOVEMENTS);
    mv = sh.getLastRow();
    if (mv > 1) lastId = str_(sh.getRange(mv, 1).getValue());
  } catch (err2) {}
  parts.push(lastId);
  parts.push(str_(PropertiesService.getScriptProperties().getProperty(DATA_VERSION_KEY)));
  return parts.join(':');
}

function rebuildInventory(force) {
  // Nothing has been added to the ledger and nobody has touched the sheet
  // since the last recount, so the answer would be identical. Skip it.
  if (!force) {
    try {
      var want = ledgerStamp_() + '|' + fileTouched_(ss_().getId());
      var had = str_(PropertiesService.getScriptProperties().getProperty(INV_BUILT_KEY));
      if (had && had === want) return;
    } catch (errSkip) { /* if in doubt, do the work */ }
  }
  return rebuildInventoryNow_();
}

function rebuildInventoryNow_() {
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
          // Catalogue first, for the same reason as currentStock_: the ledger
          // holds the name from the day of the movement, and a rename has to
          // show up on the shelf list as well as on the product screen.
          product: (products[sku] ? products[sku].product : '') || str_(m['Product']) || sku,
          content: (products[sku] ? products[sku].content : '') || str_(m['Content']),
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

    // Remember what this recount was built from, captured AFTER the writes so
    // our own edits do not look like somebody else's and trigger another one.
    try {
      PropertiesService.getScriptProperties().setProperty(
        INV_BUILT_KEY, ledgerStamp_() + '|' + fileTouched_(ss_().getId()));
    } catch (errStamp) {}
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
      // Set by hand, when the rule's answer is not the answer. Empty is the
      // normal case and means "work it out".
      webSet: num_(p['Website / pack']),
      webSetPerLb: num_(p['Website / lb']),
      // Anything that landed in the short-lived wholesale columns is the list
      // rate under another name, so it is read as a fallback for the list.
      strayWholesale: num_(p['Wholesale / pack']),
      strayWholesalePerLb: num_(p['Wholesale / lb']),
      // How many are in a pack — 5 patties, 6 smokies. Only means anything
      // for the things that come counted rather than weighed.
      piecesPerPack: num_(p['Pieces / pack']),
      reorder: p['Reorder point'] === '' ? '' : num_(p['Reorder point']),
      active: yes_(p['Active']),
      notes: str_(p['Notes']),
      // Filled in below: a box is anything with a recipe, or anything the
      // catalogue files under the Box category.
      isBox: str_(p['Category']).toLowerCase() === 'box'
    };
  });
  // A recipe is the real proof, so it wins over the category label.
  try {
    var recipes = boxRecipes_();
    Object.keys(recipes).forEach(function (boxSku) {
      if (out[boxSku]) out[boxSku].isBox = true;
    });
  } catch (err) {}
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
/**
 * A sheet set up before a column existed is missing it, and nobody should
 * have to run setup() again to get it. Any header of ours that is not on the
 * row is written onto the end of it; nothing already there is moved, so this
 * is safe to call on every write. Returns the header row as it now stands.
 */
function ensureProductColumns_() {
  var sh = sheet_(TABS.PRODUCTS);
  var width = Math.max(sh.getLastColumn(), HEADERS.PRODUCTS.length);
  var head = sh.getRange(1, 1, 1, width).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var missing = HEADERS.PRODUCTS.filter(function (h) { return head.indexOf(h) === -1; });
  if (!missing.length) return head;
  var at = head.filter(String).length;          // first empty cell on the row
  sh.getRange(1, at + 1, 1, missing.length).setValues([missing])
    .setFontWeight('bold').setBackground('#3c2415').setFontColor('#ffffff');
  missing.forEach(function (h, i) { head[at + i] = h; });
  return head;
}

/* The recipe tab grows the same way the catalogue does: a sheet built before
   the weight columns existed gets them appended, rather than needing setup()
   to be run again over live data. */
/**
 * Columns added to a tab after the sheet was first set up.
 *
 * Everything that writes a whole row writes HEADERS.<TAB>.length cells, so a
 * sheet one column short of the code shifts every value one place left. This
 * puts the missing headings on the end, in the code's order, and leaves
 * anything already there alone.
 */
function ensureHeaders_(tab, headers) {
  var sh = sheet_(tab);
  var width = Math.max(sh.getLastColumn(), headers.length);
  var head = sh.getRange(1, 1, 1, width).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var missing = headers.filter(function (h) { return head.indexOf(h) === -1; });
  if (!missing.length) return head;
  var at = head.filter(String).length;
  sh.getRange(1, at + 1, 1, missing.length).setValues([missing])
    .setFontWeight('bold').setBackground('#3c2415').setFontColor('#ffffff');
  missing.forEach(function (h, i) { head[at + i] = h; });
  return head;
}

/**
 * Both order tabs, checked together.
 *
 * This is the one that bit: 'Weight (lb)', 'Rate' and 'Line total' were added
 * to the code, the values were written into those cells, but the heading row
 * in the sheet still stopped at 'Line note'. Every read by column name came
 * back empty, so an order looked unpriced, the total fell back to the old
 * pack-price estimate, and editing any order wrote blanks over the money on
 * all the others. Nothing complained, because nothing was broken — the
 * columns simply had no names.
 */
function ensureOrderHeaders_() {
  ensureHeaders_(TABS.ORDERS, HEADERS.ORDERS);
  ensureHeaders_(TABS.ORDERITEMS, HEADERS.ORDERITEMS);
}

function ensureBoxColumns_() {
  var sh = sheet_(TABS.BOXES);
  var width = Math.max(sh.getLastColumn(), HEADERS.BOXES.length);
  var head = sh.getRange(1, 1, 1, width).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var missing = HEADERS.BOXES.filter(function (h) { return head.indexOf(h) === -1; });
  if (!missing.length) return head;
  var at = head.filter(String).length;
  sh.getRange(1, at + 1, 1, missing.length).setValues([missing])
    .setFontWeight('bold').setBackground('#3c2415').setFontColor('#ffffff');
  missing.forEach(function (h, i) { head[at + i] = h; });
  return head;
}

function normalizePrices_() {
  var sh = sheet_(TABS.PRODUCTS);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return;

  var head = ensureProductColumns_();
  var cPack = head.indexOf('Price / pack');
  var cLb   = head.indexOf('Price / lb');
  var cKg   = head.indexOf('Price / kg');
  var cWt   = head.indexOf('Avg weight (lb)');
  var cWPack = head.indexOf('Wholesale / pack');
  var cWLb   = head.indexOf('Wholesale / lb');
  if (cPack === -1 || cLb === -1 || cKg === -1) return;
  // Those two columns existed for four days. Wholesale turned out to be the
  // price list itself rather than a second price, so anything typed into them
  // is moved across to the list and the cell emptied — nobody's typing lost,
  // and no second number left behind to disagree with the first.


  var rng = sh.getRange(2, 1, lastRow - 1, head.length);
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

    if (cWLb > -1 && num_(row[cWLb])) {
      if (!lb) { row[cLb] = num_(row[cWLb]); lb = num_(row[cWLb]); }
      row[cWLb] = ''; changed = true;
    }
    if (cWPack > -1 && num_(row[cWPack])) {
      if (!pack) { row[cPack] = num_(row[cWPack]); }
      row[cWPack] = ''; changed = true;
    }
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

/* The same settings minus the ones a phone has no use for. Photo reading
 * happens up here, so the API key never needed to leave the server, and a
 * key sitting in a browser's storage on every staff phone is a key waiting
 * to leak. Same for the API token, which is Kenji's, not the app's. */
var PRIVATE_SETTINGS = ['CLAUDE_API_KEY', 'API_TOKEN'];
function publicSettings_() {
  var all = settings_(), out = {};
  Object.keys(all).forEach(function (k) {
    if (PRIVATE_SETTINGS.indexOf(k) === -1) out[k] = all[k];
  });
  return out;
}

/**
 * Current stock lines straight from the ledger (does not touch the sheet).
 *
 * The ledger keeps the name a product had on the day each movement was
 * written, which is right for history and wrong for a label: rename a
 * product and the freezer list would go on calling it by the old name
 * forever, because no new movement has been written since. So the name and
 * pack contents shown against a line come from the catalogue, which is
 * what "what is this called now" means. A SKU that has since left the
 * catalogue keeps whatever the ledger last called it.
 */
function currentStock_() {
  var moves = readTable_(TABS.MOVEMENTS);
  var catalogue = {};
  try { catalogue = indexProducts_(); } catch (err) { catalogue = {}; }
  var lines = {};
  moves.forEach(function (m) {
    var sku = str_(m['SKU']);
    if (!sku) return;
    var key = [sku, str_(m['Size']), str_(m['Grade']), str_(m['Batch']), str_(m['Freezer'])].join('|');
    if (!lines[key]) {
      lines[key] = {
        key: key, sku: sku,
        product: str_((catalogue[sku] || {}).product) || str_(m['Product']),
        content: str_((catalogue[sku] || {}).content) || str_(m['Content']),
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
      note: str_(r['Line note']),
      weight: num_(r['Weight (lb)']),
      rate: num_(r['Rate']),
      total: num_(r['Line total']),
      promo: str_(r['Promo']).toLowerCase() === 'yes',
      // A price typed over the rule stays typed over it, so that putting the
      // order on another price list leaves it where it was agreed.
      manual: str_(r['Priced by hand']).toLowerCase() === 'yes',
      // Written before orders carried their own money? Then there is nothing
      // to trust and the old estimate is the best there is.
      priced: str_(r['Line total']) !== '' || str_(r['Rate']) !== ''
    });
  });

  return readTable_(TABS.ORDERS).map(function (o) {
    var id = str_(o['Order ID']);
    return {
      id: id,
      customer: str_(o['Customer']),
      contact: str_(o['Contact']),
      phone: str_(o['Phone']),
      deliveryDate: dateStr_(o['Delivery date']),
      time: str_(o['Time']),
      method: str_(o['Method']),
      venue: str_(o['Venue']),
      status: str_(o['Status']) || 'Open',
      notes: str_(o['Notes']),
      calendarEvent: str_(o['Calendar event']),
      created: dateStr_(o['Created']),
      createdBy: str_(o['Created by']),
      packedAt: dateStr_(o['Packed at']),
      deliveredAt: dateStr_(o['Delivered at']),
      channel: orderChannel_(o['Channel']),
      total: num_(o['Value']),
      totalManual: str_(o['Total priced by hand']).toLowerCase() === 'yes',
      paid: str_(o['Paid']).toLowerCase() === 'yes',
      paymentType: str_(o['Payment type']),
      paidAt: dateStr_(o['Paid at']),
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

/**
 * Creates an order. The phone makes the ID so it works with no signal, and
 * re-sending the same ID is how the offline queue avoids doubling an order up.
 *
 * When no ID is supplied — an order typed straight into the calendar screen —
 * the clock alone is not enough: two orders entered in the same second would
 * collide and the second would be silently swallowed by the first. So a short
 * random tail goes on the end.
 */
function orderNew_(op, products) {
  var id = str_(op.orderId);
  if (!id) {
    // No ID supplied, so make one that is certainly free rather than trusting
    // the clock: two orders typed in the same second would otherwise collide,
    // and the second would be swallowed by the idempotency check below.
    var stamp = 'ORD-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
    id = stamp;
    var bump = 2;
    while (orderRowIndex_(id) !== -1) id = stamp + '-' + (bump++);
  } else if (orderRowIndex_(id) !== -1) {
    return { ok: true, orderId: id };          // the queue re-sent one we have
  }

  var customer = str_(op.customer);
  if (!customer) return { error: 'An order needs a customer name.' };
  var lines = orderLines_(op.lines);
  if (!lines.length) return { error: 'Order for ' + customer + ' had no items.' };

  // Priced here, once, and kept. The price list will move; this order must not.
  var money = priceOrderLines_(lines, op.channel, products, settings_());

  ensureOrderHeaders_();
  var agreed = orderTotal_(op, money);
  sheet_(TABS.ORDERS).appendRow([
    id, customer, str_(op.contact), str_(op.deliveryDate), str_(op.method) || 'Pickup',
    'Open', '', '', agreed.total, str_(op.notes), new Date(), str_(op.user), '', '',
    str_(op.phone), str_(op.time), str_(op.venue), '', money.channel,
    '', '', '', agreed.manual ? 'yes' : ''
  ]);

  var itemRows = money.lines.map(function (l) {
    return [id, l.sku, l.product, l.content, l.packages, '', l.note,
            l.weight, l.rate, l.total, l.promo ? 'yes' : '', l.manual ? 'yes' : ''];
  });
  var sh = sheet_(TABS.ORDERITEMS);
  sh.getRange(sh.getLastRow() + 1, 1, itemRows.length, HEADERS.ORDERITEMS.length).setValues(itemRows);
  return { ok: true, orderId: id, total: money.total };
}

/**
 * Where a pack goes when it comes back off an order.
 *
 * An assembled order took its meat off the shelf oldest-lot-first; putting
 * it back has to choose a lot, and the oldest one still holding that cut is
 * the closest thing to where it came from. If there is none left — the order
 * cleared the last of it — the default freezer is used rather than nothing,
 * because a pack with no freezer on it starts a second lot called Unassigned
 * and that is how a freezer ends up with phantom lines in it.
 */
function putBackLot_(sku, stock, cfg) {
  var best = null;
  (stock || []).forEach(function (l) {
    if (str_(l.sku) !== str_(sku) || num_(l.packages) <= 0) return;
    if (!best || String(l.firstIn || '') < String(best.firstIn || '')) best = l;
  });
  if (best) {
    return { freezer: best.freezer, batch: best.batch, grade: best.grade, size: best.size };
  }
  return { freezer: str_((cfg || {}).DEFAULT_FREEZER), batch: '', grade: '', size: '' };
}

/**
 * The stock movements that take an assembled order from what it held to what
 * it now holds.
 *
 * An order that has been assembled has already taken its meat off the shelf.
 * Changing it afterwards is an ordinary thing to need — the customer wants
 * one more, or a steak came up light — and the ledger has to follow: what is
 * added comes off the shelf, what is dropped goes back on it, and changing
 * only a weight or a price moves nothing at all.
 */
function orderPackedDelta_(id, was, now, order, products, stock, allowNegative, warnings, op, cfg) {
  var before = {}, after = {};
  (was || []).forEach(function (i) {
    if (!str_(i.sku) || !products[str_(i.sku)]) return;
    before[i.sku] = (before[i.sku] || 0) + num_(i.packed || i.packages);
  });
  (now || []).forEach(function (l) {
    if (!str_(l.sku) || !products[str_(l.sku)]) return;
    after[str_(l.sku)] = (after[str_(l.sku)] || 0) + num_(l.packages);
  });

  var skus = {};
  Object.keys(before).forEach(function (k) { skus[k] = true; });
  Object.keys(after).forEach(function (k) { skus[k] = true; });

  var rows = [];
  Object.keys(skus).forEach(function (sku) {
    var delta = round3_((after[sku] || 0) - (before[sku] || 0));
    if (!delta) return;
    var p = products[sku] || {};
    var sub;
    if (delta > 0) {
      // More on the order than was assembled: the extra comes off the shelf.
      sub = { type: 'SALE', sku: sku, product: p.product, content: p.content,
              packages: delta, party: order.customer,
              note: 'Order ' + id + ' changed after assembling',
              clientKey: str_(op.clientKey) + ':+' + sku };
    } else {
      // Fewer than were assembled: the difference goes back where it came from.
      var where = putBackLot_(sku, stock, cfg);
      sub = { type: 'ADJUST', sku: sku, product: p.product, content: p.content,
              size: where.size, grade: where.grade, batch: where.batch, freezer: where.freezer,
              packages: -delta, party: 'Order changed — put back',
              note: 'Order ' + id + ' changed after assembling',
              clientKey: str_(op.clientKey) + ':-' + sku };
    }
    sub.user = str_(op.user);
    sub.timestamp = op.timestamp;
    var res = expandOp_(sub, products, stock, allowNegative, warnings);
    if (res.error) { warnings.push(res.error); return; }
    res.rows.forEach(function (r) { rows.push(r); });
  });
  return rows;
}

/**
 * Changes an order that has not gone out yet: who it is for, when, how, and
 * what is on it.
 *
 * Only an Open order. Once an order is packed its stock has already come off
 * the shelf against the lines as they were, and quietly rewriting those lines
 * would leave the ledger describing an order that never existed. Packed and
 * delivered orders stay as they are; a mistake there is fixed with a count,
 * which leaves a trail.
 *
 * The lines sent are the whole order, not a change to it — the phone edits a
 * copy of the order and sends it back entire — so this replaces every item
 * row for this order and leaves every other order's rows alone. That also
 * makes it safe to replay: applying "the order is now this" twice lands in
 * the same place, which matters because it writes no ledger row for the
 * usual client-key check to recognise.
 */
/**
 * What an order comes to.
 *
 * Normally the lines added up. Sometimes a number somebody agreed out loud —
 * "the lot for $200" — which is kept as it was said. The lines keep their own
 * prices either way, so the freezer and the margin still work out; only the
 * figure at the bottom is the agreed one.
 */
function orderTotal_(op, money) {
  var byHand = op.totalManual === true || str_(op.totalManual).toLowerCase() === 'yes';
  if (!byHand) return { total: money.total, manual: false };
  return { total: Math.round(num_(op.total) * 100) / 100, manual: true };
}

function orderEdit_(op, products, stock, allowNegative, warnings) {
  var id = str_(op.orderId);
  /* Before a single value is READ. A sheet whose header row is short of the
     code cannot be read by column name, so the weight, the rate and the line
     total come back as nothing — and this function then writes that nothing
     back over every other order's money. Repair the headings first. */
  ensureOrderHeaders_();
  var row = orderRowIndex_(id);
  if (row === -1) return { error: 'Order ' + id + ' was not found.' };

  var sh = sheet_(TABS.ORDERS);
  var status = str_(sh.getRange(row, 6).getValue()) || 'Open';
  if (status === 'Cancelled') {
    return { error: 'That order was cancelled. Write a new one rather than reviving it.' };
  }
  if (status === 'Delivered') {
    return { error: 'That order has gone out. Its stock and its money are settled, ' +
                    'so a change now would rewrite history — fix it with a count instead.' };
  }
  var wasPacked = status === 'Packed';
  var before = wasPacked
    ? (readOrders_().filter(function (o) { return o.id === id; })[0] || { items: [] }).items
    : [];

  var customer = str_(op.customer);
  if (!customer) return { error: 'An order needs a customer name.' };
  var lines = orderLines_(op.lines);
  if (!lines.length) return { error: 'An order needs at least one item.' };

  sh.getRange(row, 2).setValue(customer);
  if (op.contact !== undefined && op.contact !== null) sh.getRange(row, 3).setValue(str_(op.contact));
  if (op.deliveryDate !== undefined && op.deliveryDate !== null) sh.getRange(row, 4).setValue(str_(op.deliveryDate));
  if (op.method) sh.getRange(row, 5).setValue(str_(op.method));
  if (op.notes !== undefined && op.notes !== null) sh.getRange(row, 10).setValue(str_(op.notes));

  // Everyone else's lines, untouched, then this order's as they now stand.
  var money = priceOrderLines_(lines, op.channel === undefined
    ? sh.getRange(row, 19).getValue() : op.channel, products, settings_());
  var agreed = orderTotal_(op, money);
  sh.getRange(row, 9).setValue(agreed.total);
  sh.getRange(row, 19).setValue(money.channel);
  sh.getRange(row, 23).setValue(agreed.manual ? 'yes' : '');

  var keep = readTable_(TABS.ORDERITEMS)
    .filter(function (r) { return str_(r['Order ID']) !== id; })
    .map(function (r) {
      return [str_(r['Order ID']), str_(r['SKU']), str_(r['Product']), str_(r['Content']),
              num_(r['Packages']), r['Packed'] === '' ? '' : num_(r['Packed']), str_(r['Line note']),
              r['Weight (lb)'] === '' ? '' : num_(r['Weight (lb)']),
              r['Rate'] === '' ? '' : num_(r['Rate']),
              r['Line total'] === '' ? '' : num_(r['Line total']),
              str_(r['Promo']), str_(r['Priced by hand'])];
    });
  // An order that is already assembled stays assembled: the packed count on
  // each line is what the order now says, and the difference against what it
  // held is settled on the shelf below.
  var mine = money.lines.map(function (l) {
    return [id, l.sku, l.product, l.content, l.packages, wasPacked ? l.packages : '', l.note,
            l.weight, l.rate, l.total, l.promo ? 'yes' : '', l.manual ? 'yes' : ''];
  });
  writeTable_(TABS.ORDERITEMS, HEADERS.ORDERITEMS, keep.concat(mine));

  var rows = [];
  if (wasPacked) {
    rows = orderPackedDelta_(id, before, money.lines,
      { customer: customer }, products, stock, allowNegative, warnings, op, settings_());
  }

  // The date or the name may have moved, so the calendar entry moves with it.
  calendarPushOne_(id);
  return { ok: true, orderId: id, rows: rows };
}

/** Sets an order's status, delivery date or notes. */
function orderStatus_(op, products, stock, allowNegative, warnings) {
  var id = str_(op.orderId);
  var row = orderRowIndex_(id);
  if (row === -1) return { error: 'Order ' + id + ' was not found.' };
  var sh = sheet_(TABS.ORDERS);
  var rows = [];

  if (op.status) {
    var status = str_(op.status);
    if (ORDER_STATUSES.indexOf(status) === -1) return { error: 'Unknown order status: ' + status };
    var was = str_(sh.getRange(row, 6).getValue()) || 'Open';

    /* Cancelling an order that was already assembled has to put the meat
       back. It came off the shelf when the order was packed; if it only
       changed a word in a cell the freezer would be short by exactly one
       cancelled order, and nothing on the screen would say why. */
    if (status === 'Cancelled' && was === 'Packed' && products) {
      var o = readOrders_().filter(function (x) { return x.id === id; })[0];
      if (o) {
        rows = orderPackedDelta_(id, o.items, [], { customer: o.customer },
          products, stock, allowNegative, warnings,
          { clientKey: str_(op.clientKey) + ':cancel', user: str_(op.user),
            timestamp: op.timestamp }, settings_());
      }
      // The lines keep what they say they held; the order is what changed.
    }

    sh.getRange(row, 6).setValue(status);
    if (status === 'Delivered') sh.getRange(row, 14).setValue(new Date());
  }
  // Settling up. Paid is set on its own, after delivery as often as with it.
  if (op.paid !== undefined && op.paid !== null) {
    var isPaid = op.paid === true || str_(op.paid).toLowerCase() === 'yes';
    sh.getRange(row, 20).setValue(isPaid ? 'yes' : '');
    sh.getRange(row, 22).setValue(isPaid ? new Date() : '');
    if (!isPaid) sh.getRange(row, 21).setValue('');
  }
  if (op.paymentType !== undefined && op.paymentType !== null) {
    sh.getRange(row, 21).setValue(str_(op.paymentType));
  }
  /* A settled sale goes into the 2026 sales sheet as well, which is the
     book the business actually keeps. It carries the order ID, so reading
     the book back does not count it a second time. Never allowed to fail
     the operation: the order is paid whether or not the other file was
     reachable at that moment. */
  if (op.paid !== undefined && op.paid !== null) {
    try {
      var settled = readOrders_().filter(function (x) { return x.id === id; })[0];
      if (settled && settled.paid) {
        settled.paidBy = str_(op.user);
        salesBookWrite_(settled);
      }
    } catch (errBook) { warnings && warnings.push('Sale saved, but the sales sheet did not take it: ' + errBook.message); }
  }
  if (op.deliveryDate !== undefined && op.deliveryDate !== null) sh.getRange(row, 4).setValue(str_(op.deliveryDate));
  if (op.method) sh.getRange(row, 5).setValue(str_(op.method));
  if (op.notes !== undefined && op.notes !== null) sh.getRange(row, 10).setValue(str_(op.notes));
  if (op.phone !== undefined && op.phone !== null) sh.getRange(row, 15).setValue(str_(op.phone));
  if (op.time  !== undefined && op.time  !== null) sh.getRange(row, 16).setValue(str_(op.time));
  if (op.venue !== undefined && op.venue !== null) sh.getRange(row, 17).setValue(str_(op.venue));
  if (op.contact !== undefined && op.contact !== null) sh.getRange(row, 3).setValue(str_(op.contact));

  // Anything that moves a drop-off has to move the calendar entry with it.
  calendarPushOne_(id);
  return { ok: true, orderId: id, rows: rows };
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
    // Nothing in the catalogue, nothing in the freezer: a jar of jam or a
    // delivery charge rides along on the order and moves no stock.
    if (!str_(item.sku) || !products[str_(item.sku)]) return;
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
      if (!str_(i.sku)) return;         // not from the freezer, not promised from it
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
    /* An order that was priced when it was written keeps those numbers: the
       weight on the scale, the rate off the chosen price list, the giveaways
       at nothing. Re-estimating it from today's catalogue would quietly
       restate a quote that has already gone to a customer. Only an order
       from before orders carried their own money gets the old estimate. */
    var ordered = 0, packed = 0, value = 0, priced = false;
    o.items.forEach(function (it) {
      ordered += it.packages;
      packed += it.packed;
      if (it.priced) priced = true;
    });
    if (priced) {
      o.items.forEach(function (it) { value += num_(it.total); });
    } else {
      o.items.forEach(function (it) {
        var p = products[it.sku] || {};
        var per = num_(p.price) || (num_(p.pricePerLb) * num_(p.avgWeight));
        value += per * it.packages;
      });
    }
    r[6] = ordered;
    r[7] = packed;
    // A total somebody agreed is not recomputed. That is the whole point of
    // it: the lines say what the meat is worth, this says what was said.
    if (!o.totalManual) r[8] = Math.round(value * 100) / 100;
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
      sku: part, product: str_(r['Component']), qty: num_(r['Packages per box']) || 1,
      each: num_(r['Weight each (lb)']),          // one piece, as this box packs it
      inBox: num_(r['Weight in the box (lb)'])    // the line's total, when pieces are not counted
    });
  });
  return out;
}

/* Boxes for the app's Boxes list: contents, what they weigh, what they cost
 * to fill, and what we sell them for. The gap between the last two is the bit
 * worth looking at — the Camping Pack sells at exactly component cost. */
function boxesForApp_() {
  var recipes = boxRecipes_();
  var products = indexProducts_();
  var onHand = {};
  var stockAll = currentStock_();
  stockAll.forEach(function (l) { onHand[l.sku] = (onHand[l.sku] || 0) + l.packages; });

  var skus = {};
  Object.keys(recipes).forEach(function (k) { skus[k] = true; });
  Object.keys(products).forEach(function (k) { if (products[k].isBox) skus[k] = true; });

  var cfg = settings_();

  return Object.keys(skus).map(function (box) {
    var p = products[box] || {};
    var parts = (recipes[box] || []).map(function (c) {
      var cp = products[c.sku] || {};
      /* The weight the BOX packs, when it is known, before the cut's own
         general average. A ribeye is 14 oz in Best of Both Worlds and 11 oz
         in Dinner for Two; one number on the cut cannot be both. */
      var each = num_(c.each) || num_(cp.avgWeight);
      var lineWeight = each ? each * c.qty : num_(c.inBox);
      /* What one of these is worth at WHOLESALE — the price list as written,
         which is the only honest base to judge a box price against.
         This used to read the Price / pack column alone. A ribeye is sold by
         the pound, so that column is empty for it, and a box of ribeye and
         tenderloin came to nothing at all: "Price list (contents)" showed
         zero, and the gap against the box price was meaningless. Pack-priced
         things (sausage, smokies) still use their pack price; everything else
         is its average weight at the wholesale rate a pound. */
      var ch = channelPrices_(cp, cfg);
      /* Weigh anything with a price a pound; fall back to the pack price for
         sausage, smokies and the like. Note the order: channelPrices_ hands
         back a per-pack figure for a pound-priced cut too (its average weight
         at the pound rate), and taking that first threw away the box's own
         weight — every ribeye came out at the cut's average however the box
         packs it. */
      /* Most specific fact wins. When the RECIPE says what this line weighs —
         a ribeye is 14 oz in Best of Both Worlds and 11 oz in Dinner for Two
         — weigh it at the pound rate; that is the whole point of writing the
         weight on the box. Otherwise fall back to the catalogue's pack price,
         which is what a pack-priced thing (sausage, smokies, ground) has and
         what a pound-priced cut gets derived from its own average anyway.
         Deciding on the pack column alone looked right and was not: the sheet
         back-fills a pack price for any cut with an average weight, so the
         box's own weight was quietly thrown away the moment Paul filled one
         in. */
      var perLb = num_(ch.wholesalePerLb);
      var perPack = num_(ch.wholesalePerPack);
      var boxSaysWeight = num_(c.each) || num_(c.inBox);
      var value = boxSaysWeight
        ? (perLb ? perLb * lineWeight : perPack * c.qty)
        : (perPack ? perPack * c.qty : (perLb * lineWeight || 0));
      return {
        sku: c.sku,
        product: c.product || cp.product || c.sku,
        content: str_(cp.content),
        qty: c.qty,
        each: Math.round(each * 100) / 100,          // one piece, as this box packs it
        inBox: Math.round(num_(c.inBox) * 100) / 100,// the line total, when pieces are uncounted
        weight: lineWeight,
        price: Math.round(value * 100) / 100,
        // Nothing to price it with: no pack price, and no weight to put
        // against the pound rate. Worth saying out loud — three smokies
        // coming to nothing made the Camping Pack read $56 instead of its
        // real contents, and the total looked perfectly confident about it.
        unpriced: !value && c.qty > 0,
        free: Math.round(((onHand[c.sku] || 0)) * 100) / 100
      };
    });
    var weight = parts.reduce(function (t, c) { return t + c.weight; }, 0);
    var unpriced = parts.filter(function (c) { return c.unpriced; });
    // The base: what the cuts inside come to at wholesale. The website and
    // market prices are this marked up, per the rule in the pricing workbook,
    // so showing all three together is what makes a box that sells under its
    // own contents visible instead of hidden.
    var partsValue = parts.reduce(function (t, c) { return t + c.price; }, 0);
    var webPct = pctOf_(cfg.WEBSITE_MARKUP, 30);
    var mktPct = pctOf_(cfg.MARKET_MARKUP, 15);

    // Processed meat goes in at list price; only the rest carries the markup.
    var flat = 0, markupable = 0;
    parts.forEach(function (c) {
      if (noMarkup_(products[c.sku], cfg)) flat += c.price;
      else markupable += c.price;
    });
    var allFlat = partsValue > 0 && markupable === 0;
    return {
      sku: box,
      product: p.product || box,
      content: str_(p.content),
      active: p.active !== false,
      onHand: Math.round((onHand[box] || 0) * 100) / 100,
      // Which freezer the made-up ones are in, so the list can say without
      // being opened.
      freezers: (function () {
        var by = {};
        stockAll.forEach(function (l) {
          if (l.sku !== box || num_(l.packages) <= 0) return;
          by[str_(l.freezer)] = (by[str_(l.freezer)] || 0) + num_(l.packages);
        });
        return Object.keys(by).map(function (f) { return { id: f, n: by[f] }; });
      })(),
      packs: parts.reduce(function (t, c) { return t + c.qty; }, 0),
      weight: Math.round(weight * 100) / 100,
      price: num_(p.price),
      marketPrice: num_(p.marketPrice),
      // The price list base, and what the markup rule would make of it.
      listPrice: Math.round(partsValue * 100) / 100,
      partsValue: Math.round(partsValue * 100) / 100,
      // What the contents figure is missing, by name.
      unpriced: unpriced.map(function (c) { return c.product; }),
      suggestedWeb: !partsValue ? 0
        : (allFlat ? Math.round(flat * 100) / 100
                   : round59_(markupable * (1 + webPct / 100) + flat)),
      suggestedMarket: !partsValue ? 0
        : (allFlat ? Math.round(flat * 100) / 100
                   : round59_(markupable * (1 + mktPct / 100) + flat)),
      // How much of the box is sold at list price with no markup, so the app
      // can say why a box with little or no margin is not necessarily wrong.
      flatValue: Math.round(flat * 100) / 100,
      allFlat: allFlat,
      webMarkupPct: webPct,
      marketMarkupPct: mktPct,
      parts: parts
    };
  }).sort(function (a, b) { return String(a.product).localeCompare(String(b.product)); });
}

/* Create a box and its recipe in one go, from the app. */
function addBox_(req) {
  var name = str_(req.product);
  if (!name) return { ok: false, error: 'A box needs a name.' };
  var parts = req.parts || [];
  if (!parts.length) return { ok: false, error: 'A box needs at least one cut in it.' };

  var made = addProduct_({
    product: name, category: 'Box', content: str_(req.content),
    price: req.price, marketPrice: req.marketPrice,
    reorder: req.reorder, notes: str_(req.notes)
  });
  if (!made.ok) return made;

  var put = setBoxParts_({ boxSku: made.sku, parts: parts });
  if (!put.ok) return put;
  return { ok: true, sku: made.sku, boxes: boxesForApp_(),
           products: put.products };
}

/* Replace a box's contents. Writing the whole recipe rather than patching
 * rows means a box edited from two phones ends up as one of the two, never a
 * blend of both. */
function setBoxParts_(req) {
  var box = str_(req.boxSku);
  if (!box) return { ok: false, error: 'Which box?' };
  var products = indexProducts_();
  if (!products[box]) return { ok: false, error: box + ' is not in the catalogue.' };

  var clean = [];
  (req.parts || []).forEach(function (c) {
    var sku = str_(c.sku);
    var qty = num_(c.qty) || 0;
    if (!sku || qty <= 0) return;
    if (sku === box) return;                      // a box cannot contain itself
    if (!products[sku]) return;
    clean.push([box, products[box].product, sku, products[sku].product, qty, str_(c.notes),
                num_(c.each) || '', num_(c.inBox) || '']);
  });
  if (!clean.length) return { ok: false, error: 'None of those cuts were recognised.' };

  ensureBoxColumns_();
  var rows = readTable_(TABS.BOXES);
  var keep = [];
  rows.forEach(function (r) {
    if (str_(r['Box SKU']) === box) return;       // drop this box's old rows
    keep.push([str_(r['Box SKU']), str_(r['Box']), str_(r['Component SKU']),
               str_(r['Component']), num_(r['Packages per box']), str_(r['Notes']),
               num_(r['Weight each (lb)']) || '', num_(r['Weight in the box (lb)']) || '']);
  });
  writeTable_(TABS.BOXES, HEADERS.BOXES, keep.concat(clean));

  var all = indexProducts_();
  return { ok: true, boxes: boxesForApp_(),
           products: Object.keys(all).map(function (k) { return all[k]; }) };
}

/**
 * What is sitting inside the boxes that are already made up, cut by cut.
 *
 * Building a box takes its cuts off the shelf, so the Cuts list shows only
 * what is loose — and standing at the freezer you cannot tell whether the
 * last ribeye is really the last one or whether there are twenty more inside
 * boxes a metre away. This says, for each cut: which boxes hold it, how many
 * are built, which freezer they are in, and how many packs that comes to.
 *
 * It is for knowing, not for counting. These packs are NOT part of the cut's
 * stock — they left it when the box was built — and nothing here can be added
 * to or taken away. Breaking a box is what brings them back.
 */
function boxedBySku_() {
  var recipes = boxRecipes_();
  var products = indexProducts_();

  // Boxes on the shelf, by box and by freezer.
  var byBox = {};
  currentStock_().forEach(function (l) {
    if (!recipes[l.sku] || num_(l.packages) <= 0) return;
    var b = byBox[l.sku] || (byBox[l.sku] = { built: 0, freezers: {} });
    b.built += num_(l.packages);
    var f = str_(l.freezer);
    b.freezers[f] = (b.freezers[f] || 0) + num_(l.packages);
  });

  var out = {};
  Object.keys(byBox).forEach(function (boxSku) {
    var b = byBox[boxSku];
    (recipes[boxSku] || []).forEach(function (c) {
      var packs = num_(c.qty) * b.built;
      if (!packs) return;
      (out[c.sku] || (out[c.sku] = [])).push({
        sku: boxSku,
        product: (products[boxSku] || {}).product || boxSku,
        built: Math.round(b.built * 100) / 100,
        each: num_(c.qty),
        packs: Math.round(packs * 100) / 100,
        freezers: Object.keys(b.freezers).map(function (f) {
          return { id: f, n: Math.round(b.freezers[f] * 100) / 100 };
        })
      });
    });
  });

  // Most-held first, so the box worth breaking is the one at the top.
  Object.keys(out).forEach(function (sku) {
    out[sku].sort(function (x, y) { return y.packs - x.packs; });
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
function buildBoxOps_(op, stock) {
  var box = str_(op.boxSku);
  var count = Math.abs(num_(op.count)) || 1;
  var breaking = str_(op.type).toUpperCase() === 'BREAK_BOX';
  var recipe = boxRecipes_()[box];
  if (!recipe) return { error: 'No recipe for ' + box + ' on the BOX RECIPES tab.' };

  // You cannot take apart boxes that are not there. Without this the box
  // count went negative and the recipe's cuts were conjured onto the shelf —
  // a mistake that looks like stock and is very hard to spot later.
  if (breaking && stock) {
    var have = 0;
    stock.forEach(function (l) { if (l.sku === box) have += num_(l.packages); });
    if (count > have) {
      return { error: have
        ? 'Only ' + have + ' × ' + box + ' made up — cannot take ' + count + ' apart.'
        : 'There are no ' + box + ' made up to take apart.' };
    }
  }

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

/* ========================= THE FREEZER SENSORS =========================
 *
 * Six freezers with a Govee thermometer in each. The Govee app shows the
 * reading live on a phone; this reads the same thing from their cloud once a
 * day, writes it down, and says something if a freezer is warming up, has
 * gone off the air, or is running out of battery.
 *
 * It only reaches a sensor that talks to Govee's cloud — a Wi-Fi model, or a
 * Bluetooth one paired to a Govee gateway. A Bluetooth-only sensor that
 * reads when a phone is stood next to it cannot be read from here at all,
 * and nothing in this file can change that.
 *
 * Nothing happens until an API key is on the SETTINGS tab. Without one this
 * is all inert — no calls, no rows, no alerts.
 */

var GOVEE_KEY_SETTING   = 'GOVEE_API_KEY';
var GOVEE_WARM_SETTING  = 'FREEZER_WARM';
var GOVEE_HOT_SETTING   = 'FREEZER_TOO_WARM';
var GOVEE_BATT_SETTING  = 'FREEZER_BATTERY_PCT';
var GOVEE_UNIT_SETTING  = 'FREEZER_UNIT';
var GOVEE_SENDS_SETTING = 'GOVEE_SENDS';

/* −18°C is where frozen storage is kept. A chest freezer with its lid open
   while somebody packs an order reads warmer than that and is in no trouble
   at all, so the lines are set well clear of it: −12°C is worth a look,
   −7°C is meat starting to soften. Both are read in whatever FREEZER_UNIT
   says, and both are checked twice before anything is said out loud.

   Measured 2026-10-26, the six freezers sat between −22°C and −15.5°C, so
   −12°C leaves the warmest of them three and a half degrees of room before
   it says anything. */
var GOVEE_WARM_C_DEFAULT = -12;
var GOVEE_HOT_C_DEFAULT  = -7;
var GOVEE_BATT_DEFAULT = 20;

/* What Govee's own numbers are in.
   Checked against the live account on 2026-10-26: the six H5100 sensors
   reported between −7.6 and 4.1, which is −22°C to −15.5°C in Fahrenheit and
   a row of thawing freezers in Celsius. So Fahrenheit. This setting exists
   so that if Govee ever changes it, there is one cell to fix rather than a
   hunt through the code. */
var GOVEE_SENDS_DEFAULT = 'F';

var GOVEE_HOST = 'https://openapi.api.govee.com';

function goveeKey_(cfg) { return str_((cfg || settings_())[GOVEE_KEY_SETTING]); }

function fToC_(f) { return Math.round(((num_(f) - 32) * 5 / 9) * 10) / 10; }
function cToF_(c) { return Math.round((num_(c) * 9 / 5 + 32) * 10) / 10; }

/** One call to Govee, with the key on it. Never throws. */
function goveeCall_(path, payload, key) {
  var opts = {
    method: payload ? 'post' : 'get',
    contentType: 'application/json',
    headers: { 'Govee-API-Key': key },
    muteHttpExceptions: true
  };
  if (payload) opts.payload = JSON.stringify(payload);
  try {
    var res = UrlFetchApp.fetch(GOVEE_HOST + path, opts);
    var code = res.getResponseCode();
    var text = res.getContentText();
    if (code !== 200) return { ok: false, code: code, why: goveeWhy_(code, text) };
    return { ok: true, body: JSON.parse(text) };
  } catch (err) {
    return { ok: false, code: 0, why: 'Govee could not be reached: ' + err.message };
  }
}

function goveeWhy_(code, text) {
  if (code === 401) return 'Govee refused the API key. Check ' + GOVEE_KEY_SETTING +
                           ' on the SETTINGS tab.';
  if (code === 429) return 'Govee asked us to slow down. It will try again tomorrow.';
  var msg = '';
  try { msg = str_(JSON.parse(text).message || JSON.parse(text).msg); } catch (e) {}
  return 'Govee answered ' + code + (msg ? ': ' + msg : '.');
}

/** Every sensor on the account. */
function goveeDevices_(key) {
  var r = goveeCall_('/router/api/v1/user/devices', null, key);
  if (!r.ok) return r;
  var list = [];
  ((r.body || {}).data || []).forEach(function (d) {
    list.push({ sku: str_(d.sku), device: str_(d.device),
                name: str_(d.deviceName) || str_(d.sku) });
  });
  return { ok: true, devices: list };
}

/**
 * What one sensor says right now.
 *
 * Govee hands back a list of capabilities rather than named fields, so this
 * walks them and picks out the four that matter. Anything it does not
 * recognise is ignored rather than guessed at.
 */
function goveeState_(sku, device, key) {
  var r = goveeCall_('/router/api/v1/device/state',
    { requestId: Utilities.getUuid(), payload: { sku: sku, device: device } }, key);
  if (!r.ok) return r;
  var caps = (((r.body || {}).payload) || {}).capabilities || [];
  var out = { tempF: null, humidity: null, battery: null, online: null };
  caps.forEach(function (c) {
    var inst = str_(c.instance);
    var v = (c.state || {}).value;
    if (str_(c.type) === 'devices.capabilities.online' || inst === 'online') {
      out.online = v === true || str_(v).toLowerCase() === 'true';
      return;
    }
    if (v === null || v === undefined || v === '') return;
    if (inst === 'sensorTemperature') out.tempF = goveeToF_(v);
    else if (inst === 'sensorHumidity') out.humidity = num_(v);
    else if (inst === 'battery' || inst === 'batteryLevel') out.battery = num_(v);
  });
  return { ok: true, state: out };
}

/**
 * Which freezer a sensor is in.
 *
 * The FREEZERS tab gets a 'Govee device' column: paste the sensor's ID (or
 * the name it has in the Govee app) beside the freezer it lives in. If it is
 * left blank, a sensor whose Govee name matches the freezer's name is taken
 * to be that freezer's, which covers the common case of naming them the same.
 */
function goveeFreezerMap_() {
  ensureHeaders_(TABS.FREEZERS, HEADERS.FREEZERS);
  var byDevice = {}, byName = {};
  readTable_(TABS.FREEZERS).forEach(function (r) {
    var id = str_(r['Freezer ID']);
    if (!id) return;
    var nm = str_(r['Name']) || id;
    var said = str_(r['Govee device']);
    if (said) byDevice[said.toLowerCase()] = { id: id, name: nm };
    byName[nm.toLowerCase()] = { id: id, name: nm };
    byName[id.toLowerCase()] = { id: id, name: nm };
  });
  return { byDevice: byDevice, byName: byName };
}

function goveeFreezerFor_(dev, map) {
  var hit = map.byDevice[str_(dev.device).toLowerCase()] ||
            map.byDevice[str_(dev.name).toLowerCase()] ||
            map.byName[str_(dev.name).toLowerCase()];
  return hit || null;
}

/**
 * Read every sensor once.
 *
 * Returns one entry per sensor whether or not it answered, because a sensor
 * that did not answer is the thing most worth knowing about.
 */
function goveeReadAll_(key) {
  var found = goveeDevices_(key);
  if (!found.ok) return found;
  var map = goveeFreezerMap_();
  var out = [];
  found.devices.forEach(function (d) {
    var st = goveeState_(d.sku, d.device, key);
    var fz = goveeFreezerFor_(d, map);
    out.push({
      sku: d.sku, device: d.device, name: d.name,
      freezer: fz ? fz.id : '', freezerName: fz ? fz.name : '',
      ok: !!st.ok,
      why: st.ok ? '' : str_(st.why),
      tempF: st.ok ? st.state.tempF : null,
      humidity: st.ok ? st.state.humidity : null,
      battery: st.ok ? st.state.battery : null,
      online: st.ok ? st.state.online : false
    });
  });
  return { ok: true, readings: out };
}

/* ===================== WATCHING THE FREEZERS =====================
 *
 * Once a day: read every sensor, write the readings down, and raise
 * something if a freezer is warming up, has gone off the air, or is running
 * out of battery.
 *
 * A reading is never raised on its own. A lid left open while somebody fills
 * an order reads warm and means nothing, so anything that looks wrong is
 * read again a couple of minutes later and only said out loud if it is still
 * wrong both times. The cost of being wrong here is a banner nobody trusts.
 */

var FREEZER_CONFIRM_WAIT = 90 * 1000;      // how long to wait before looking again

/* How often the freezers are read.
 *
 * Govee's API has no history in it — it answers with the reading at the
 * moment you ask and nothing else — so the log is only as good as how often
 * this asks. Once a day is one instant out of twenty-four hours: a freezer
 * that failed at nine and was noticed and shut properly at four would leave
 * nothing behind at all. Hourly makes a day's min, max and average mean
 * something, and makes the record worth showing somebody. */
var FREEZER_EVERY_SETTING = 'FREEZER_CHECK_HOURS';
var FREEZER_EVERY_DEFAULT = 1;

/* A reading identical to the ones before it for this long is a stopped
   sensor, not a steady freezer. Said in hours rather than in readings so it
   means the same thing whatever the interval above is set to. */
var FREEZER_STUCK_SETTING = 'FREEZER_STUCK_HOURS';
var FREEZER_STUCK_DEFAULT = 6;

/* How a row got onto the log.
 *
 * The sweep writes this one. A reading typed in from a screenshot of the
 * Govee app carries the name of the screenshot instead — 'Govee app
 * screenshot 2026-02-20', say — and is counted separately everywhere it
 * matters. The temptation with a thin record is to pad it with whatever can
 * be found and let the column look full; a spot check somebody read off a
 * phone once a month is worth having and is not the same evidence as an
 * hourly machine reading, and a record that cannot tell you which is which
 * is worth less than one that admits where it is thin. */
var FREEZER_SOURCE_AUTO = 'Govee API';

/** Was this row written by the sweep rather than copied in by hand? */
function freezerAuto_(source) {
  var s = str_(source);
  // Rows written before this column existed were all the sweep's.
  return s === '' || s === FREEZER_SOURCE_AUTO;
}

function freezerEveryHours_(cfg) {
  var v = (cfg || settings_())[FREEZER_EVERY_SETTING];
  var n = num_(v);
  return n >= 1 ? Math.min(Math.round(n), 24) : FREEZER_EVERY_DEFAULT;
}

/**
 * The last few rows of the log, without reading the whole thing.
 *
 * At hourly, six freezers put fifty thousand rows a year on this tab, and
 * every phone sync asks it what the freezers last read. Reading the lot each
 * time would make the app slower every week it ran.
 */
function freezerLogTail_(howManyRows) {
  var sh;
  try { sh = sheet_(TABS.FREEZERLOG); } catch (err) { return []; }
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var want = Math.max(1, num_(howManyRows) || 200);
  var from = Math.max(2, lastRow - want + 1);
  var head = sh.getRange(1, 1, 1, HEADERS.FREEZERLOG.length).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var vals = sh.getRange(from, 1, lastRow - from + 1, HEADERS.FREEZERLOG.length).getValues();
  return vals.map(function (row) {
    var o = {};
    head.forEach(function (h, i) { if (h) o[h] = row[i]; });
    return o;
  }).filter(function (o) { return str_(o['When']) || str_(o['Freezer']); });
}

/**
 * The lines, and which way round everything is written.
 *
 * The thresholds on the SETTINGS tab are written in whatever unit the app is
 * set to show — type −12 with FREEZER_UNIT on C and it means −12°C. Inside,
 * everything is Fahrenheit, because that is what Govee sends; the conversion
 * happens once, here, rather than being got right in six places.
 */
function freezerLimits_(cfg) {
  cfg = cfg || settings_();
  var unit = str_(cfg[GOVEE_UNIT_SETTING]).toUpperCase() === 'F' ? 'F' : 'C';
  var said = function (key, degC) {
    var v = cfg[key];
    if (v === '' || v === undefined || v === null) {
      return unit === 'C' ? degC : cToF_(degC);
    }
    return num_(v);
  };
  var warmShown = said(GOVEE_WARM_SETTING, GOVEE_WARM_C_DEFAULT);
  var hotShown  = said(GOVEE_HOT_SETTING,  GOVEE_HOT_C_DEFAULT);
  var batt = cfg[GOVEE_BATT_SETTING] === '' || cfg[GOVEE_BATT_SETTING] === undefined
    ? GOVEE_BATT_DEFAULT : num_(cfg[GOVEE_BATT_SETTING]);
  return {
    unit: unit,
    warmShown: warmShown, hotShown: hotShown,
    // The same two lines in Fahrenheit, which is what readings are compared in.
    warm: unit === 'C' ? cToF_(warmShown) : warmShown,
    hot:  unit === 'C' ? cToF_(hotShown)  : hotShown,
    battery: batt
  };
}

/** Govee's number, turned into Fahrenheit whatever it arrived as. */
function goveeToF_(v, cfg) {
  if (v === null || v === undefined || v === '') return null;
  var sends = str_((cfg || settings_())[GOVEE_SENDS_SETTING]).toUpperCase();
  if (!sends) sends = GOVEE_SENDS_DEFAULT;
  return sends === 'C' ? cToF_(num_(v)) : num_(v);
}

/** How a temperature is written for somebody to read. */
function freezerTemp_(f, unit) {
  if (f === null || f === undefined || f === '') return '';
  return unit === 'C' ? fToC_(f) + '°C' : (Math.round(num_(f) * 10) / 10) + '°F';
}

/**
 * What is wrong with one reading, if anything.
 *
 * Order matters: a sensor that is off the air has no temperature worth
 * judging, so that is said instead of a made-up reading, not as well as one.
 */
/* What to go and look at, when the app cannot tell you why.
   The app knows a sensor has stopped answering. It cannot know whether that
   is a battery, the Wi-Fi or somebody catching it with a box of brisket, so
   it says so plainly rather than guessing at a cause. */
var FREEZER_GO_LOOK = 'Check the battery, the Wi-Fi, and whether the sensor ' +
                      'has been knocked or damaged. Until it is reading again ' +
                      'this freezer is not being watched.';

function freezerTrouble_(r, lim) {
  var where = r.freezerName || r.name || r.device;
  /* A sensor that is no longer on the Govee account at all. This is the
     quiet one: nothing comes back to be judged, so without this the freezer
     simply stops being watched and nothing is ever said about it. */
  if (r.missing) {
    return { kind: 'missing', level: 'bad',
             what: where + ' — its sensor has disappeared',
             detail: 'This freezer has a sensor against it on the FREEZERS tab, ' +
                     'but Govee no longer lists it. ' + FREEZER_GO_LOOK };
  }
  if (r.unwatched) {
    return { kind: 'unwatched', level: 'warn',
             what: where + ' has no sensor against it',
             detail: 'Nothing is reading this freezer. Put its sensor ID in the ' +
                     '"Govee device" column on the FREEZERS tab, or switch the ' +
                     'freezer off if it is no longer in use.' };
  }
  if (!r.ok) {
    return { kind: 'offline', level: 'bad',
             what: where + ' — no answer from the sensor',
             detail: (r.why ? r.why + ' ' : '') + FREEZER_GO_LOOK };
  }
  if (r.online === false) {
    return { kind: 'offline', level: 'bad',
             what: where + ' — sensor is off the air',
             detail: 'Govee has not heard from it, so any reading it shows is old. ' +
                     FREEZER_GO_LOOK };
  }
  if (r.tempF === null) {
    return { kind: 'noreading', level: 'bad',
             what: where + ' — no temperature came back',
             detail: 'The sensor answered but sent no temperature. ' + FREEZER_GO_LOOK };
  }
  /* The reading that never changes. Govee keeps serving the last thing it
     heard, so a dead sensor can look perfectly healthy — same temperature,
     same humidity, online, day after day. Real humidity never sits still, so
     a reading identical to the last few days running is a stopped sensor
     being reported as a working one. */
  if (r.stuck) {
    return { kind: 'stuck', level: 'bad',
             what: where + ' — the same reading for ' + r.stuck +
                   (r.stuck === 1 ? ' hour' : ' hours'),
             detail: 'Temperature and humidity have not moved at all since ' +
                     'then, which a working sensor does not do. It has most ' +
                     'likely stopped and Govee is still showing its last ' +
                     'reading. ' + FREEZER_GO_LOOK };
  }
  if (r.tempF >= lim.hot) {
    return { kind: 'hot', level: 'bad',
             what: where + ' is ' + freezerTemp_(r.tempF, lim.unit),
             detail: 'That is above ' + freezerTemp_(lim.hot, lim.unit) +
                     '. The meat in it is at risk. Check the freezer now.' };
  }
  if (r.tempF >= lim.warm) {
    return { kind: 'warm', level: 'warn',
             what: where + ' is ' + freezerTemp_(r.tempF, lim.unit),
             detail: 'Warmer than ' + freezerTemp_(lim.warm, lim.unit) +
                     '. Worth a look — a lid not shut properly reads like this. ' +
                     'Frozen storage wants to be around ' +
                     freezerTemp_(cToF_(-18), lim.unit) + '.' };
  }
  if (r.battery !== null && r.battery <= lim.battery) {
    return { kind: 'battery', level: 'warn',
             what: where + ' sensor battery is ' + Math.round(num_(r.battery)) + '%',
             detail: 'Change the battery before it stops reporting.' };
  }
  return null;
}

/** The tab the readings are written down in, made on first use. */
function freezerLogSheet_() {
  var ss = ss_();
  var sh = null;
  try { sh = ss.getSheetByName(TABS.FREEZERLOG); } catch (err) { sh = null; }
  if (!sh) {
    sh = ss.insertSheet(TABS.FREEZERLOG);
    sh.getRange(1, 1, 1, HEADERS.FREEZERLOG.length).setValues([HEADERS.FREEZERLOG])
      .setFontWeight('bold').setBackground('#3c2415').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  } else {
    /* A tab made by an older build stops at 'Note', and a column with no
       heading reads back empty under every name — which is how the order
       money got quietly overwritten once already. */
    ensureHeaders_(TABS.FREEZERLOG, HEADERS.FREEZERLOG);
  }
  return sh;
}

function alertSheet_() {
  var ss = ss_();
  var sh = null;
  try { sh = ss.getSheetByName(TABS.ALERTS); } catch (err) { sh = null; }
  if (!sh) {
    sh = ss.insertSheet(TABS.ALERTS);
    sh.getRange(1, 1, 1, HEADERS.ALERTS.length).setValues([HEADERS.ALERTS])
      .setFontWeight('bold').setBackground('#3c2415').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

/* The kinds of trouble that are about one freezer. Anything raised about a
   freezer that is no longer being watched belongs to this list, and is swept
   up when that freezer goes away. */
var FREEZER_ALERT_KINDS = ['offline', 'noreading', 'hot', 'warm', 'battery',
                           'missing', 'unwatched', 'stuck'];

/* What somebody can say when they close the banner. Neither of them settles
   anything — the next sweep that still finds the problem raises it again. */
var ALERT_ANSWERS = {
  later: 'Ignore for now',
  mine:  'I will investigate'
};

/* Written in the Answer column by the app rather than by a person. */
var ALERT_FIXED_ITSELF = 'Put itself right';
var ALERT_NOT_WATCHED  = 'That freezer is no longer being watched';

/* Columns by name rather than by number. These rows get written from four
   places and the tab has gained columns twice; counting them by hand is how
   a value ends up in the wrong cell. */
function alertCols_() {
  var at = {};
  HEADERS.ALERTS.forEach(function (h, i) { at[h] = i + 1; });
  return at;
}

function alertPutAway_(sh, rowIndex, answer, who) {
  var at = alertCols_();
  sh.getRange(rowIndex, at['Put away']).setValue('yes');
  sh.getRange(rowIndex, at['Answer']).setValue(str_(answer));
  sh.getRange(rowIndex, at['Put away by']).setValue(str_(who));
  sh.getRange(rowIndex, at['Put away at']).setValue(new Date());
}

function alertIsOpen_(r) {
  return str_(r['Put away']).toLowerCase() !== 'yes';
}

/**
 * Raise something.
 *
 * Suppressed only while the same trouble is still ON the banner — a warm
 * freezer that is still warm tomorrow is yesterday's warning, not a second
 * one, so a week away does not come back to seven identical banners. The one
 * already up has its wording and its reading brought up to date.
 *
 * Putting a warning away is different. It closes the banner; it does not
 * settle the matter. So a put-away warning does NOT suppress anything: the
 * next sweep that still finds the problem raises it again, as a new line,
 * carrying what was said about it last time. "Ignore for now" means for now.
 */
function alertRaise_(a) {
  var sh = alertSheet_();
  var at = alertCols_();
  var rows = readTable_(TABS.ALERTS);
  var key = str_(a.kind) + '|' + str_(a.about);
  var saidBefore = '', saidWhen = '';

  for (var i = 0; i < rows.length; i++) {
    if (str_(rows[i]['Kind']) + '|' + str_(rows[i]['About']) !== key) continue;
    if (alertIsOpen_(rows[i])) {
      // Still on the banner. Bring it up to date and leave it at that.
      sh.getRange(i + 2, at['What']).setValue(str_(a.what));
      sh.getRange(i + 2, at['Detail']).setValue(str_(a.detail));
      sh.getRange(i + 2, at['Last seen']).setValue(new Date());
      return { raised: false, updated: true };
    }
    /* Put away by a person, and here it is again. Worth saying so on the new
       one: coming back to "Freezer 3 again — you said you would look at it
       on Monday" is a different message from seeing it for the first time. */
    var ans = str_(rows[i]['Answer']);
    if (ans && ans !== ALERT_FIXED_ITSELF && ans !== ALERT_NOT_WATCHED) {
      saidBefore = ans;
      var when = asDate_(rows[i]['Put away at']);
      saidWhen = when
        ? Utilities.formatDate(when, Session.getScriptTimeZone(), 'MMM d') : '';
    }
  }

  var row = [];
  for (var c = 0; c < HEADERS.ALERTS.length; c++) row.push('');
  row[at['Alert ID'] - 1] = 'AL' + Utilities.formatDate(new Date(),
      Session.getScriptTimeZone(), 'yyyyMMddHHmmss') + '-' +
      Math.floor(Math.random() * 900 + 100);
  row[at['Raised'] - 1] = new Date();
  row[at['Kind'] - 1] = str_(a.kind);
  row[at['About'] - 1] = str_(a.about);
  row[at['What'] - 1] = str_(a.what);
  row[at['Detail'] - 1] = str_(a.detail);
  row[at['Last seen'] - 1] = new Date();
  row[at['How bad'] - 1] = str_(a.level) || 'warn';
  row[at['Said before'] - 1] = saidBefore;
  row[at['Said when'] - 1] = saidWhen;
  sh.appendRow(row);
  return { raised: true, again: !!saidBefore };
}

/**
 * Warnings about a freezer that is not there any more.
 *
 * Switch a freezer off, or take it off the tab, and its warnings would
 * otherwise sit on the banner for ever — nothing is reading it, so nothing
 * ever says it has put itself right, and the only way off the screen is to
 * put it away by hand. A banner that cannot be made to go away is a banner
 * people stop reading.
 */
function alertSweepGone_(stillWatched) {
  var rows;
  try { rows = readTable_(TABS.ALERTS); } catch (err) { return 0; }
  var sh = alertSheet_();
  var n = 0;
  for (var i = 0; i < rows.length; i++) {
    if (!alertIsOpen_(rows[i])) continue;
    if (FREEZER_ALERT_KINDS.indexOf(str_(rows[i]['Kind'])) === -1) continue;
    var about = str_(rows[i]['About']);
    if (!about || stillWatched[about]) continue;
    alertPutAway_(sh, i + 2, ALERT_NOT_WATCHED, '');
    n++;
  }
  return n;
}

/** Something that has put itself right needs no banner. */
function alertClear_(kind, about) {
  var sh = alertSheet_();
  var rows = readTable_(TABS.ALERTS);
  var n = 0;
  for (var i = 0; i < rows.length; i++) {
    if (!alertIsOpen_(rows[i])) continue;
    if (str_(rows[i]['Kind']) !== str_(kind)) continue;
    if (str_(rows[i]['About']) !== str_(about)) continue;
    alertPutAway_(sh, i + 2, ALERT_FIXED_ITSELF, '');
    n++;
  }
  return n;
}

/**
 * Somebody closed the banner, and said which of the two it was.
 *
 * Neither answer settles anything. Both close the banner now; the next sweep
 * decides whether it comes back.
 */
function alertDismiss_(op) {
  var id = str_(op.alertId);
  if (!id) return { error: 'Which alert?' };
  var answer = ALERT_ANSWERS[str_(op.answer)] || ALERT_ANSWERS.later;
  var sh = alertSheet_();
  var rows = readTable_(TABS.ALERTS);
  for (var i = 0; i < rows.length; i++) {
    if (str_(rows[i]['Alert ID']) !== id) continue;
    // Already closed: the first answer stands, so two phones do not fight.
    if (!alertIsOpen_(rows[i])) return { ok: true, alertId: id, already: true };
    alertPutAway_(sh, i + 2, answer, str_(op.user) || 'Someone');
    return { ok: true, alertId: id, answer: answer };
  }
  // Not there at all is not a failure either.
  return { ok: true, alertId: id };
}

/** Everything still up, newest first, for the banner. */
function openAlerts_() {
  var rows;
  try { rows = readTable_(TABS.ALERTS); } catch (err) { return []; }
  return rows.map(function (r, i) { r.__at = i; return r; }).filter(function (r) {
    return alertIsOpen_(r) && str_(r['Alert ID']);
  }).map(function (r) {
    return {
      at: r.__at,
      id: str_(r['Alert ID']),
      raised: (asDate_(r['Raised']) || {}).toISOString
        ? asDate_(r['Raised']).toISOString() : str_(r['Raised']),
      seen: (asDate_(r['Last seen']) || {}).toISOString
        ? asDate_(r['Last seen']).toISOString() : str_(r['Last seen']),
      kind: str_(r['Kind']),
      about: str_(r['About']),
      what: str_(r['What']),
      detail: str_(r['Detail']),
      level: str_(r['How bad']) || 'warn',
      // What was said the last time this same thing was put away, if it was.
      saidBefore: str_(r['Said before']),
      saidWhen: str_(r['Said when'])
    };
  }).sort(function (a, b) {
    if (a.level !== b.level) return a.level === 'bad' ? -1 : 1;
    return String(b.raised).localeCompare(String(a.raised)) || (b.at - a.at);
  });
}

/** The last reading from each freezer, for the detail screen. */
function freezerLatest_() {
  // Two rounds' worth is plenty to find the last of each.
  var rows = freezerLogTail_(40);
  var lim = freezerLimits_();
  var by = {};
  // Last row wins, for the same reason as above: appended, so the last one
  // written is the most recent one, whatever two identical clocks say.
  rows.forEach(function (r) {
    var k = str_(r['Freezer']) || str_(r['Sensor']);
    if (!k) return;
    var dWhen = asDate_(r['When']);
    var when = dWhen ? dWhen.toISOString() : str_(r['When']);
    by[k] = {
      freezer: str_(r['Freezer']),
      name: str_(r['Freezer name']) || str_(r['Sensor']),
      sensor: str_(r['Sensor']),
      when: when,
      tempF: str_(r['Temperature (F)']) === '' ? null : num_(r['Temperature (F)']),
      humidity: str_(r['Humidity %']) === '' ? null : num_(r['Humidity %']),
      battery: str_(r['Battery %']) === '' ? null : num_(r['Battery %']),
      online: str_(r['Online']).toLowerCase() === 'yes',
      status: str_(r['Status']),
      source: str_(r['Source']) || FREEZER_SOURCE_AUTO,
      auto: freezerAuto_(r['Source'])
    };
  });
  return Object.keys(by).map(function (k) {
    var one = by[k];
    one.reads = freezerTemp_(one.tempF, lim.unit);
    return one;
  }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
}

/**
 * Every freezer that should be being watched, and is not.
 *
 * Govee can only tell you about the sensors it still knows about. A sensor
 * that has been removed from the account, or has dropped off it, simply is
 * not in the list — so nothing comes back to be judged and the freezer stops
 * being watched without a word. This works the other way round: it starts
 * from the freezers on the FREEZERS tab and asks which of them produced no
 * reading at all.
 */
function freezerGaps_(readings) {
  ensureHeaders_(TABS.FREEZERS, HEADERS.FREEZERS);
  var heard = {};
  (readings || []).forEach(function (r) {
    if (r.freezer) heard[r.freezer] = true;
  });
  var gaps = [];
  readTable_(TABS.FREEZERS).forEach(function (f) {
    var id = str_(f['Freezer ID']);
    if (!id) return;
    if (!yes_(f['Active'])) return;                   // switched off on purpose
    if (id.toUpperCase() === 'UNASSIGNED') return;    // not a real place
    if (heard[id]) return;
    var said = str_(f['Govee device']);
    gaps.push({
      freezer: id, freezerName: str_(f['Name']) || id,
      name: said || '', device: said, sku: '',
      ok: false, why: '', tempF: null, humidity: null, battery: null, online: false,
      // Told which sensor it has and still nothing came back, versus never
      // having been given one at all. Different problems, different wording.
      missing: !!said,
      unwatched: !said
    });
  });
  return gaps;
}

/**
 * A reading that has not moved at all.
 *
 * Govee keeps serving the last value it heard, so a sensor that has stopped
 * can look perfectly healthy. Humidity is the tell: a real one wobbles every
 * reading, and the six here sat at 59.2, 61.1, 63.1, 63.4, 74.3 and 74.5 —
 * none of them a round number, none of them still. Identical temperature AND
 * humidity several checks running is a stopped sensor, not a steady one.
 */
/**
 * How long this reading has been the same, in hours.
 *
 * Counted in hours rather than in readings so it means the same thing
 * whether the freezers are read hourly or once a day. Returns 0 until the
 * run of identical readings is long enough to be worth saying out loud.
 */
function freezerStuckHours_(r, past, cfg) {
  if (!r.ok || r.tempF === null) return 0;
  var mine = (past || {})[r.freezer || r.device];
  if (!mine || !mine.length) return 0;
  var want = num_((cfg || settings_())[FREEZER_STUCK_SETTING]) || FREEZER_STUCK_DEFAULT;
  var mineTemp = Math.round(num_(r.tempF) * 10) / 10;
  var oldest = null;
  for (var i = 0; i < mine.length; i++) {
    if (mine[i].tempF !== mineTemp) break;
    if (mine[i].humidity !== r.humidity) break;
    oldest = mine[i].when;
  }
  if (!oldest) return 0;
  var hours = (Date.now() - new Date(oldest).getTime()) / 36e5;
  if (!isFinite(hours) || hours < want) return 0;
  return Math.round(hours);
}

/** The last few readings for each freezer, newest first. */
function freezerRecent_(howMany) {
  var rows = freezerLogTail_((num_(howMany) || 5) * 12 + 40);
  var by = {};
  rows.forEach(function (r) {
    var k = str_(r['Freezer']) || str_(r['Sensor']);
    if (!k) return;
    /* A run of identical readings is what says a sensor has stopped, and
       that only means something between readings taken the same way. Two
       spot checks a month apart that happen to match say nothing. */
    if (!freezerAuto_(r['Source'])) return;
    (by[k] || (by[k] = [])).push({
      when: (asDate_(r['When']) || { toISOString: function () { return str_(r['When']); } })
              .toISOString(),
      tempF: str_(r['Temperature (F)']) === '' ? null : num_(r['Temperature (F)']),
      humidity: str_(r['Humidity %']) === '' ? null : num_(r['Humidity %'])
    });
  });
  /* Newest last, because the tab is only ever appended to — the row order IS
     the order things happened. Sorting on the timestamp looks more careful
     and is less reliable: two rows written in the same second sort against
     each other arbitrarily, and this reads the last few in a row, so one
     pair out of order makes a stopped sensor look like a working one. */
  Object.keys(by).forEach(function (k) {
    by[k] = by[k].slice(-(num_(howMany) || 5)).reverse();
  });
  return by;
}

/**
 * The last fortnight of readings for each freezer.
 *
 * The app's Freezer temps screen shows the last reading large and the days
 * behind it as a small line, because one number on its own cannot tell you
 * whether a freezer is steady or climbing — and a freezer climbing slowly is
 * the one worth catching.
 */
function freezerHistory_(perFreezer) {
  var keep = num_(perFreezer) || 14;
  var rows = freezerLogTail_(keep * 12 + 60);
  var by = {};
  // Appended, so the natural row order is the order they happened.
  rows.forEach(function (r) {
    var k = str_(r['Freezer']) || str_(r['Sensor']);
    if (!k) return;
    (by[k] || (by[k] = [])).push({
      when: (asDate_(r['When']) || { toISOString: function () { return str_(r['When']); } })
              .toISOString(),
      tempF: str_(r['Temperature (F)']) === '' ? null : num_(r['Temperature (F)']),
      tempC: str_(r['Temperature (C)']) === '' ? null : num_(r['Temperature (C)']),
      humidity: str_(r['Humidity %']) === '' ? null : num_(r['Humidity %']),
      status: str_(r['Status']),
      source: str_(r['Source']) || FREEZER_SOURCE_AUTO,
      auto: freezerAuto_(r['Source'])
    });
  });
  Object.keys(by).forEach(function (k) { by[k] = by[k].slice(-keep); });
  return by;
}

/**
 * The daily round.
 *
 * Reads everything, looks again at anything that seems wrong, writes one row
 * per sensor, and raises or clears alerts. Safe to run by hand at any time.
 */
function freezerWatch() {
  var cfg = settings_();
  var key = goveeKey_(cfg);
  if (!key) return { ok: false, off: true,
                     why: 'No Govee key on the SETTINGS tab, so the freezers are not watched.' };
  var lim = freezerLimits_(cfg);

  var first = goveeReadAll_(key);
  if (!first.ok) {
    // The whole account is unreachable: that is one thing wrong, not six.
    alertRaise_({ kind: 'govee', about: 'account', level: 'bad',
                  what: 'The freezer sensors could not be read',
                  detail: str_(first.why) });
    return { ok: false, why: first.why };
  }
  alertClear_('govee', 'account');

  /* What Govee said, plus every freezer it said nothing about. A sensor that
     has vanished from the account is the failure most worth catching, and it
     is invisible from Govee's side of the conversation. */
  var readings = first.readings.concat(freezerGaps_(first.readings));

  // How long each has been saying exactly the same thing.
  var past = freezerRecent_(Math.ceil(
    (num_(cfg[FREEZER_STUCK_SETTING]) || FREEZER_STUCK_DEFAULT) /
    freezerEveryHours_(cfg)) + 2);
  readings.forEach(function (r) { r.stuck = freezerStuckHours_(r, past, cfg); });

  var suspect = readings.filter(function (r) { return !!freezerTrouble_(r, lim); });

  /* Look again before saying anything. A lid open while an order is being
     packed reads warm for a few minutes and is not a fault. */
  if (suspect.length) {
    Utilities.sleep(FREEZER_CONFIRM_WAIT);
    var second = goveeReadAll_(key);
    if (second.ok) {
      var again = {};
      second.readings.forEach(function (r) { again[r.device] = r; });
      readings = readings.map(function (r) {
        // A freezer nothing came back for has nothing to look at again.
        if (r.missing || r.unwatched) return r;
        var later = again[r.device];
        if (!later) return r;
        // The second look is the one that counts, so a freezer that has
        // settled back down is recorded as settled.
        later.firstTempF = r.tempF;
        later.stuck = freezerStuckHours_(later, past, cfg);
        return later;
      });
      // And a sensor that was there a minute ago and is not now.
      freezerGaps_(second.ok ? second.readings : []).forEach(function (g) {
        var had = false;
        readings.forEach(function (r) { if (r.freezer === g.freezer) had = true; });
        if (!had) readings.push(g);
      });
    }
  }

  var sh = freezerLogSheet_();
  var now = new Date();
  var rows = [], raised = 0, cleared = 0, watched = {};
  readings.forEach(function (r) {
    var bad = freezerTrouble_(r, lim);
    var where = r.freezer || r.device;
    // A freezer nothing answered for still gets a row, so the gap is on the
    // record rather than being an absence somebody has to notice.
    rows.push([now, r.freezer, r.freezerName,
               r.sku ? r.name + ' (' + r.sku + ')' : (r.name || 'none'),
               r.tempF === null ? '' : Math.round(num_(r.tempF) * 10) / 10,
               r.tempF === null ? '' : fToC_(r.tempF),
               r.humidity === null ? '' : r.humidity,
               r.battery === null ? '' : r.battery,
               r.online ? 'yes' : '',
               bad ? bad.kind : 'ok',
               bad ? bad.what : '',
               FREEZER_SOURCE_AUTO]);
    watched[where] = true;
    FREEZER_ALERT_KINDS.forEach(function (k) {
      if (!bad || bad.kind !== k) cleared += alertClear_(k, where);
    });
    if (bad) {
      var r2 = alertRaise_({ kind: bad.kind, about: where, level: bad.level,
                             what: bad.what, detail: bad.detail });
      if (r2.raised) raised++;
    }
  });
  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.FREEZERLOG.length)
      .setValues(rows);
  }
  // And anything still up about a freezer that has gone away.
  cleared += alertSweepGone_(watched);
  bumpDataVersion_();
  return { ok: true, read: rows.length, raised: raised, cleared: cleared };
}

/**
 * Set the daily check running. Run this once, by hand, from the editor.
 * Running it again replaces the old trigger rather than adding a second.
 */
function setupFreezerWatch() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'freezerWatch') ScriptApp.deleteTrigger(t);
  });
  var every = freezerEveryHours_();
  if (every >= 24) {
    ScriptApp.newTrigger('freezerWatch').timeBased().everyDays(1).atHour(6).create();
    return 'The freezers will be read every morning around 6am.';
  }
  ScriptApp.newTrigger('freezerWatch').timeBased().everyHours(every).create();
  return 'The freezers will be read every ' +
         (every === 1 ? 'hour' : every + ' hours') +
         ', and the readings kept on the ' + TABS.FREEZERLOG + ' tab.';
}

/* ==================== THE RECORD, FOR SOMEBODY ELSE ====================
 *
 * A log is only worth showing if it can say whether it is complete. A tab
 * full of readings answers "what was it on Tuesday"; it does not answer "is
 * anything missing", and that is the first thing anybody checking a record
 * wants to know. So this works out where the holes are and says so plainly
 * rather than letting an absence pass for a clean run.
 */

/** Every reading between two dates, oldest first. Scans the whole tab. */
function freezerRows_(fromISO, toISO) {
  var rows;
  try { rows = readTable_(TABS.FREEZERLOG); } catch (err) { return []; }
  var from = fromISO ? new Date(fromISO).getTime() : 0;
  var to = toISO ? new Date(toISO).getTime() + 864e5 - 1 : Date.now();
  var out = [];
  rows.forEach(function (r) {
    var w = asDate_(r['When']);
    if (!w) return;
    var t = w.getTime();
    if (!isFinite(t) || t < from || t > to) return;
    out.push({
      when: w,
      freezer: str_(r['Freezer']),
      name: str_(r['Freezer name']) || str_(r['Freezer']),
      sensor: str_(r['Sensor']),
      tempF: str_(r['Temperature (F)']) === '' ? null : num_(r['Temperature (F)']),
      tempC: str_(r['Temperature (C)']) === '' ? null : num_(r['Temperature (C)']),
      humidity: str_(r['Humidity %']) === '' ? null : num_(r['Humidity %']),
      battery: str_(r['Battery %']) === '' ? null : num_(r['Battery %']),
      status: str_(r['Status']),
      note: str_(r['Note']),
      source: str_(r['Source']) || FREEZER_SOURCE_AUTO,
      auto: freezerAuto_(r['Source'])
    });
  });
  out.sort(function (a, b) { return a.when - b.when; });
  return out;
}

/**
 * Where the log stopped and started again.
 *
 * A trigger that did not run, a Google outage, a script that threw — all of
 * them leave a silent hole, and silence reads exactly like a quiet week. A
 * gap is counted when more than twice the expected interval passed without a
 * reading, so one late run is not called a failure.
 */
function freezerHoles_(rows, everyHours) {
  var every = (num_(everyHours) || freezerEveryHours_()) * 36e5;
  var slack = every * 2.5;
  var byFreezer = {};
  (rows || []).forEach(function (r) {
    if (!r.freezer) return;
    /* Only the sweep's rows. A spot check taken once a month was never
       promising another one an hour later, so measuring it against the
       hourly interval would report the months before the sweep existed as
       thousands of hours of failure — which would be a lie in the other
       direction, and would bury the gaps that are real. The months of spot
       checks are reported as what they were, in their own section. */
    if (r.auto === false) return;
    (byFreezer[r.freezer] || (byFreezer[r.freezer] = [])).push(r);
  });
  var holes = [];
  Object.keys(byFreezer).forEach(function (id) {
    var mine = byFreezer[id];
    for (var i = 1; i < mine.length; i++) {
      var apart = mine[i].when - mine[i - 1].when;
      if (apart <= slack) continue;
      holes.push({
        freezer: id, name: mine[i].name,
        from: mine[i - 1].when, to: mine[i].when,
        hours: Math.round((apart / 36e5) * 10) / 10
      });
    }
  });
  holes.sort(function (a, b) { return a.from - b.from; });
  return holes;
}

/** A day of readings for one freezer, boiled down. */
function freezerDays_(rows, unit) {
  var by = {};
  (rows || []).forEach(function (r) {
    if (r.tempF === null) return;
    var day = Utilities.formatDate(r.when, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    var k = r.freezer + '|' + day;
    var d = by[k] || (by[k] = { freezer: r.freezer, name: r.name, day: day,
                                n: 0, auto: 0, spot: 0,
                                sum: 0, lo: null, hi: null, worst: '' });
    d.n++;
    if (r.auto === false) d.spot++; else d.auto++;
    d.sum += r.tempF;
    if (d.lo === null || r.tempF < d.lo) d.lo = r.tempF;
    if (d.hi === null || r.tempF > d.hi) d.hi = r.tempF;
    if (r.status && r.status !== 'ok') d.worst = r.status;
  });
  var lim = freezerLimits_();
  var u = unit || lim.unit;
  return Object.keys(by).sort().map(function (k) {
    var d = by[k];
    d.avg = Math.round((d.sum / d.n) * 10) / 10;
    d.loText = freezerTemp_(d.lo, u);
    d.hiText = freezerTemp_(d.hi, u);
    d.avgText = freezerTemp_(d.avg, u);
    d.how = !d.spot ? 'automatic' : (!d.auto ? 'spot check' : 'both');
    return d;
  });
}

/** Everything that was raised in a period, and what was said about it. */
function freezerAlertsBetween_(fromISO, toISO) {
  var rows;
  try { rows = readTable_(TABS.ALERTS); } catch (err) { return []; }
  var from = fromISO ? new Date(fromISO).getTime() : 0;
  var to = toISO ? new Date(toISO).getTime() + 864e5 - 1 : Date.now();
  return rows.filter(function (r) {
    if (FREEZER_ALERT_KINDS.indexOf(str_(r['Kind'])) === -1) return false;
    var w = asDate_(r['Raised']);
    if (!w) return false;
    var t = w.getTime();
    return isFinite(t) && t >= from && t <= to;
  }).map(function (r) {
    return {
      raised: r['Raised'],
      about: str_(r['About']),
      what: str_(r['What']),
      answer: str_(r['Answer']),
      by: str_(r['Put away by']),
      at: r['Put away at']
    };
  });
}

function reportWhen_(d, fmt) {
  var when = asDate_(d);
  if (!when) return '';
  return Utilities.formatDate(when, Session.getScriptTimeZone(), fmt || 'yyyy-MM-dd HH:mm');
}

/**
 * The whole record for a period, as a PDF in Drive.
 *
 * Written to be handed to somebody who was not here: what each freezer ran
 * at each day, every warning and what was done about it, and — the part that
 * makes it a record rather than a selection — every gap in it, stated.
 */
function freezerReport(fromISO, toISO) {
  var cfg = settings_();
  var lim = freezerLimits_(cfg);
  var every = freezerEveryHours_(cfg);
  var rows = freezerRows_(fromISO, toISO);
  var days = freezerDays_(rows, lim.unit);
  var holes = freezerHoles_(rows, every);
  var alerts = freezerAlertsBetween_(fromISO, toISO);

  // The two kinds of evidence, kept apart.
  var auto = rows.filter(function (r) { return r.auto !== false; });
  var spot = rows.filter(function (r) { return r.auto === false; });

  var first = rows.length ? rows[0].when : null;
  var last = rows.length ? rows[rows.length - 1].when : null;
  var autoFirst = auto.length ? auto[0].when : null;
  var autoLast = auto.length ? auto[auto.length - 1].when : null;
  var names = {};
  rows.forEach(function (r) { names[r.freezer] = r.name; });

  var esc_ = function (t) {
    return String(t === null || t === undefined ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  var html = [];
  html.push('<html><head><meta charset="utf-8"><style>' +
    'body{font-family:Helvetica,Arial,sans-serif;font-size:10pt;color:#111;margin:28px}' +
    'h1{font-size:16pt;margin:0 0 2px}h2{font-size:11pt;margin:20px 0 6px}' +
    '.sub{color:#555;margin:0 0 14px}' +
    'table{border-collapse:collapse;width:100%;margin:0 0 10px}' +
    'th,td{border:1px solid #bbb;padding:4px 6px;text-align:left;font-size:9pt}' +
    'th{background:#eee}td.n{text-align:right;font-variant-numeric:tabular-nums}' +
    '.bad{background:#fbe6e6}.warn{background:#fdf3e0}' +
    '.note{color:#555;font-size:9pt;margin:4px 0 0}' +
    '.ok{color:#1a6b1a;font-weight:bold}.gap{color:#9a2a2a;font-weight:bold}' +
    '</style></head><body>');

  html.push('<h1>' + esc_(str_(cfg.BUSINESS) || 'Peace Country Wagyu') +
            ' — freezer temperature record</h1>');
  html.push('<p class="sub">' +
    (first ? reportWhen_(first, 'd MMM yyyy') + ' to ' + reportWhen_(last, 'd MMM yyyy')
           : 'No readings in this period') +
    ' · ' + rows.length + ' readings' +
    (spot.length ? ' (' + auto.length + ' automatic, ' + spot.length +
                   ' spot checks)' : '') +
    ' · printed ' + reportWhen_(new Date(), 'd MMM yyyy HH:mm') + '</p>');

  html.push('<p class="note"><b>How this was measured.</b> Govee H5100 ' +
    'thermo-hygrometers, one in each freezer. Readings marked automatic were ' +
    'read from the Govee cloud service every ' +
    (every === 1 ? 'hour' : every + ' hours') +
    ' and written down unaltered. These are consumer sensors and are not ' +
    'calibrated to a traceable standard. Frozen storage is held at about ' +
    esc_(freezerTemp_(cToF_(-18), lim.unit)) +
    '; this record flags anything above ' + esc_(freezerTemp_(lim.warm, lim.unit)) +
    ' and treats anything above ' + esc_(freezerTemp_(lim.hot, lim.unit)) +
    ' as product at risk.</p>');
  if (spot.length) {
    html.push('<p class="note"><b>Spot checks.</b> Before the automatic ' +
      'readings began, the freezers were checked by eye in the Govee app and ' +
      'the screen photographed. Those readings are in this record, each one ' +
      'naming the photograph it was copied from, and are listed separately ' +
      'below. They are what they are: a single moment, read by a person, ' +
      'weeks apart. They are not evidence about the hours in between, and ' +
      'nothing in this record treats them as such.</p>');
  }

  // Is it complete?
  html.push('<h2>Completeness of the automatic record</h2>');
  if (!rows.length) {
    html.push('<p class="gap">No readings were recorded in this period at all.</p>');
  } else if (!auto.length) {
    html.push('<p class="gap">No automatic readings were recorded in this ' +
      'period — what exists for it is the ' + spot.length +
      (spot.length === 1 ? ' spot check' : ' spot checks') +
      ' listed below, and nothing else.</p>');
  } else if (!holes.length) {
    html.push('<p class="ok">No gaps. Automatic readings run unbroken from ' +
      reportWhen_(autoFirst) + ' to ' + reportWhen_(autoLast) + '.</p>');
  } else {
    html.push('<p class="gap">' + holes.length +
      (holes.length === 1 ? ' gap in the record:' : ' gaps in the record:') + '</p>');
    html.push('<table><tr><th>Freezer</th><th>From</th><th>To</th><th>Hours</th></tr>');
    holes.forEach(function (h) {
      html.push('<tr class="bad"><td>' + esc_(h.name) + '</td><td>' +
        reportWhen_(h.from) + '</td><td>' + reportWhen_(h.to) + '</td>' +
        '<td class="n">' + h.hours + '</td></tr>');
    });
    html.push('</table>');
  }
  if (auto.length && spot.length) {
    html.push('<p class="note">Gaps are counted between automatic readings ' +
      'only, against the ' +
      (every === 1 ? 'hourly' : 'every ' + every + ' hours') +
      ' interval they are taken on. The spot-check months before ' +
      reportWhen_(autoFirst, 'd MMM yyyy') +
      ' are not counted as gaps and are not claimed as cover; what exists ' +
      'for them is the list below and nothing more.</p>');
  }

  // Day by day.
  html.push('<h2>Day by day</h2>');
  if (!days.length) {
    html.push('<p>Nothing to show.</p>');
  } else {
    var byFreezer = {};
    days.forEach(function (d) { (byFreezer[d.freezer] || (byFreezer[d.freezer] = [])).push(d); });
    Object.keys(byFreezer).sort().forEach(function (id) {
      html.push('<h2>' + esc_(names[id] || id) + '</h2>');
      html.push('<table><tr><th>Day</th><th>Readings</th><th>How</th>' +
                '<th>Lowest</th><th>Highest</th><th>Average</th>' +
                '<th>Flagged</th></tr>');
      byFreezer[id].forEach(function (d) {
        var cls = d.worst === 'hot' ? ' class="bad"'
                : d.worst ? ' class="warn"' : '';
        html.push('<tr' + cls + '><td>' + esc_(d.day) + '</td><td class="n">' + d.n +
          '</td><td>' + esc_(d.how) +
          '</td><td class="n">' + esc_(d.loText) + '</td><td class="n">' +
          esc_(d.hiText) + '</td><td class="n">' + esc_(d.avgText) + '</td><td>' +
          esc_(d.worst || '') + '</td></tr>');
      });
      html.push('</table>');
    });
  }

  // The hand-read checks, each naming where it came from.
  if (spot.length) {
    html.push('<h2>Spot checks read from the Govee app</h2>');
    html.push('<table><tr><th>When</th><th>Freezer</th><th>Temperature</th>' +
              '<th>Humidity</th><th>Flagged</th><th>Copied from</th></tr>');
    spot.forEach(function (r) {
      var cls = r.status === 'hot' ? ' class="bad"'
              : (r.status && r.status !== 'ok') ? ' class="warn"' : '';
      html.push('<tr' + cls + '><td>' + reportWhen_(r.when) + '</td><td>' +
        esc_(r.name || r.freezer) + '</td><td class="n">' +
        esc_(r.tempF === null ? 'no reading' : freezerTemp_(r.tempF, lim.unit)) +
        '</td><td class="n">' +
        esc_(r.humidity === null ? '' : r.humidity + '%') + '</td><td>' +
        esc_(r.status && r.status !== 'ok' ? r.status : '') + '</td><td>' +
        esc_(r.source) + '</td></tr>');
    });
    html.push('</table>');
    html.push('<p class="note">The photographs these were copied from are ' +
      'kept, so any line here can be checked against the screen it was read ' +
      'off. Where the Govee app was showing a card that had stopped ' +
      'updating, the time shown is the time of the reading itself, not the ' +
      'time the photograph was taken.</p>');
  }

  // What was flagged, and what was done.
  html.push('<h2>Warnings raised, and what was done</h2>');
  if (!alerts.length) {
    html.push('<p class="ok">Nothing was flagged in this period.</p>');
  } else {
    html.push('<table><tr><th>When</th><th>What</th><th>Answered</th>' +
              '<th>By</th><th>When answered</th></tr>');
    alerts.forEach(function (a) {
      html.push('<tr><td>' + reportWhen_(a.raised) + '</td><td>' + esc_(a.what) +
        '</td><td>' + esc_(a.answer || 'still open') + '</td><td>' + esc_(a.by) +
        '</td><td>' + reportWhen_(a.at) + '</td></tr>');
    });
    html.push('</table>');
  }

  html.push('</body></html>');

  var name = 'PCW freezer record ' +
    (first ? reportWhen_(first, 'yyyy-MM-dd') : 'empty') + ' to ' +
    (last ? reportWhen_(last, 'yyyy-MM-dd') : 'empty') + '.pdf';
  var pdf = Utilities.newBlob(html.join(''), 'text/html', 'r.html')
    .getAs('application/pdf').setName(name);
  var file = DriveApp.createFile(pdf);
  return {
    ok: true, name: name, url: file.getUrl(),
    readings: rows.length, days: days.length,
    automatic: auto.length, spotChecks: spot.length,
    gaps: holes.length, alerts: alerts.length,
    from: first ? reportWhen_(first, 'yyyy-MM-dd') : '',
    to: last ? reportWhen_(last, 'yyyy-MM-dd') : ''
  };
}

/** How complete the record is, for the app to show without making a PDF. */
function freezerRecordState_() {
  var sh;
  try { sh = sheet_(TABS.FREEZERLOG); } catch (err) { return null; }
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { readings: 0 };
  var first = sh.getRange(2, 1).getValue();
  var iso = function (v) {
    var d = asDate_(v);
    return d ? d.toISOString() : str_(v);
  };

  /* One column of the tab, not the tab. Hourly on six freezers this reaches
     fifty thousand rows a year, and this runs on every phone sync. */
  var srcCol = HEADERS.FREEZERLOG.indexOf('Source') + 1;
  var spotChecks = 0, autoFrom = 0;
  if (srcCol > 0) {
    var sources = sh.getRange(2, srcCol, lastRow - 1, 1).getValues();
    for (var i = 0; i < sources.length; i++) {
      if (freezerAuto_(sources[i][0])) {
        if (!autoFrom) autoFrom = i + 2;
      } else spotChecks++;
    }
  } else autoFrom = 2;

  var tail = freezerLogTail_(400);
  var every = freezerEveryHours_();
  var holes = freezerHoles_(tail.map(function (r) {
    return { when: asDate_(r['When']),
             freezer: str_(r['Freezer']), name: str_(r['Freezer name']),
             auto: freezerAuto_(r['Source']) };
  }).filter(function (r) { return !!r.when; }), every);
  return {
    readings: lastRow - 1,
    spotChecks: spotChecks,
    automatic: lastRow - 1 - spotChecks,
    since: iso(first),
    /* When the machine took over. Shown apart from the line above because
       the months before it are spot checks, and a record that quietly dates
       itself from the first of those is claiming cover it does not have. */
    autoSince: autoFrom ? iso(sh.getRange(autoFrom, 1).getValue()) : '',
    everyHours: every,
    recentGaps: holes.length
  };
}

/* ======================= THE 2026 SALES SHEET =======================
 *
 * The company's own record of what was sold, kept by hand long before this
 * app existed and still the book everything is written in: website orders,
 * sales Hannah makes at the door, whole steers. The app's Sales screen reads
 * it, so the year's figure is the real one rather than only what happens to
 * have gone through here.
 *
 * It is a human sheet. Dates are written "Jan 9/26", "Mar 3/2026",
 * "3/16/2026" and "August31/26". Prices are written "$295.00", "295 - Stripe
 * fees = 286.14" and "567.00 - Stripe fee". Nothing here corrects any of
 * that — it reads what is there and takes the first number as the sale.
 */

var SALES_BOOK_SETTING = 'SALES_SHEET_ID';
var SALES_BOOK_TAB_SETTING = 'SALES_SHEET_TAB';
var SALES_BOOK_TAB_DEFAULT = 'Sales';
// Written into the sales sheet beside a sale this app sent over, so the same
// sale is never counted twice when it is read back.
var SALES_BOOK_MARK = 'App order ID';

var MONTHS_ = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8,
                sep:9, oct:10, nov:11, dec:12 };

/** "Jan 9/26", "August31/26", "3/16/2026", a real Date — all of them. */
function parseSaleDate_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var s = str_(v);
  if (!s) return '';
  var yr = function (y) {
    y = Number(y);
    return y < 100 ? 2000 + y : y;
  };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };

  // August31/26 · Jan 9/26 · June 15 2026 · April 29/2026
  var m = s.match(/^\s*([A-Za-z]{3,})\.?\s*(\d{1,2})\s*[\/\s,.-]+\s*(\d{2,4})\s*$/);
  if (m) {
    var mo = MONTHS_[m[1].slice(0, 3).toLowerCase()];
    if (mo) return yr(m[3]) + '-' + pad(mo) + '-' + pad(Number(m[2]));
  }
  // 3/16/2026 — month first, as everything else on the sheet is written
  m = s.match(/^\s*(\d{1,2})\s*[\/-]\s*(\d{1,2})\s*[\/-]\s*(\d{2,4})\s*$/);
  if (m) return yr(m[3]) + '-' + pad(Number(m[1])) + '-' + pad(Number(m[2]));
  // 2026-03-16
  m = s.match(/^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$/);
  if (m) return m[1] + '-' + pad(Number(m[2])) + '-' + pad(Number(m[3]));
  return '';
}

/**
 * What the sale came to, and what landed after fees.
 *
 * "295 - Stripe fees = 286.14" is one sale of $295 that put $286.14 in the
 * bank. The first number is the sale; a number after the word "fee" is what
 * was left. "567.00 - Stripe fee" says there were fees without saying how
 * much, so only the sale is known.
 */
function parseSaleAmount_(v) {
  if (typeof v === 'number') return { gross: Math.round(v * 100) / 100, net: 0 };
  var s = str_(v).replace(/,/g, '');
  if (!s) return { gross: 0, net: 0 };
  var nums = s.match(/\d+(?:\.\d+)?/g);
  if (!nums || !nums.length) return { gross: 0, net: 0 };
  var gross = Math.round(Number(nums[0]) * 100) / 100;
  var net = 0;
  var after = s.toLowerCase().indexOf('fee');
  if (after > -1) {
    var rest = s.slice(after).match(/\d+(?:\.\d+)?/g);
    if (rest && rest.length) net = Math.round(Number(rest[rest.length - 1]) * 100) / 100;
  }
  return { gross: gross, net: net && net !== gross ? net : 0 };
}

/** The sales sheet itself, or null if nothing points at one. */
function salesBookSheet_() {
  var cfg = settings_();
  var id = str_(cfg[SALES_BOOK_SETTING]);
  if (!id) return null;
  var tab = str_(cfg[SALES_BOOK_TAB_SETTING]) || SALES_BOOK_TAB_DEFAULT;
  try {
    var book = SpreadsheetApp.openById(id);
    var sh = book.getSheetByName(tab);
    if (!sh) {
      var all = book.getSheets();
      for (var i = 0; i < all.length && !sh; i++) {
        if (String(all[i].getName()).trim().toLowerCase() === tab.trim().toLowerCase()) sh = all[i];
      }
    }
    return sh || null;
  } catch (err) { return null; }
}

/**
 * Every sale written in the book, newest first.
 *
 * A row with no date and no money is somebody's half-finished note rather
 * than a sale, and is left out. A row this app wrote is marked with the
 * order it came from, so the Sales screen can show one of it instead of two.
 */
function salesBookRows_(limit) {
  var sh = salesBookSheet_();
  if (!sh) return [];
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  var vals;
  try { vals = sh.getRange(1, 1, lastRow, lastCol).getValues(); }
  catch (err) { return []; }

  var head = vals[0].map(function (h) { return String(h).trim(); });
  var at = function (name) { return head.indexOf(name); };
  var cDate = at('Date of sale'), cWho = at('Customer'), cBy = at('Salesman');
  var cWhat = at('Type of cuts/order (weights)'), cAmt = at('Total price');
  var cPaid = at('Payment'), cHow = at('Payment type'), cMark = at(SALES_BOOK_MARK);
  // Everything after the payment type is somebody's note, wherever they put it.
  var cNoteFrom = cHow > -1 ? cHow + 1 : head.length;

  var out = [];
  for (var r = 1; r < vals.length; r++) {
    var row = vals[r];
    var when = cDate > -1 ? parseSaleDate_(row[cDate]) : '';
    var money = cAmt > -1 ? parseSaleAmount_(row[cAmt]) : { gross: 0, net: 0 };
    var who = cWho > -1 ? str_(row[cWho]) : '';
    if (!when && !money.gross && !who) continue;         // an empty line
    var notes = [];
    for (var c = cNoteFrom; c < row.length; c++) {
      if (c === cMark) continue;
      var t = str_(row[c]);
      if (t) notes.push(t);
    }
    out.push({
      row: r + 1,
      date: when,
      raw: cDate > -1 ? str_(row[cDate]) : '',
      customer: who,
      by: cBy > -1 ? str_(row[cBy]) : '',
      what: cWhat > -1 ? str_(row[cWhat]) : '',
      amount: money.gross,
      net: money.net,
      // Anything other than the word "paid" is money still owed, including
      // a blank — the sheet is only marked once it has come in.
      paid: cPaid > -1 ? str_(row[cPaid]).toLowerCase().indexOf('paid') === 0 : false,
      paymentType: cHow > -1 ? str_(row[cHow]) : '',
      note: notes.join(' · '),
      orderId: cMark > -1 ? str_(row[cMark]) : ''
    });
  }
  out.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  return limit ? out.slice(0, num_(limit)) : out;
}

/**
 * Write a sale this app settled into the book.
 *
 * It is marked with the order ID, which is the only thing stopping the same
 * sale being read back as a second one. If the order is already in there —
 * sent twice, or written by hand first — the row is updated rather than
 * added again.
 */
function salesBookWrite_(o) {
  var sh = salesBookSheet_();
  if (!sh || !o) return { ok: false, why: 'no sales sheet' };
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h).trim(); });

  var cMark = head.indexOf(SALES_BOOK_MARK);
  if (cMark === -1) {
    cMark = head.filter(String).length;
    sh.getRange(1, cMark + 1).setValue(SALES_BOOK_MARK)
      .setFontWeight('bold');
    head[cMark] = SALES_BOOK_MARK;
    lastCol = Math.max(lastCol, cMark + 1);
  }
  var at = function (name) { return head.indexOf(name); };
  var cDate = at('Date of sale'), cWho = at('Customer'), cBy = at('Salesman');
  var cWhat = at('Type of cuts/order (weights)'), cAmt = at('Total price');
  var cPaid = at('Payment'), cHow = at('Payment type');

  var what = (o.items || []).map(function (i) {
    return num_(i.packages) + 'x ' + str_(i.product || i.sku);
  }).join(', ');

  var put = function (row, c, v) { if (c > -1) row[c] = v; };
  var row = [];
  for (var i = 0; i < lastCol; i++) row.push('');
  put(row, cDate, str_(o.deliveredAt) || str_(o.deliveryDate));
  put(row, cWho, str_(o.customer));
  put(row, cBy, str_(o.paidBy) || 'App');
  put(row, cWhat, what);
  put(row, cAmt, num_(o.total));
  put(row, cPaid, o.paid ? 'Paid' : '');
  put(row, cHow, str_(o.paymentType));
  row[cMark] = str_(o.id);

  // Already in the book? Then this is the same sale, not another one.
  var lastRow = sh.getLastRow();
  if (lastRow > 1) {
    var marks = sh.getRange(2, cMark + 1, lastRow - 1, 1).getValues();
    for (var r = 0; r < marks.length; r++) {
      if (str_(marks[r][0]) === str_(o.id)) {
        sh.getRange(r + 2, 1, 1, lastCol).setValues([row]);
        return { ok: true, updated: true, row: r + 2 };
      }
    }
  }
  sh.getRange(lastRow + 1, 1, 1, lastCol).setValues([row]);
  return { ok: true, added: true, row: lastRow + 1 };
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
    // The sales sheet has a "Paid" checkbox that has never been ticked — it
    // reads FALSE on every row, blank ones included, so it carries no
    // information. Importing it as "No" told the app nine customers owed
    // money when they did not. Payment is tracked on the invoices, not here,
    // so the column is left empty and the app claims nothing about it.
    added.push([
      name, str_(r['Phone']), str_(r['Email']),
      str_(r['Purchased part']) || 'Whole animal',
      invoice ? 'Past' : 'Waiting', 'Normal', '',
      parseAmount_(r['Deposit']),
      parseAmount_(r['Weight']),
      parseAmount_(r['Price (Price per pound - deposit) (Whole $8/lb, Half $9/lb, Quarter $10/lb)']),
      invoice, '',
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

/** An ISO day, n days on. Used to bound the calendar screen's window. */
function addDays_(iso, n) {
  var d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
  if (isNaN(d.getTime())) d = new Date();
  d.setDate(d.getDate() + num_(n));
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
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


/* ==================== BRINGING THE OLD TABS ACROSS ====================
 * The sheet started life with a different layout: Products / Prices / Lots /
 * Moves, written by the Kenji bridge. This reads those tabs once and turns
 * them into the catalogue and the opening-count ledger the app uses.
 *
 * It never deletes anything. The old tabs stay exactly as they are until you
 * rename them, so if this goes wrong the original numbers are still sitting
 * there to compare against.
 */
function migrateOldTabs_() {
  // The old tabs may live in another file — after a name collision the safest
  // copy of them is the backup, not this sheet. SETTINGS ▸ OLD_TABS_SHEET_ID
  // points at it; blank means read them from here.
  var srcId = settings_().OLD_TABS_SHEET_ID;
  var ss = ss_();
  if (srcId) {
    try { ss = SpreadsheetApp.openById(srcId); }
    catch (e) { return { ok: false, error: 'Could not open OLD_TABS_SHEET_ID: ' + e.message }; }
  }
  var oldLots = ss.getSheetByName('Lots');
  if (!oldLots) return { ok: false, error: 'No "Lots" tab here, so there is nothing to bring across.' };

  var MARK = 'Opening count (from Lots)';
  var already = readTable_(TABS.MOVEMENTS).some(function (m) {
    return str_(m['Party / reason']) === MARK;
  });
  if (already) {
    return { ok: false, error: 'Already brought across. Delete the ' + MARK +
             ' rows from MOVEMENTS first if you really want to run it again.' };
  }

  var out = { ok: true, products: 0, lots: 0, packages: 0, skipped: [], notes: [] };

  // ---- prices, keyed by product then grade ----------------------------
  var priceFor = {};
  var pricesTab = ss.getSheetByName('Prices');
  if (pricesTab) {
    readSheetTable_(pricesTab).forEach(function (r) {
      var id = str_(r['ProductID']);
      if (!id) return;
      if (!priceFor[id]) priceFor[id] = {};
      priceFor[id][str_(r['Grade']) || 'All'] = {
        perLb: num_(r['PerLb']), perKg: num_(r['PerKg']), perPkg: num_(r['PerPkg'])
      };
    });
  }
  // Gold is the everyday price; fall back to whatever the product has.
  var bestPrice = function (id) {
    var byGrade = priceFor[id];
    if (!byGrade) return {};
    var keys = Object.keys(byGrade);
    var gold = keys.filter(function (k) { return /gold/i.test(k); })[0];
    var all = keys.filter(function (k) { return /^all/i.test(k); })[0];
    return byGrade[gold || all || keys[0]] || {};
  };

  // "2 lb" -> 2, "5 patties" -> 0, "" -> 0
  var lbFromContent = function (content) {
    var m = String(content || '').match(/([\d.]+)\s*lb/i);
    return m ? num_(m[1]) : 0;
  };

  // ---- catalogue --------------------------------------------------------
  var made = {};
  var productsTab = ss.getSheetByName('Products');
  if (productsTab) {
    readSheetTable_(productsTab).forEach(function (r) {
      var id = str_(r['ID']);
      if (!id) return;
      var sku = id.toUpperCase();
      var p = bestPrice(id);
      var res = addProduct_({
        sku: sku,
        product: str_(r['Name']) || id,
        category: str_(r['Category']),
        content: str_(r['Content']),
        avgWeight: lbFromContent(r['Content']),
        pricePerLb: p.perLb || '',
        pricePerKg: p.perKg || '',
        price: p.perPkg || '',
        reorder: str_(r['LowStock']),
        notes: (str_(r['Barcode']) ? 'Barcode ' + str_(r['Barcode']) + '. ' : '') +
               (yes_(r['IsBox']) ? 'Was a box in the old sheet: ' + str_(r['BoxContents']) + '. ' : '') +
               'Brought across from the old Products tab.'
      });
      if (res.ok) { made[id] = sku; out.products++; }
      else if (/already/i.test(res.error || '')) { made[id] = sku; }
      else { out.skipped.push(id + ': ' + res.error); }
    });
  }

  // ---- freezers ---------------------------------------------------------
  var freezersTab = ss.getSheetByName('Freezers');
  var freezerId = {};
  if (freezersTab) {
    readSheetTable_(freezersTab).forEach(function (r) {
      var name = str_(r['Name']);
      if (!name) return;
      var id = name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 12);
      addFreezer_({ id: id, name: name, location: str_(r['Location']), notes: str_(r['Notes']) });
      freezerId[name] = id;
    });
  }

  // ---- the lots become one opening-count movement each -------------------
  var ops = [];
  readSheetTable_(oldLots).forEach(function (r) {
    var qty = num_(r['Qty']);
    var lot = str_(r['LotID']);
    if (qty <= 0) { if (lot) out.skipped.push(lot + ': nothing on hand'); return; }

    var pid = str_(r['ProductID']);
    var sku = made[pid] || (pid ? pid.toUpperCase() : '');
    if (!sku) { out.skipped.push(lot + ': no product'); return; }

    var grade = str_(r['Grade']);
    if (/^unknown$/i.test(grade)) grade = '';
    var batch = str_(r['Batch']);
    if (/^unknown$/i.test(batch)) batch = '';
    var freezer = freezerId[str_(r['Freezer'])] || 'UNASSIGNED';

    ops.push({
      clientKey: 'MIGRATE-' + lot,
      type: 'INTAKE',
      sku: sku,
      size: str_(r['Size']),
      grade: grade,
      batch: batch,
      freezer: freezer,
      packages: qty,
      weight: num_(r['WeightLb']) || '',
      party: MARK,
      user: 'Migration',
      note: 'Was ' + lot + (str_(r['Note']) ? '. ' + str_(r['Note']) : ''),
      timestamp: dateStr_(r['Updated']) ? dateStr_(r['Updated']).slice(0, 10) + 'T12:00:00Z'
                                        : new Date().toISOString()
    });
    out.lots++;
    out.packages += qty;
  });

  // Any batch the lots mention needs to exist before the ledger takes it.
  var batches = {};
  ops.forEach(function (o) { if (o.batch) batches[o.batch] = true; });
  Object.keys(batches).forEach(function (b) {
    addBatch_({ id: b, outfit: 'PCW', notes: 'Came across with the old Lots tab.' });
  });
  if (!indexFreezers_().some(function (f) { return f.id === 'UNASSIGNED'; })) {
    addFreezer_({ id: 'UNASSIGNED', name: 'Unassigned',
                  notes: 'Opening stock not yet counted into a real freezer.' });
  }

  var res = submit_({ ops: ops });
  if (res.warnings && res.warnings.length) out.notes = res.warnings;
  rebuildInventory();
  return out;
}

/** Reads any sheet into objects using row 1 as the header. */
function readSheetTable_(sh) {
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 2) return [];
  var values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var head = values.shift().map(function (h) { return String(h).trim(); });
  return values.map(function (row) {
    var o = {};
    head.forEach(function (h, i) { if (h && !o.hasOwnProperty(h)) o[h] = row[i]; });
    return o;
  }).filter(function (o) {
    return Object.keys(o).some(function (k) { return str_(o[k]) !== ''; });
  });
}

/** Renames the old tabs so nobody, script or human, reads them by accident. */
function retireOldTabs_() {
  var ss = ss_();
  var renamed = [];
  var wanted = ['Products', 'Prices', 'Lots', 'Moves', 'Orders', 'Freezers', 'LabelQueue'];
  // Exact names only. "Orders" and our own "ORDERS" are the same name to
  // getSheetByName, and renaming ours would take the app's order book with it.
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (wanted.indexOf(name) === -1) return;
    if (ss.getSheetByName(name + ' (old)')) return;
    sh.setName(name + ' (old)');
    renamed.push(name);
  });
  return { ok: true, renamed: renamed };
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

/* ====================== DROP-OFFS AND PICK-UPS ======================
 * Every order with a date goes on the PCW Google Calendar, and the entry
 * carries what you need standing on someone's driveway: their name, phone,
 * email, where you are meeting, what is in the box and anything they said.
 *
 * The event id is written back onto the order, so moving a date moves the
 * entry rather than leaving a second one behind.
 *
 * Set CALENDAR_ID in SETTINGS to switch it on. Left blank, everything here
 * quietly does nothing and the app still shows the schedule from the sheet.
 * =================================================================== */

/** The calendar, or null when one has not been set up. */
function pcwCalendar_() {
  var id = str_(settings_().CALENDAR_ID);
  if (!id) return null;
  try { return CalendarApp.getCalendarById(id); } catch (err) { return null; }
}

/** "Pickup" and "Delivery" read better as what is actually happening. */
function meetingWord_(method) {
  var m = str_(method).toLowerCase();
  if (m.indexOf('deliver') > -1 || m.indexOf('drop') > -1) return 'Drop-off';
  if (m.indexOf('ship') > -1 || m.indexOf('mail') > -1) return 'Shipping';
  if (m.indexOf('market') > -1) return 'Market';
  return 'Pick-up';
}

/** Everything about one meeting, laid out for a calendar entry. */
function calendarBody_(o) {
  var lines = [];
  if (o.phone) lines.push('Phone: ' + o.phone);
  if (o.contact) lines.push('Email: ' + o.contact);
  if (o.venue) lines.push('Where: ' + o.venue);
  if (o.time) lines.push('Time: ' + o.time);
  lines.push('');
  lines.push('Order:');
  if (o.items && o.items.length) {
    o.items.forEach(function (i) {
      lines.push('  ' + i.packages + ' × ' + (i.product || i.sku) + (i.note ? ' (' + i.note + ')' : ''));
    });
  } else {
    lines.push('  (nothing listed)');
  }
  if (o.notes) { lines.push(''); lines.push('Notes: ' + o.notes); }
  lines.push('');
  lines.push('— ' + o.id + ', from the PCW inventory app');
  return lines.join('\n');
}

/**
 * Put one order on the calendar, or move the entry it already has.
 * Safe to call whenever an order changes; does nothing without a date.
 */
function calendarPushOne_(orderId) {
  var cal = pcwCalendar_();
  if (!cal) return { ok: true, skipped: 'no calendar set' };

  var o = null;
  readOrders_().forEach(function (x) { if (x.id === str_(orderId)) o = x; });
  if (!o) return { ok: false, error: 'No order called ' + orderId };
  if (!o.deliveryDate) return { ok: true, skipped: 'no date yet' };
  if (o.status === 'Cancelled') { calendarDropOne_(o); return { ok: true, removed: true }; }

  var title = meetingWord_(o.method) + ' — ' + o.customer +
              (o.venue ? ' (' + o.venue + ')' : '');
  var body = calendarBody_(o);

  // A time turns it into a real appointment; without one it stays all-day.
  var start = null, end = null;
  var hm = str_(o.time).match(/^(\d{1,2})\s*[:h]?\s*(\d{2})?\s*(am|pm)?$/i);
  if (hm) {
    var hour = Number(hm[1]);
    var min = Number(hm[2] || 0);
    var ap = (hm[3] || '').toLowerCase();
    if (ap === 'pm' && hour < 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;
    start = new Date(o.deliveryDate + 'T00:00:00');
    start.setHours(hour, min, 0, 0);
    end = new Date(start.getTime() + 30 * 60 * 1000);
  }

  var ev = null;
  if (o.calendarEvent) {
    try { ev = cal.getEventById(o.calendarEvent); } catch (err) { ev = null; }
  }
  if (!ev) {
    // No stored id — look for one we made earlier, so a re-run does not
    // leave two entries for the same drop-off.
    var day = new Date(o.deliveryDate + 'T12:00:00');
    cal.getEventsForDay(day).forEach(function (e) {
      if (ev) return;
      try { if (e.getDescription().indexOf(o.id) > -1) ev = e; } catch (err) {}
    });
  }

  if (ev) {
    ev.setTitle(title);
    ev.setDescription(body);
    if (o.venue) ev.setLocation(o.venue);
    try {
      if (start) ev.setTime(start, end);
      else ev.setAllDayDate(new Date(o.deliveryDate + 'T12:00:00'));
    } catch (err) {}
  } else {
    var opts = { description: body };
    if (o.venue) opts.location = o.venue;
    ev = start ? cal.createEvent(title, start, end, opts)
               : cal.createAllDayEvent(title, new Date(o.deliveryDate + 'T12:00:00'), opts);
  }

  var row = orderRowIndex_(o.id);
  var newId = '';
  try { newId = ev.getId(); } catch (err) {}
  if (row !== -1 && newId && newId !== o.calendarEvent) {
    sheet_(TABS.ORDERS).getRange(row, 18).setValue(newId);
  }
  return { ok: true, eventId: newId || o.calendarEvent, title: title };
}

function calendarDropOne_(o) {
  var cal = pcwCalendar_();
  if (!cal || !o || !o.calendarEvent) return;
  try {
    var ev = cal.getEventById(o.calendarEvent);
    if (ev) ev.deleteEvent();
  } catch (err) {}
  var row = orderRowIndex_(o.id);
  if (row !== -1) sheet_(TABS.ORDERS).getRange(row, 18).setValue('');
}

/** Re-sync every dated order. The menu item and the daily trigger use this. */
function syncCalendar_() {
  var cal = pcwCalendar_();
  if (!cal) return 0;
  var touched = 0;
  readOrders_().forEach(function (o) {
    if (!o.deliveryDate) return;
    if (o.status === 'Delivered' || o.status === 'Cancelled') return;
    var r = calendarPushOne_(o.id);
    if (r && r.ok && !r.skipped) touched++;
  });
  return touched;
}

/**
 * The schedule for the app's calendar screen: every dated order, soonest
 * first, with everything the detail view shows. Read from the sheet, so it
 * works whether or not a Google Calendar has been connected.
 */
function schedule_(req) {
  req = req || {};
  var days = num_(req.days) || 60;
  var from = str_(req.from) || today_();
  var cutoff = addDays_(from, days);
  var includeDone = !!req.includeDone;

  var out = [];
  readOrders_().forEach(function (o) {
    if (!o.deliveryDate) return;
    if (!includeDone && (o.status === 'Delivered' || o.status === 'Cancelled')) return;
    if (o.deliveryDate < from || o.deliveryDate > cutoff) return;
    out.push({
      id: o.id, customer: o.customer, phone: o.phone, email: o.contact,
      date: o.deliveryDate, time: o.time, venue: o.venue,
      method: o.method, kind: meetingWord_(o.method), status: o.status,
      notes: o.notes, items: o.items,
      packages: o.items.reduce(function (t, i) { return t + num_(i.packages); }, 0),
      onCalendar: !!o.calendarEvent
    });
  });

  out.sort(function (a, b) {
    return String(a.date).localeCompare(String(b.date)) ||
           String(a.time).localeCompare(String(b.time));
  });
  return { ok: true, from: from, days: days, calendarOn: !!pcwCalendar_(), entries: out };
}

/**
 * The "add to the calendar" button on the calendar screen: takes a customer,
 * their details and what they are getting, writes the order and puts it on
 * the calendar in one go.
 */
function calendarAdd_(req) {
  var customer = str_(req.customer);
  if (!customer) return { ok: false, error: 'Who is it for?' };
  var date = str_(req.date || req.deliveryDate);
  if (!date) return { ok: false, error: 'Which day?' };

  // Items may arrive as SKUs from the app, or as typed names from a phone
  // call — "2 lb ground beef and a pack of smokies" — so resolve the names.
  var products = indexProducts_();
  var lines = [];
  var unmatched = [];
  (req.lines || req.items || []).forEach(function (l) {
    var packages = num_(l.packages) || 1;
    var sku = str_(l.sku);
    if (!sku && str_(l.name || l.what)) {
      var found = resolveProduct_(l.name || l.what);
      if (found.ok && found.confident) sku = found.sku;
      else { unmatched.push(str_(l.name || l.what)); return; }
    }
    if (!sku || !products[sku]) { if (sku) unmatched.push(sku); return; }
    lines.push({ sku: sku, packages: packages, note: str_(l.note) });
  });

  if (!lines.length) {
    return { ok: false, error: unmatched.length
      ? 'Could not match: ' + unmatched.join(', ')
      : 'Nothing in the order yet.' };
  }

  var made = orderNew_({
    customer: customer, contact: str_(req.email || req.contact), phone: str_(req.phone),
    deliveryDate: date, time: str_(req.time), method: str_(req.method) || 'Pickup',
    venue: str_(req.venue), notes: str_(req.notes || req.comments),
    user: str_(req.user), lines: lines
  }, products);
  if (made.error) return { ok: false, error: made.error };

  var cal = calendarPushOne_(made.orderId);
  return {
    ok: true, orderId: made.orderId,
    onCalendar: !!(cal && cal.eventId),
    calendarNote: cal && cal.skipped ? cal.skipped : '',
    unmatched: unmatched
  };
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

/* ===================== ONE CUSTOMER, EVERYTHING =====================
 * Tap a name in the app and get their number, their email, and every order
 * with the date it went out. Pulled together from the four places a purchase
 * can be recorded: the sales history, app orders, whole-animal shares, and
 * whatever they are still waiting on.
 * =================================================================== */

function customerFile_(name) {
  var key = str_(name).toLowerCase();
  if (!key) return { ok: false, error: 'Which customer?' };

  var file = {
    ok: true, name: str_(name), email: '', phone: '', town: '',
    lines: [], waiting: [], orderCount: 0, spend: 0, first: '', last: '', source: '', notes: ''
  };

  var seeName = function (r, nameCol) {
    return str_(r[nameCol]).toLowerCase() === key;
  };

  readTable_(TABS.CUSTOMERS).forEach(function (r) {
    if (!seeName(r, 'Customer')) return;
    file.email = file.email || str_(r['Email']);
    file.phone = file.phone || str_(r['Phone']);
    file.town  = file.town  || str_(r['Town']);
    file.source = file.source || str_(r['Source']);
    file.notes = file.notes || str_(r['Notes']);
    file.spend += num_(r['Spend']) + num_(r['Spend before the app']);
    file.orderCount += num_(r['Orders']) + num_(r['Orders before the app']);
    file.first = file.first || dateStr_(r['First order']);
  });

  // Everything they have bought, with the date.
  readTable_(TABS.HISTORY).forEach(function (r) {
    if (!seeName(r, 'Customer')) return;
    file.lines.push({
      date: dateStr_(r['Date']), what: str_(r['What']), amount: num_(r['Amount']),
      kind: str_(r['Kind']) || 'Sale', how: str_(r['Payment']), where: 'sales sheet',
      note: str_(r['Notes'])
    });
  });

  readTable_(TABS.ORDERS).forEach(function (r) {
    if (!seeName(r, 'Customer')) return;
    var items = [];
    readTable_(TABS.ORDERITEMS).forEach(function (it) {
      if (str_(it['Order ID']) !== str_(r['Order ID'])) return;
      items.push(num_(it['Packages']) + ' × ' + (str_(it['Product']) || str_(it['SKU'])));
    });
    file.lines.push({
      date: dateStr_(r['Delivery date']) || dateStr_(r['Created']),
      what: items.join(', ') || str_(r['Notes']) || 'Order ' + str_(r['Order ID']),
      amount: num_(r['Value']), kind: 'Order', how: str_(r['Method']),
      where: 'app', status: str_(r['Status']), orderId: str_(r['Order ID']),
      note: str_(r['Notes'])
    });
  });

  readTable_(TABS.WHOLESALE).forEach(function (r) {
    if (!seeName(r, 'Customer')) return;
    file.email = file.email || str_(r['Email']);
    file.phone = file.phone || str_(r['Phone']);
    var invoiced = str_(r['Invoice']) || num_(r['Weight (lb)']);
    if (!invoiced) {
      if (str_(r['Wants'])) file.waiting.push(str_(r['Wants']) + ' (whole animal list)');
      return;
    }
    file.lines.push({
      date: dateStr_(r['Added']),
      what: str_(r['Wants']) || 'Whole animal share',
      amount: num_(r['Price']), kind: 'Whole animal', how: '',
      where: 'wholesale', invoice: str_(r['Invoice']),
      weight: num_(r['Weight (lb)']), note: str_(r['Notes'])
    });
  });

  readTable_(TABS.WAITLIST).forEach(function (r) {
    if (!seeName(r, 'Customer')) return;
    file.email = file.email || str_(r['Email']);
    file.phone = file.phone || str_(r['Phone']);
    var w = str_(r['Their words']) || str_(r['Waiting for']);
    if (w && file.waiting.indexOf(w) === -1) file.waiting.push(w);
  });

  // Newest first, and anything undated sinks to the bottom rather than
  // pretending to be the oldest.
  file.lines.sort(function (a, b) {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return String(b.date).localeCompare(String(a.date));
  });

  var dated = file.lines.filter(function (l) { return l.date; });
  if (dated.length) {
    file.last = dated[0].date;
    file.first = file.first || dated[dated.length - 1].date;
  }
  // The CUSTOMERS tab's own counts can lag, so fall back to what we can see.
  if (!file.orderCount) file.orderCount = file.lines.length;
  if (!file.spend) {
    file.spend = file.lines.reduce(function (t, l) { return t + num_(l.amount); }, 0);
  }
  file.spend = Math.round(file.spend * 100) / 100;
  return file;
}

/* ======================= FINDING A CUT BY NAME =======================
 * Butcher labels and the way people talk never match the SKU list exactly.
 * "ExL Denver" is an extra-large Denver. "Flat iron" is Flat Iron. "2lb GB"
 * is Ground Beef 2 lb. "Pichana" is a misspelt Picanha.
 *
 * So: throw away the words that describe a size or a grade rather than the
 * cut, expand the shorthand we know, then score what is left against the
 * product list. Words that genuinely distinguish two products — steak
 * against roast — are kept and count for a lot.
 *
 * Returns the best match, how sure we are, and the runners-up, so the caller
 * can ask rather than guess when it is close.
 * ==================================================================== */

// Words about size or grade. They never pick the cut, so they go.
var NOISE_WORDS = ('exl exlarge extralarge xxl xl lg large med medium sm small reg regular ' +
  'gold silver bronze platinum black bms grade graded ' +
  'pkg pkgs pack packs package packages pcs pc piece pieces ea each ' +
  'lb lbs pound pounds kg kgs kilo kilos oz ' +
  'wagyu beef pcw fresh frozen approx avg').split(' ');

// Shorthand and other names for the same thing, including the ones that turn
// up on labels from the butcher.
var NAME_ALIASES = {
  'gb': 'ground beef', 'grd beef': 'ground beef', 'hamburger': 'ground beef',
  'osso buco': 'shank steak', 'osso bucco': 'shank steak', 'ossobuco': 'shank steak',
  'zabuton': 'denver', 'denver cut': 'denver',
  'sirloin cap': 'picanha', 'coulotte': 'picanha', 'culotte': 'picanha',
  'pichana': 'picanha', 'picana': 'picanha', 'pikanha': 'picanha',
  'new york': 'striploin', 'ny strip': 'striploin', 'strip loin': 'striploin',
  'filet': 'tenderloin', 'filet mignon': 'tenderloin', 'fillet': 'tenderloin',
  'rib eye': 'ribeye', 'ribsteak': 'ribeye', 'rib steak': 'ribeye',
  'tri tip': 'tri tip', 'santa maria': 'tri tip',
  'smokie': 'smokies', 'pepperoni': 'pepperoni', 'pepperonis': 'pepperoni',
  'patty': 'patties', 'burger': 'patties',
  'brkfst sausage': 'breakfast sausage', 'bfast sausage': 'breakfast sausage'
};

function normName_(s) {
  s = ' ' + str_(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  // Multi-word aliases first, so "sirloin cap" beats "sirloin".
  Object.keys(NAME_ALIASES).forEach(function (k) {
    if (k.indexOf(' ') === -1) return;
    s = s.split(' ' + k + ' ').join(' ' + NAME_ALIASES[k] + ' ');
  });
  return s.trim();
}

function nameTokens_(s) {
  var out = [];
  normName_(s).split(' ').forEach(function (w) {
    if (!w) return;
    if (NAME_ALIASES[w]) w = NAME_ALIASES[w];
    // A bare number is a size or a BMS score, not a cut — unless it is part
    // of a pack size like "20 lb", which the content field handles anyway.
    if (/^\d+$/.test(w)) return;
    w.split(' ').forEach(function (part) {
      if (part && NOISE_WORDS.indexOf(part) === -1) out.push(part);
    });
  });
  return out;
}

/** How many single-character edits apart two words are. */
function editDistance_(a, b) {
  a = String(a); b = String(b);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  var prev = [], cur = [], i, j;
  for (j = 0; j <= b.length; j++) prev[j] = j;
  for (i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1)
      );
    }
    for (j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/** Does this query word match that product word, allowing for a typo? */
function wordMatches_(q, p) {
  if (q === p) return 1;
  if (p.indexOf(q) === 0 || q.indexOf(p) === 0) return 0.9;   // plural, truncation
  var allow = q.length <= 4 ? 0 : (q.length <= 7 ? 1 : 2);
  if (allow && editDistance_(q, p) <= allow) return 0.75;
  return 0;
}

/**
 * Did the query name a size or a pack count, and does this product carry it?
 * Returns a bonus, a penalty, or nothing when no size was asked for.
 */
function sizeAgreement_(query, haystack) {
  var q = String(query).toLowerCase();
  var h = String(haystack).toLowerCase();
  var checks = [
    /(\d+(?:\.\d+)?)\s*(?:lb|lbs|pound|pounds)/,
    /(\d+)\s*(?:x|-)?\s*(?:pack|packs|pk|patties|patty|count|ct)/
  ];
  var verdict = 0;
  for (var i = 0; i < checks.length; i++) {
    var asked = q.match(checks[i]);
    if (!asked) continue;
    var has = h.match(checks[i]);
    if (!has) continue;
    if (Number(has[1]) === Number(asked[1])) verdict += 0.2;
    else verdict -= 0.5;
  }
  return verdict;
}

/**
 * Find the product someone means.
 * opts.activeOnly — skip retired products (default true)
 * Returns { ok, sku, product, score, confident, why, alternatives:[{sku,product,score}] }
 */
function resolveProduct_(text, opts) {
  opts = opts || {};
  var qTokens = nameTokens_(text);
  if (!qTokens.length) return { ok: false, error: 'Nothing to look up.' };

  var qNorm = qTokens.join(' ');
  var scored = [];

  readTable_(TABS.PRODUCTS).forEach(function (p) {
    var sku = str_(p['SKU']);
    if (!sku) return;
    if (opts.activeOnly !== false && !yes_(p['Active'])) return;

    var name = str_(p['Product']);
    // The content field carries pack sizes like "2 lb", which is how people
    // tell one ground beef from another.
    var hay = nameTokens_(name + ' ' + str_(p['Content']));
    var hayNorm = nameTokens_(name).join(' ');
    if (!hay.length) return;

    // The category satisfies a trailing "steak" or "roast" that the product
    // name itself leaves out: "ribeye steak" is a Steak called Ribeye, and
    // should not be dragged towards Skirt Steak just for sharing a word.
    var cat = nameTokens_(str_(p['Category']));

    var hit = 0;
    qTokens.forEach(function (q) {
      var best = 0;
      hay.forEach(function (h) { best = Math.max(best, wordMatches_(q, h)); });
      if (best < 0.9) {
        cat.forEach(function (ct) { best = Math.max(best, wordMatches_(q, ct) * 0.9); });
      }
      hit += best;
    });

    // Every query word has to land somewhere, and we prefer the product that
    // says the least beyond what was asked — so "cross rib" leans to the
    // shorter "Cross Rib Roast" over a longer name that also contains it.
    var coverage = hit / qTokens.length;
    var tightness = qTokens.length / Math.max(qTokens.length, hay.length);
    var score = coverage * 0.75 + tightness * 0.25;

    if (qNorm === hayNorm) score = 1;                      // exact, once tidied
    else if (hayNorm.indexOf(qNorm) === 0) score += 0.06;   // "cross rib" → "cross rib roast"

    // A size or pack count that was asked for and does not match is
    // disqualifying: "2 lb ground beef" must not come back as the 20 lb one,
    // and "5 pack burger patties" must not come back as the 30-pack.
    score += sizeAgreement_(text, name + ' ' + str_(p['Content']));

    score = Math.min(1, Math.max(0, score));
    if (score > 0.25) scored.push({ sku: sku, product: name, score: Math.round(score * 1000) / 1000 });
  });

  if (!scored.length) {
    return { ok: false, error: 'Nothing on the product list looks like "' + str_(text) + '".' };
  }

  scored.sort(function (a, b) { return b.score - a.score || a.product.length - b.product.length; });
  var top = scored[0];
  var second = scored[1];

  // Only show runners-up that are genuinely in the running, so an "is it this
  // or that?" question lists real candidates and not the whole shelf.
  var near = scored.slice(1).filter(function (x) { return top.score - x.score < 0.15; }).slice(0, 3);

  // An exact match, once the size and grade words are stripped, is the answer
  // — something else scoring close does not make it doubtful.
  var exact = top.score >= 0.995;
  var clear = exact || !second || (top.score - second.score) >= 0.08;
  return {
    ok: true, sku: top.sku, product: top.product, score: top.score,
    confident: clear && top.score >= 0.6,
    why: exact ? 'exact' : (clear ? 'best match' : 'more than one fits'),
    alternatives: near
  };
}

/** What a cut costs, by name rather than by SKU, defaulting to the house grade. */
function priceByName_(req) {
  var found = resolveProduct_(req.name || req.text || req.sku);
  if (!found.ok) return { ok: false, error: found.error };
  if (!found.confident && found.alternatives.length) {
    return {
      ok: false, needsPick: true,
      error: 'Did you mean ' + found.product + ', or ' +
        found.alternatives.map(function (a) { return a.product; }).join(' or ') + '?',
      options: [{ sku: found.sku, product: found.product }].concat(found.alternatives)
    };
  }
  var q = quote_({
    sku: found.sku, weight: req.weight, kg: req.kg,
    channel: req.channel, batch: req.batch
  });
  if (q.ok) {
    q.matchedFrom = str_(req.name || req.text);
    q.matchWhy = found.why;
  }
  return q;
}

/* ========================== WHO IS SIGNED IN ==========================
 * The phone app signs people in with their Google account — the same way the
 * PRO timesheet app does, and with the same OAuth client, because both apps
 * are served from https://proespaul.github.io.
 *
 * Nobody types a token. The app hands us the short-lived Google ID token,
 * we ask Google to confirm it, we check the person is allowed, and we hand
 * back a session token that lasts a day.
 *
 * Anyone with a pcwagyu.com Google account gets in and is written onto the
 * STAFF tab the first time, so you can see who has been in and switch them
 * off. Anyone else has to be on that tab already.
 * ===================================================================== */

/* Bumped on every delivery, reported by ping, and shown in the app's
 * settings — so "did the redeploy take?" has an answer. */
var BACKEND_BUILD = '2026-10-27 18:30 UTC';

var GOOGLE_CLIENT_ID = '378684710856-ptq2bpavssjjii856ufbuu03uef97ivr.apps.googleusercontent.com';
// Both company domains are let in without being listed by hand: PCW staff sign
// in with pcwagyu.com, and the ProES side (Paul, the office) with proes.ca.
// Anyone outside both still has to be on the STAFF tab.
var HOME_DOMAINS = ['pcwagyu.com', 'proes.ca'];
var HOME_DOMAIN = HOME_DOMAINS[0];   // the one Kenji signs as
// Long on purpose: a session that lapses while somebody is standing in the
// freezer with no signal locks them out of recording anything, and Google
// cannot be reached to sign them back in. Ninety days means that effectively
// never happens. It is only safe to be this long because readSession_ below
// re-checks the STAFF tab on every single request — see the note there.
var SESSION_DAYS = 90;

/** Ask Google whether this sign-in is real, and who it belongs to. */
function verifyGoogleToken_(idToken) {
  idToken = str_(idToken);
  if (!idToken) throw new Error('No Google sign-in was sent.');

  // A hiccup reaching Google is not a bad sign-in. Without this retry a blip
  // bounces somebody back to the sign-in screen for no reason.
  var res = null;
  var waits = [400, 1200, 3000];
  for (var i = 0; ; i++) {
    var code = 0;
    try {
      res = UrlFetchApp.fetch(
        'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
        { muteHttpExceptions: true });
      code = res.getResponseCode();
    } catch (netErr) {
      code = 0;   // could not reach Google at all
    }
    if (code === 200) break;
    // 400 means Google looked and said no: that is an answer, not a blip.
    if (code === 400 || code === 401) {
      throw new Error('Google could not confirm that sign-in. Please try again.');
    }
    if (i >= waits.length) {
      throw new Error('Could not reach Google to check that sign-in. Try again in a moment.');
    }
    Utilities.sleep(waits[i]);
  }

  var p;
  try { p = JSON.parse(res.getContentText()); }
  catch (err) { throw new Error('Google sent back something we could not read.'); }

  // The audience check is the important one: it proves the sign-in was issued
  // for THIS app and not borrowed from somewhere else.
  if (str_(p.aud) !== GOOGLE_CLIENT_ID) throw new Error('That sign-in was issued for a different app.');
  if (str_(p.email_verified) !== 'true') throw new Error('That Google account does not have a verified email.');
  if (num_(p.exp) * 1000 < Date.now()) throw new Error('That sign-in has already expired. Please try again.');

  var email = str_(p.email).toLowerCase();
  if (!email) throw new Error('Google did not send an email address back.');
  return { email: email, name: str_(p.name) || email };
}

/** Is this email allowed in, and under what name? */
/* The question login_ asks: may this person in? staffVerdict_ does the work;
 * this just turns "we could not tell" into a refusal, because a sign-in has
 * to give a yes or a no. An existing session is treated more kindly — see
 * readSession_. */
function whoIsAllowed_(email) {
  var v = staffVerdict_(email);
  return {
    ok: !!v.ok,
    certain: v.certain !== false,
    needJoin: !!v.needJoin,
    name: v.name,
    role: v.role,
    firstTime: !!v.firstTime,
    why: v.why
  };
}

/* ─────────────────────── the join word ───────────────────────
 * One shared word, kept on the SETTINGS tab, that lets a family member with
 * any Google account add themselves. They type it once, ever: joining writes
 * them onto the STAFF tab, so every later sign-in just works. Change the word
 * on the tab whenever you like; it only affects people joining from then on,
 * never anyone already listed.
 * ------------------------------------------------------------ */
var JOIN_WORD_KEY = 'JOIN_WORD';
var JOIN_WORD_DEFAULT = 'wagyu';

function joinWord_() {
  var w = str_(settings_()[JOIN_WORD_KEY]);
  return (w || JOIN_WORD_DEFAULT).trim().toLowerCase();
}

/** Did they type the word? Spaces and capitals are forgiven — it is spoken aloud. */
function joinWordMatches_(typed) {
  var t = str_(typed).replace(/\s+/g, '').toLowerCase();
  if (!t) return false;
  return t === joinWord_().replace(/\s+/g, '');
}

/** Put a joiner on the STAFF tab so they never need the word again. */
function joinStaff_(email, name) {
  sheet_(TABS.STAFF).appendRow([
    email, name || '', 'Staff', 'Yes', new Date(),
    'Let themselves in with the join word. Set Active to No to block them.'
  ]);
}

/** First time a pcwagyu.com account signs in, put it on the STAFF tab. */
function rememberStaff_(email, name) {
  var seen = false;
  readTable_(TABS.STAFF).forEach(function (r) {
    if (str_(r.Email).toLowerCase() === str_(email).toLowerCase()) seen = true;
  });
  if (seen) return;
  sheet_(TABS.STAFF).appendRow([
    email, name || '', 'Staff', 'Yes', new Date(),
    'On a company domain, so added automatically. Set Active to No to block them.'
  ]);
}

/* =====================================================================
 * SESSIONS
 *
 * A session used to be a random token with its details kept in the script's
 * property store. That was the cause of people being thrown out mid-count:
 *
 *   - the property store is one shared blob, and two of the app's requests
 *     landing at the same moment could lose each other's writes, taking a
 *     live session with them; and
 *   - any wobble in reading the STAFF tab deleted the session outright, so a
 *     one-second blip cost a full Google sign-in to recover.
 *
 * Now a session is a signed note the phone carries: who they are and when it
 * runs out, with a signature only this script can produce. Nothing is stored
 * server-side, so there is nothing to lose, nothing to clean up, and no
 * property read or write on each request. Revoking still works, because the
 * STAFF tab is checked on every request — see readSession_.
 * ===================================================================== */
var SESSION_SECRET_KEY = 'SESSION_SECRET';

/** The signing secret, made once and kept for good. */
function sessionSecret_() {
  var props = PropertiesService.getScriptProperties();
  var secret = str_(props.getProperty(SESSION_SECRET_KEY));
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty(SESSION_SECRET_KEY, secret);
  }
  return secret;
}

function b64url_(bytesOrString) {
  var raw = typeof bytesOrString === 'string'
    ? Utilities.base64EncodeWebSafe(bytesOrString, Utilities.Charset.UTF_8)
    : Utilities.base64EncodeWebSafe(bytesOrString);
  return raw.replace(/=+$/, '');
}

function signPayload_(payload) {
  return b64url_(Utilities.computeHmacSha256Signature(payload, sessionSecret_()));
}

/** Compare without leaking which character differed. */
function sameSignature_(a, b) {
  a = str_(a); b = str_(b);
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return diff === 0;
}

/* Signing out has to mean something even with nothing stored per session, or
 * a lost phone could not be cut off. So each note records when it was issued,
 * and signing out writes a floor for that person: notes issued before the
 * floor are refused. One small property read per request, no write. */
function logoutFloorKey_(email) {
  return 'SIGNED_OUT_' + str_(email).toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function logoutFloor_(email) {
  try {
    return num_(PropertiesService.getScriptProperties()
      .getProperty(logoutFloorKey_(email)));
  } catch (err) { return 0; }
}

function newSession_(who) {
  var now = Date.now();
  var exp = now + SESSION_DAYS * 24 * 3600 * 1000;
  var body = JSON.stringify({ e: who.email, n: who.name, r: who.role, x: exp, i: now, v: 1 });
  var payload = b64url_(body);
  return { sessionToken: payload + '.' + signPayload_(payload), exp: exp };
}

/* Every refused request, written down. Rare by design: if this tab starts
 * filling up, that is the symptom and the reason is right there in it.
 * Trimmed so it can never grow without bound. */
function logSignInTrouble_(action, why, email, req) {
  try {
    var sh = null;
    // Make the tab on demand rather than waiting for a setup() run — the
    // whole point is to be there the next time somebody is thrown out.
    try { sh = sheet_(TABS.SIGNINLOG); } catch (missing) {
      sh = ss_().insertSheet(TABS.SIGNINLOG);
      sh.appendRow(HEADERS.SIGNINLOG);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, HEADERS.SIGNINLOG.length).setFontWeight('bold');
    }
    sh.appendRow([new Date(), str_(email), str_(action), str_(why)]);
    var last = sh.getLastRow();
    if (last > 300) sh.deleteRows(2, last - 200);
  } catch (err) { /* logging must never be the thing that breaks a request */ }
}

/* Why the last session was refused, for the error message and the log. Being
 * thrown out mid-count with no explanation is the thing that has cost the
 * most time on this app, so the reason is now always recorded. */
var LAST_REJECT = '';
var LAST_REJECT_EMAIL = '';

function rejectSession_(why, email) {
  LAST_REJECT = why;
  LAST_REJECT_EMAIL = str_(email);
  return null;
}

/* Read the note the phone sent. Returns null only when the note is not ours,
 * has run out, or the STAFF tab says, clearly, that this person is out. */
function readSession_(token) {
  token = str_(token);
  LAST_REJECT = ''; LAST_REJECT_EMAIL = '';
  if (!token) return rejectSession_('no sign-in was sent');

  var dot = token.indexOf('.');
  if (dot < 1) return rejectSession_('the sign-in was not in a shape we recognise');
  var payload = token.slice(0, dot);
  var signature = token.slice(dot + 1);
  if (!sameSignature_(signature, signPayload_(payload))) {
    return rejectSession_('the sign-in was not signed by this backend ' +
                          '(it may have been issued before the last redeploy)');
  }

  var s;
  try {
    s = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(payload)).getDataAsString());
  } catch (err) { return rejectSession_('the sign-in could not be read'); }
  if (!s || !str_(s.e)) return rejectSession_('the sign-in had no account on it');
  if (num_(s.x) < Date.now()) {
    return rejectSession_('the sign-in ran out on ' +
      Utilities.formatDate(new Date(num_(s.x)), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      s.e);
  }

  // Issued before this person last signed out, so it is no longer theirs.
  if (num_(s.i) && num_(s.i) < logoutFloor_(str_(s.e))) {
    return rejectSession_('somebody signed this account out', s.e);
  }

  var me = { email: str_(s.e), name: str_(s.n) || str_(s.e), role: str_(s.r) || 'Staff' };

  // The STAFF tab is still what decides who is in, so switching somebody off
  // bites on their very next tap. But a wobble reading that tab must NOT cost
  // somebody their session: the note is already signed, so when the answer is
  // not trustworthy we let them carry on and ask again next time.
  var verdict = staffVerdict_(me.email);
  if (verdict.certain && !verdict.ok) {
    return rejectSession_('the STAFF tab says: ' + (verdict.why || 'not allowed'), me.email);
  }
  if (verdict.ok) {
    if (verdict.name) me.name = verdict.name;
    if (verdict.role) me.role = verdict.role;
  }

  // Renew by handing back a fresh note. No storage, so this costs nothing.
  if (num_(s.x) - Date.now() < (SESSION_DAYS - 1) * 24 * 3600 * 1000) {
    var fresh = newSession_(me);
    me.renewedToken = fresh.sessionToken;
    me.renewedExp = fresh.exp;
  } else {
    me.renewedExp = num_(s.x);
  }
  return me;
}

/* Is this person allowed in, and is the answer trustworthy?
 *
 * "certain" is the important part. It is only true when we actually read the
 * STAFF tab and can believe what it said. If the read threw, or came back
 * empty when the tab cannot be empty (it always has Paul's own row and a
 * header), we say so instead of pretending the person is a stranger. */
function staffVerdict_(email) {
  email = str_(email).toLowerCase();
  var domain = email.split('@')[1] || '';
  var home = HOME_DOMAINS.indexOf(domain) !== -1;

  var rows = null;
  try {
    rows = keepTrying_('Reading the STAFF tab', function () { return readTable_(TABS.STAFF); });
  } catch (err) { rows = null; }

  // The tab is never legitimately empty — it has a header and at least one
  // row — so an empty answer means the read did not really work.
  var trustworthy = !!(rows && rows.length);

  if (!trustworthy) {
    // A company address does not depend on the tab, so let them carry on.
    if (home) {
      return { ok: true, certain: true, name: email, role: 'Staff', firstTime: true };
    }
    // Anyone else: say plainly that we do not know, rather than calling them a
    // stranger. readSession_ keeps their session; login_ asks them to retry.
    return { ok: false, certain: false,
             why: 'Could not check the STAFF tab just now. Try again in a moment.' };
  }

  var listed = null;
  rows.forEach(function (r) {
    if (str_(r.Email).toLowerCase() === email) listed = r;
  });

  // Listed is listed: the tab decides, company address or not, so Active = No
  // switches anybody off.
  if (listed) {
    if (!yes_(listed.Active)) {
      return { ok: false, certain: true,
               why: 'That account has been switched off on the STAFF tab.' };
    }
    return { ok: true, certain: true,
             name: str_(listed.Name) || email, role: str_(listed.Role) || 'Staff' };
  }

  if (home) {
    return { ok: true, certain: true, name: email, role: 'Staff', firstTime: true };
  }

  return { ok: false, certain: true, needJoin: true,
           why: 'Type the join word to let yourself in.' };
}

/** Trade a Google sign-in for a day-long session, and send the app its data. */
function login_(idToken, joinWord) {
  var who = verifyGoogleToken_(idToken);
  var allowed = whoIsAllowed_(who.email);

  // An unlisted account can let itself in by typing the join word.
  var joining = false;
  if (!allowed.ok && allowed.needJoin) {
    if (!str_(joinWord)) {
      return { ok: false, needJoin: true, error: allowed.why };
    }
    if (!joinWordMatches_(joinWord)) {
      return { ok: false, needJoin: true, error: 'That is not the join word. Ask Paul or Hannah for it.' };
    }
    joining = true;
    allowed = { ok: true, name: who.name || who.email, role: 'Staff' };
  }
  if (!allowed.ok) {
    // We could not read the tab, so this is a "try again", not a refusal —
    // and the app knows not to treat it as one.
    if (!allowed.certain) return { ok: false, retry: true, error: allowed.why };
    return { ok: false, error: allowed.why };
  }

  var name = allowed.name && allowed.name !== who.email ? allowed.name : (who.name || who.email);
  if (joining) joinStaff_(who.email, name);
  else if (allowed.firstTime) rememberStaff_(who.email, name);

  var s = newSession_({ email: who.email, name: name, role: allowed.role });

  // Deliberately no data here. Fetching it was the slow part of signing in —
  // a dozen sheet reads and an inventory recount — and it is what made getting
  // back in feel like a punishment. The phone asks for data straight after,
  // and if it still has yesterday's it gets told "nothing new" in a few bytes.
  // So signing in is now one Google check, one tab read, and done.
  return {
    ok: true, sessionToken: s.sessionToken, exp: s.exp,
    me: { email: who.email, name: name, role: allowed.role }
  };
}

/* The phone throws its note away, and we raise a floor for that person so any
 * note already issued to them — on this phone or another — stops working. */
function logout_(token) {
  var me = readSession_(token);
  if (me && me.email) {
    try {
      PropertiesService.getScriptProperties()
        .setProperty(logoutFloorKey_(me.email), String(Date.now()));
    } catch (err) {}
  }
  return { ok: true };
}

/* =====================================================================
 * COUNTING BY PHOTO
 *
 * Point the camera at a pile of packs and the app proposes what it sees. Two
 * different jobs, in order of how much they can be trusted:
 *
 *   1. A butcher's printed label. This is reading text, so it is reliable,
 *      and the pack goes to the right product.
 *   2. Unlabelled meat. This is a judgement call, and a Denver and a flat
 *      iron genuinely look alike on a tray. Useful as a first guess, nothing
 *      more.
 *
 * So NOTHING is ever written from a photo. The reply is a proposal: the app
 * shows it, the person fixes it, and only then does an ordinary ledger entry
 * get made, signed with their name like any other. That is deliberate — a
 * miscounted photo that wrote itself into the ledger would be worse than no
 * photo feature at all.
 * ===================================================================== */
var CLAUDE_KEY_SETTING = 'CLAUDE_API_KEY';
var CLAUDE_MODEL_SETTING = 'CLAUDE_MODEL';
/* One model for everything: quick, cheap enough to ask anything, and reliable
 * at returning the structured answer the confirmation card is built from.
 * It lives on the SETTINGS tab so the name can change without touching this
 * file — but there is only ever one, and nobody using the app has to choose. */
var CLAUDE_MODEL_DEFAULT = 'claude-sonnet-5-5';

function photoPrompt_(names) {
  return [
    'You are helping count packs of beef in a freezer for a small farm.',
    '',
    'Look at the photo and do ONE of these:',
    '',
    'A) If a printed butcher label is readable, read it. Report the cut name',
    '   exactly as printed, the pack count if printed, and the weight if printed.',
    '   Set "from" to "label".',
    '',
    'B) If there is no readable label, identify the cuts and count the packs',
    '   you can actually see. Set "from" to "meat".',
    '',
    'These are the only products that exist. Use these names verbatim where',
    'you can; if unsure which of two it is, pick the likelier and say so in',
    '"note":',
    names.join('; '),
    '',
    'Rules:',
    '- Count only packs you can clearly see. Never estimate what is hidden',
    '  underneath a pile. If packs are obscured, say so in "note".',
    '- "confidence" is one of "high", "medium", "low".',
    '- If you cannot tell what the meat is, return an empty "lines" array and',
    '  explain in "note". Guessing is worse than saying you do not know.',
    '',
    'Reply with JSON only, no other text, in exactly this shape:',
    '{"from":"label|meat","note":"...","lines":[',
    '  {"product":"...","count":1,"weightLb":0,"confidence":"high","note":""}',
    ']}'
  ].join('\n');
}

/* ═══════════════════════ KENJI, IN THE APP ═══════════════════════
 * Ask a question out loud and get an answer; say what you did to the freezer
 * and get a card back asking whether that is what you meant.
 *
 * Two rules hold this together:
 *
 *  1. This action NEVER writes. It answers, and at most it PROPOSES a change.
 *     The proposal goes back to the phone, the phone shows it, and only a tap
 *     sends it through submit_ — the same path as every button in the app, so
 *     every stock check, every guard and the offline queue still apply. A
 *     misheard word costs a tap, not a ledger entry.
 *
 *  2. The proposal is checked against what actually exists before it leaves
 *     here. A SKU nobody has, a freezer that was never set up, a reason that
 *     is not on the list — all refused, with Kenji saying so rather than the
 *     app discovering it later.
 */

var KENJI_MAX_TURNS = 6;      // how much of the conversation to carry back

/* A cheap fingerprint of "has anything changed": the version counter every
 * write bumps, plus the two row counts that move when somebody edits the
 * sheet directly. Two getLastRow calls, against the seven-sheet read that
 * building the snapshot costs. */
function kenjiStamp_() {
  var v = '0', mv = 0, pr = 0;
  try { v = str_(PropertiesService.getScriptProperties().getProperty(DATA_VERSION_KEY)) || '0'; } catch (e) {}
  try { mv = sheet_(TABS.MOVEMENTS).getLastRow(); } catch (e2) {}
  try { pr = sheet_(TABS.PRODUCTS).getLastRow(); } catch (e3) {}
  return v + '.' + mv + '.' + pr;
}

/* Everything Kenji needs to know, as small as it will go. The model is being
 * asked about a freezer, not handed a database, so names and numbers only.
 *
 * Building it reads seven tabs, which is most of the wait before Kenji even
 * starts thinking. So it is kept for ninety seconds against the fingerprint
 * above: ask three questions in a row and only the first pays for the reads.
 * The short life is the backstop — a price edited straight into the sheet
 * without adding a row would not move the fingerprint, and ninety seconds is
 * as stale as that can ever get.
 */
var KENJI_SNAP_SECS = 90;

function kenjiSnapshot_() {
  var key = 'KENJI_SNAP_' + kenjiStamp_();
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }
  if (cache) {
    var hit = cache.get(key);
    if (hit) { try { return JSON.parse(hit); } catch (e2) {} }
  }
  var snap = kenjiBuildSnapshot_();
  if (cache) {
    try { cache.put(key, JSON.stringify(snap), KENJI_SNAP_SECS); } catch (e3) {}
  }
  return snap;
}

function kenjiBuildSnapshot_() {
  var products = indexProducts_();
  var stock = currentStock_();
  var cfg = settings_();
  var committed = committedBySku_();

  var onHand = {};
  stock.forEach(function (l) { onHand[l.sku] = (onHand[l.sku] || 0) + l.packages; });

  var lines = stock.filter(function (l) { return l.packages !== 0; }).map(function (l) {
    var row = { sku: l.sku, freezer: l.freezer, packs: l.packages };
    if (l.batch) row.batch = l.batch;
    if (l.grade) row.grade = l.grade;
    if (l.size)  row.size = l.size;
    if (l.weight) row.lb = Math.round(l.weight * 10) / 10;
    return row;
  });

  var cat = Object.keys(products).filter(function (k) { return products[k].active !== false; })
    .map(function (k) {
      var p = products[k];
      var cp = channelPrices_(p, cfg);
      var row = { sku: p.sku, name: p.product, cat: p.category, onHand: onHand[p.sku] || 0 };
      if (p.content) row.pack = p.content;
      if (cp.wholesalePerLb) { row.listLb = cp.wholesalePerLb; row.webLb = cp.websitePerLb; row.mktLb = cp.marketPerLb; }
      if (cp.wholesalePerPack) { row.listPack = cp.wholesalePerPack; row.webPack = cp.websitePerPack; row.mktPack = cp.marketPerPack; }
      if (committed[p.sku]) row.promised = committed[p.sku];
      if (p.reorder !== '' && p.reorder !== undefined) row.tellMeBelow = p.reorder;
      return row;
    });

  // A ribeye inside a made-up box is still a ribeye in the freezer. Without
  // the recipes Kenji can only count loose packs, and "how many ribeye have
  // we got, boxes included" has no answer.
  var boxes = [];
  try {
    var recipes = boxRecipes_();
    Object.keys(recipes).forEach(function (boxSku) {
      var p = products[boxSku];
      boxes.push({
        sku: boxSku,
        name: p ? p.product : boxSku,
        madeUp: onHand[boxSku] || 0,
        holds: recipes[boxSku].map(function (c) { return { sku: c.sku, each: c.qty }; })
      });
    });
  } catch (errBox) { boxes = []; }

  // Who has ordered before, so a first name can be matched to a whole one
  // instead of a new customer being invented from a half-heard word.
  var customers = [];
  try {
    var seen = {};
    readOrders_().slice(-40).reverse().forEach(function (o) {
      var n = str_(o.customer);
      if (n && !seen[n.toLowerCase()]) { seen[n.toLowerCase()] = true; customers.push(n); }
    });
    customers = customers.slice(0, 25);
  } catch (errCust) { customers = []; }

  return {
    today: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    boxes: boxes,
    customers: customers,
    channels: CHANNELS,
    groundBeef: {
      skus: settingList_(cfg, GB_SKUS_SETTING, GB_SKUS_DEFAULT),
      orderAs: 'GROUND-BEEF-2-LB',
      bands: gbTiers_(cfg).map(function (t) { return { fromLb: t.from, perLb: t.rate }; })
    },
    freezers: indexFreezers_().filter(function (f) { return f.active !== false; })
      .map(function (f) { return { id: f.id, name: f.name || f.id }; }),
    batches: indexBatches_().map(function (b) {
      return { id: b.id, went_in: b.packDate || b.killDate || '', grade: b.grade };
    }),
    products: cat,
    inTheFreezer: lines,
    markups: { website: pctOf_(cfg.WEBSITE_MARKUP, 30), farmersMarket: pctOf_(cfg.MARKET_MARKUP, 15) }
  };
}

/* ── the hourly brief ──
 * Kenji's bridge writes a full picture of the business into one cell of its
 * own log every hour: drop-offs, open orders, who has not paid, e-transfers,
 * email. The app's Kenji reads it so a question about an order does not come
 * back "I only know about the freezer".
 *
 * Only two fields are taken: when it was written, and the written brief
 * itself. Everything else in that cell — the email list above all — is never
 * unpacked here, so it cannot leak into a prompt by accident later.
 *
 * A failed read is not an error anybody should see. If the log cannot be
 * opened, the cell is empty, or the JSON is broken, Kenji simply carries on
 * knowing what he always knew, and the inventory answers are unaffected.
 */
var KENJI_BRIEF_ID    = '1p7q-aZptYpuwol-msrJtPTzL09GQ5zVXY5YLZZbhrGw';
var KENJI_BRIEF_TAB   = 'Brief';
var KENJI_BRIEF_CELL  = 'C2';
var KENJI_BRIEF_CACHE = 'KENJI_BRIEF_V1';
var KENJI_BRIEF_SECS  = 600;          // ten minutes, as asked
var KENJI_BRIEF_MAX   = 6000;         // a prompt, not an archive
var KENJI_BRIEF_MISS  = '-';          // a failed read is cached too, see below

function kenjiBrief_() {
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }
  if (cache) {
    var hit = cache.get(KENJI_BRIEF_CACHE);
    // A miss is remembered as well as a hit. Without that, a log we cannot
    // open would be reopened on every single question.
    if (hit === KENJI_BRIEF_MISS) return null;
    if (hit) { try { return JSON.parse(hit); } catch (e2) { /* fall through */ } }
  }

  var out = null;
  try {
    var sh = SpreadsheetApp.openById(KENJI_BRIEF_ID).getSheetByName(KENJI_BRIEF_TAB);
    if (sh) {
      var raw = str_(sh.getRange(KENJI_BRIEF_CELL).getValue());
      if (raw) {
        var j = JSON.parse(raw);
        var text = str_(j.text);
        if (text) {
          out = { asOfLocal: str_(j.asOfLocal), text: text.slice(0, KENJI_BRIEF_MAX) };
        }
      }
    }
  } catch (err) {
    out = null;                       // no access, no tab, no JSON — all the same
  }

  if (cache) {
    try {
      cache.put(KENJI_BRIEF_CACHE, out ? JSON.stringify(out) : KENJI_BRIEF_MISS,
                KENJI_BRIEF_SECS);
    } catch (e3) { /* a cache that will not hold is still not an error */ }
  }
  return out;
}

var KENJI_CATS = ['Steak', 'Roast', 'Ribs', 'Ground', 'Processed', 'Other cuts', 'Tallow'];
var KENJI_OUT_REASONS = ['Sold in person', 'Sold on website', 'Sample / giveaway',
                         'Personal use', 'Damaged / spoiled', 'Correction'];
var KENJI_IN_REASONS  = ['New batch', 'Return', 'Correction'];

function kenjiSystem_(brief) {
  var lines = [
    'You are Kenji, the freezer hand for Peace Country Wagyu, a family Wagyu beef',
    'farm in Peace River, Alberta. Paul or Hannah is talking to you from a phone,',
    'often standing at an open freezer with cold hands. Answer the way a person',
    'would: short, plain, no lists unless they asked for several things. Two or',
    'three sentences at most. Say the numbers.',
    '',
    'You are given everything currently in the freezer and the whole catalogue.',
    'Every product carries its three prices ALREADY WORKED OUT: listLb is the',
    'wholesale price a pound, webLb the website price, mktLb the farmers',
    'market price, and listPack / webPack / mktPack the same three by the pack',
    'for anything sold by the pack. Read those numbers out as they stand.',
    'Never work a price out yourself and never round one — the markups and the',
    'rounding were done before you were handed the list, and a price you',
    'calculate will be wrong. If a product has no price on it, say so.',
    '',
    'When somebody asks what something costs, say which of the three you are',
    'quoting. If they have not said which, give all three rather than guess:',
    '"Ribeye is $63 a pound wholesale, $85 on the website, $75 at the market."',
    '',
    'Ground beef is the exception, and the only arithmetic you ever do. It is',
    'sold by the pound at a rate that depends on how many pounds are on the',
    'order, in groundBeef.bands — the same rate wholesale, website and market.',
    'It always goes on an order as groundBeef.orderAs packs. The band is',
    'decided by the whole order, not by the line.',
    '',
    'If they are asking you something, just answer it from what you were given.',
    'Never invent a number. If what you were given does not say, say so.',
    '',
    'boxes lists every box recipe: what it holds, and how many are made up and',
    'sitting in the freezer. The packs inside a made-up box are NOT in',
    'inTheFreezer any more — they were taken out when the box was built. So',
    'when somebody asks how many of a cut there are and means boxes too, add',
    'the loose packs to what the made-up boxes hold, and give them both halves:',
    '"Six loose, and four more inside boxes — ten altogether." When they just',
    'ask how many there are, answer with the loose packs, and mention the boxes',
    'only if there are some.',
    '',
    'If they are telling you the freezer changed — took some out, sold some, put',
    'a new batch in — do NOT treat that as done. Propose it, and it will be put',
    'in front of them to confirm. Pick the exact lot they must mean; if more than',
    'one lot could fit and it matters, ask which rather than guessing.',
    '',
    'If they want something NEW in the catalogue — a cut or a product that is',
    'not on the list at all — propose it the same way, as newProduct. Fill in',
    'whatever they told you and leave the rest out; it opens as a form they',
    'finish, so a half-heard price is no disaster. Do not propose a product',
    'whose name is already on the list.',
    '',
    'If an order is OPEN ON THE SCREEN it is in openOrder, with its lines',
    'numbered. They may tell you what one of them weighs — "the ribeye is a',
    'pound and a half", "that one\u2019s three quarters" — and you answer with',
    'weights: a list of {"line":n,"lb":n}, the line number from openOrder.',
    'Only lines you were actually told about. If there is no order on the',
    'screen, or you cannot tell which line they mean because two are the same',
    'cut, ask instead of guessing. A weight you invent becomes a price on',
    'somebody\u2019s invoice.',
    '',
    'If they are putting an ORDER together — somebody wants cuts set aside for',
    'a day — propose it as newOrder. An order is a promise, not a movement:',
    'nothing leaves the freezer until it is packed, so you may propose one for',
    'more than there is, and say so when you do.',
    'customer is the name they said; if it is close to one in customers, use',
    'the whole name from there. when is the date, as yyyy-mm-dd; today is in',
    'the snapshot, so "Friday" and "next Tuesday" are yours to work out.',
    'how is Pickup, Delivery or Shipping. channel is which price list: ' +
      CHANNELS.join(', ') + '.',
    'Each line is a sku from the catalogue and how many packs. Put weight on a',
    'line only if they gave you one.',
    '',
    'ASK rather than guess. If you do not have the customer, the date, or how',
    'many of something, say what you still need and propose nothing that turn —',
    'reply with the question and leave newOrder null. One question at a time,',
    'the way a person would. If which price list was meant is not clear and it',
    'is not obvious from who they are, ask that too rather than picking one.',
    'A half-right order with a real name on it is worse than another question.',
    '',
    'Anything else you are asked to change — a price, a name, a reorder point,',
    'anything on an existing product — you cannot do yet. Say so plainly and',
    'tell them to tap the product in the Inventory tab, where all of it can be',
    'edited. Do not pretend, and do not propose a change you were not given a',
    'shape for.',
    '',
    'Reply with JSON only, no other text, in this shape:',
    '{"reply": "what you would say out loud",',
    ' "change": null, or',
    ' {"type":"SALE|ADJUST|INTAKE|COUNT","sku":"...","packages":n,',
    '  "freezer":"...","batch":"...","reason":"..."},',
    ' "newProduct": null, or',
    ' {"product":"...","category":"' + KENJI_CATS.join('|') + '","content":"...",',
    '  "avgWeight":n,"price":n,"reorder":n},',
    ' "newOrder": null, or',
    ' {"customer":"...","when":"yyyy-mm-dd","how":"Pickup|Delivery|Shipping",',
    '  "channel":"' + CHANNELS.join('|') + '","notes":"...",',
    '  "lines":[{"sku":"...","packages":n,"weight":n,"note":"..."}]},',
    ' "weights": null, or [{"line":n,"lb":n}] }',
    '',
    'packages is always a positive number. Use SALE when it was sold, INTAKE for',
    'stock arriving, COUNT when they are telling you what is really on the shelf',
    '(then packages is the new total, not the difference), and ADJUST for the',
    'rest, where a negative movement needs reason from: ' + KENJI_OUT_REASONS.join(', ') + '.',
    'A positive one takes reason from: ' + KENJI_IN_REASONS.join(', ') + '.',
    'sku, freezer and batch must be ones you were actually given.',
    '',
    'Never mention packs that are missing a freezer, a grade or a weight. Nobody',
    'asked, and it is not what they are standing there to find out.'
  ];

  if (brief && brief.text) {
    lines = lines.concat([
      '',
      'Latest business brief from Kenji\'s hourly sweep, as of ' +
        (brief.asOfLocal || 'earlier today') + ':',
      brief.text,
      '',
      'That brief is how you answer anything about orders, drop-offs, who has',
      'paid and e-transfers — and say its time when you do, so they know how',
      'fresh it is: "As of ' + (brief.asOfLocal || 'the last sweep') + ', Melissa',
      'still owes $360." Say you do not know rather than guessing past it.',
      '',
      'Where the brief and the freezer list above disagree about how many packs',
      'there are, the freezer list wins. It is live; the brief is up to an hour',
      'old.',
      '',
      'The brief is for knowing, not for doing. You still only ever propose a',
      'change to inventory, and it is still put in front of them to confirm.'
    ]);
  }

  return lines.join('\n');
}

/* Whatever came back, is it a change we are willing to put in front of them? */
function kenjiCheckChange_(change, snap) {
  if (!change || typeof change !== 'object') return null;

  var type = str_(change.type).toUpperCase();
  if (['SALE', 'ADJUST', 'INTAKE', 'COUNT'].indexOf(type) === -1) return null;

  var sku = str_(change.sku).toUpperCase();
  var product = null;
  snap.products.forEach(function (p) { if (str_(p.sku).toUpperCase() === sku) product = p; });
  if (!product) return { refused: 'I could not work out which product you meant.' };

  var qty = num_(change.packages);
  if (type !== 'COUNT' && !(qty > 0)) return { refused: 'I did not catch how many.' };
  if (type === 'COUNT' && qty < 0) return { refused: 'I did not catch how many.' };

  var freezer = str_(change.freezer);
  if (freezer && !snap.freezers.some(function (f) { return f.id === freezer; })) {
    return { refused: 'There is no freezer called ' + freezer + '.' };
  }
  var batch = str_(change.batch);
  if (batch && !snap.batches.some(function (b) { return b.id === batch; })) {
    return { refused: 'There is no batch called ' + batch + '.' };
  }

  // The reason has to be one of ours, or the ledger stops being searchable.
  var list = (type === 'SALE') ? KENJI_OUT_REASONS
           : (type === 'INTAKE') ? KENJI_IN_REASONS
           : KENJI_OUT_REASONS.concat(KENJI_IN_REASONS);
  var reason = str_(change.reason);
  if (type === 'SALE' && !reason) reason = 'Sold in person';
  if (type === 'INTAKE' && !reason) reason = 'New batch';
  if (type === 'COUNT') reason = 'Freezer count';
  if (type !== 'COUNT' && list.indexOf(reason) === -1) {
    return { refused: 'I did not catch why — say sold, giveaway, personal use, spoiled or a correction.' };
  }

  // Which way it moves, so the phone and the ledger agree without guessing.
  var out = (type === 'SALE') ||
            (type === 'ADJUST' && KENJI_OUT_REASONS.indexOf(reason) !== -1);

  return {
    type: type, sku: product.sku, product: product.name, content: product.pack || '',
    packages: qty, freezer: freezer, batch: batch, reason: reason,
    direction: (type === 'COUNT') ? 'set' : (out ? 'out' : 'in')
  };
}

/* A new product is never written from here either. What comes back opens the
 * ordinary "New cut" form with the fields filled in, so every one of them is
 * read before anything is added — a price heard wrong on a windy day would
 * otherwise go on to price a box. */
function kenjiCheckProduct_(np, snap) {
  if (!np || typeof np !== 'object') return null;
  var name = str_(np.product).trim();
  if (!name) return null;

  var clash = null;
  snap.products.forEach(function (p) {
    if (str_(p.name).toLowerCase() === name.toLowerCase()) clash = p.name;
  });
  if (clash) return { refused: clash + ' is already on the list.' };

  var cat = str_(np.category);
  var okCat = '';
  KENJI_CATS.forEach(function (c) { if (c.toLowerCase() === cat.toLowerCase()) okCat = c; });

  var pick = function (v) { var n = num_(v); return n > 0 ? n : ''; };
  return {
    product: name,
    category: okCat,
    content: str_(np.content),
    avgWeight: pick(np.avgWeight),
    price: pick(np.price),
    reorder: pick(np.reorder)
  };
}

/**
 * Weights he was told out loud, checked against the order on the screen.
 *
 * A line number he has invented, or a weight that is not a number, is
 * dropped rather than applied: the phone is about to turn these into money.
 */
function kenjiCheckWeights_(list, open) {
  if (!list || !list.length || !open || !open.lines) return null;
  var out = [];
  list.forEach(function (w) {
    var n = Math.round(num_(w.line));
    var lb = num_(w.lb !== undefined ? w.lb : w.weight);
    if (!(n >= 1 && n <= open.lines.length)) return;
    if (!(lb > 0) || lb > 500) return;
    out.push({ line: n, lb: Math.round(lb * 100) / 100,
               product: str_((open.lines[n - 1] || {}).product) });
  });
  return out.length ? out : null;
}

/**
 * An order Kenji has put together, checked before it is put in front of
 * anybody.
 *
 * Nothing is written here. The order comes back priced, on the price list he
 * chose, and opens on the order screen with every line filled in — the same
 * screen Paul would have typed it on, so the last look before saving is at
 * the real thing and not at a summary of it.
 *
 * A line he could not match to the catalogue is dropped rather than guessed
 * at, and the order says so. An order with nothing left on it is refused:
 * better to be asked again than to hand over a blank.
 */
function kenjiCheckOrder_(o, snap, products, cfg) {
  if (!o || typeof o !== 'object') return null;

  var customer = str_(o.customer).trim();
  if (!customer) return { refused: 'I did not catch who the order is for.' };

  var when = str_(o.when || o.deliveryDate).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(when)) {
    return { refused: 'I did not catch what day ' + customer + ' wants it.' };
  }

  var how = str_(o.how || o.method);
  var methods = ['Pickup', 'Delivery', 'Shipping'];
  var method = 'Pickup';
  methods.forEach(function (m) { if (m.toLowerCase() === how.toLowerCase()) method = m; });

  var dropped = [];
  var lines = [];
  (o.lines || []).forEach(function (l) {
    var said = str_(l.product) || str_(l.sku);
    var sku = str_(l.sku).toUpperCase();
    var p = products[sku];
    // Named the way he said it, not as a SKU in capitals — this sentence is
    // read out to somebody standing at a freezer.
    if (!p) { dropped.push(said || 'something'); return; }
    var packs = num_(l.packages);
    if (!(packs > 0)) { dropped.push(p.product || said); return; }
    // Ground beef goes on as individual packs, whichever of them he named.
    if (isGroundBeef_(sku, cfg) && products['GROUND-BEEF-2-LB'] &&
        sku !== 'GROUND-BEEF-2-LB') {
      var was = num_(p.avgWeight) * packs;
      sku = 'GROUND-BEEF-2-LB';
      packs = Math.round(was / (num_(products[sku].avgWeight) || 2));
      if (!(packs > 0)) packs = 1;
      p = products[sku];
    }
    lines.push({ sku: sku, product: p.product, content: p.content,
                 packages: packs, weight: num_(l.weight) || 0,
                 promo: !!l.promo, note: str_(l.note) });
  });

  if (!lines.length) {
    return { refused: dropped.length
      ? 'I could not match ' + dropped.join(' or ') + ' to anything on the list.'
      : 'That order had nothing on it.' };
  }

  var money = priceOrderLines_(lines, o.channel, products, cfg);
  return {
    customer: customer,
    when: when,
    method: method,
    channel: money.channel,
    notes: str_(o.notes),
    lines: money.lines,
    total: money.total,
    groundBeefLb: money.groundBeefLb,
    groundBeefRate: money.groundBeefRate,
    dropped: dropped
  };
}

/**
 * The JSON object out of whatever came back.
 *
 * He is asked for the object alone, so the usual case is a clean object. This
 * is the net underneath: a fenced block anywhere in the answer, or the
 * outermost pair of braces, so an answer with a sentence in front of it still
 * gets read properly instead of being handed to the phone with JSON showing.
 *
 * The '{' + t try is left in deliberately. It costs nothing, and it is what
 * would catch an answer from one of the older models that still take a
 * prefill, if this ever has to talk to one again.
 */
function kenjiJson_(text) {
  var t = str_(text).trim();
  if (!t) return null;
  // Whole, then with a leading brace put back, then a fenced block, then the
  // outermost braces. Trying it whole first is the normal path now.
  var tries = [t, '{' + t];
  var fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) tries.push(fence[1]);
  var a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a !== -1 && b > a) tries.push(t.slice(a, b + 1));
  for (var i = 0; i < tries.length; i++) {
    try {
      var o = JSON.parse(tries[i]);
      if (o && typeof o === 'object' && !Array.isArray(o)) return o;
    } catch (errTry) {}
  }
  return null;
}

function askKenji_(req, who) {
  var said = str_(req.say);
  if (!said) return { ok: false, error: 'I did not catch that.' };

  var cfg = settings_();
  var key = str_(cfg[CLAUDE_KEY_SETTING]);
  if (!key) {
    return { ok: false, needsKey: true,
             error: 'Kenji needs an API key. Put it on the SETTINGS tab next to ' +
                    CLAUDE_KEY_SETTING + '.' };
  }
  var model = str_(cfg[CLAUDE_MODEL_SETTING]) || CLAUDE_MODEL_DEFAULT;

  var snap = kenjiSnapshot_();

  /* What is on the screen, when it is an order being written.
     Kenji is otherwise blind to the app: he knows the freezer and the
     catalogue, not what anybody is looking at. Telling him the open order —
     and only when there is one — is what lets "the ribeye is a pound and a
     half" land on the right line. It rides on the question rather than in
     the cached block, because it changes with every keystroke. */
  var open = req.openOrder;
  if (open && open.lines && open.lines.length) {
    snap = JSON.parse(JSON.stringify(snap));
    snap.openOrder = {
      customer: str_(open.customer),
      channel: orderChannel_(open.channel),
      lines: (open.lines || []).slice(0, 30).map(function (l, i) {
        return { line: i + 1, sku: str_(l.sku), product: str_(l.product),
                 packages: num_(l.packages), lb: num_(l.weight) || null };
      })
    };
  }

  var turns = [];
  (req.history || []).slice(-KENJI_MAX_TURNS).forEach(function (t) {
    var text = str_(t.text);
    if (!text) return;
    if (str_(t.role) === 'assistant') {
      // His own past turns go back in the shape he is told to answer in.
      // Handing them back as bare sentences taught him, a few questions in,
      // that bare sentences were acceptable — and the answers started
      // arriving with no reply field at all, which came out as "Done."
      turns.push({ role: 'assistant',
                   content: JSON.stringify({ reply: text, change: null }) });
    } else {
      turns.push({ role: 'user', content: text });
    }
  });
  turns.push({ role: 'user', content: said });

  /* His turn used to be started with "{" so he had nowhere to put a preamble.
     The current models refuse that outright — "This model does not support
     assistant message prefill. The conversation must end with a user
     message." — and the whole of Kenji stopped working the day the model was
     changed. The job the brace did is done by the last line of the question
     instead, and kenjiJson_ below is the net under both.

     The preamble it was guarding against is harmless now in any case: the
     phone only ever shows the reply field, never the raw answer, so a
     sentence in front of the JSON is read past rather than displayed. */
  turns[turns.length - 1] = {
    role: 'user',
    content: said + '\n\nAnswer with the JSON object only — start at { and ' +
             'end at }, with nothing before or after it.'
  };

  // The instructions, the brief and the freezer are the same from one
  // question to the next; only the sentence somebody just said is new. So
  // they all go in the system block with a cache marker on the end, and the
  // question itself is the only thing the model has to read afresh. A second
  // question within five minutes skips re-reading eight thousand tokens —
  // which is most of the pause before Kenji starts talking, and about a
  // twentieth of the cost.
  var body = {
    model: model,
    max_tokens: 600,                 // three sentences and a small JSON object
    system: [
      { type: 'text', text: kenjiSystem_(kenjiBrief_()) },
      { type: 'text',
        text: 'The freezer and the catalogue as they stand:\n' + JSON.stringify(snap),
        cache_control: { type: 'ephemeral' } }
    ],
    messages: turns
  };

  var waits = [0, 700, 1800];
  var code = 0, text = '';
  for (var i = 0; i < waits.length; i++) {
    if (waits[i]) Utilities.sleep(waits[i]);
    try {
      var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        payload: JSON.stringify(body),
        muteHttpExceptions: true
      });
      code = res.getResponseCode();
      text = res.getContentText();
    } catch (netErr) { code = 0; text = String(netErr); }
    if (code === 200) break;
    if (code === 400 || code === 401 || code === 403 || code === 404) {
      return { ok: false, error: photoApiError_(code, text, model) };
    }
  }
  if (code !== 200) {
    return { ok: false, error: 'Kenji could not be reached just now. Try again in a moment.' };
  }

  var said_back = '', ranOut = false;
  try {
    var parsed = JSON.parse(text);
    (parsed.content || []).forEach(function (c) { if (c.type === 'text') said_back += c.text; });
    // Cut off mid-sentence: the JSON will be broken and nothing below can
    // make sense of it, so say that rather than something that sounds fine.
    ranOut = str_(parsed.stop_reason) === 'max_tokens';
  } catch (e) {
    return { ok: false, error: 'Kenji answered in a way I could not read.' };
  }
  if (ranOut) {
    return { ok: true, change: null,
             reply: 'That answer ran long and got cut off. Ask me for a bit less at a time.' };
  }

  // Whatever shape it came back in.
  var payload = kenjiJson_(said_back);
  if (!payload) {
    // Not JSON at all. If it is plain prose there is still something worth
    // saying back; if it is broken JSON, showing him the debris is worse
    // than admitting it, so do not put quotes and field names on his screen.
    var loose = str_(said_back).trim();
    if (/"(reply|change|newProduct)"\s*:/.test(loose) || loose.charAt(0) === '"') {
      return { ok: true, change: null,
               reply: 'That answer came back garbled. Ask me again?' };
    }
    return { ok: true, reply: loose.slice(0, 600), change: null };
  }

  var checked = kenjiCheckChange_(payload.change, snap);
  if (checked && checked.refused) {
    return { ok: true, reply: str_(payload.reply) || checked.refused, change: null,
             couldNotDo: checked.refused };
  }

  var newProduct = kenjiCheckProduct_(payload.newProduct, snap);
  if (newProduct && newProduct.refused) {
    return { ok: true, reply: str_(payload.reply) || newProduct.refused, change: null,
             newProduct: null, couldNotDo: newProduct.refused };
  }

  var weights = kenjiCheckWeights_(payload.weights, snap.openOrder);
  var newOrder = kenjiCheckOrder_(payload.newOrder, snap, indexProducts_(), cfg);
  if (newOrder && newOrder.refused) {
    return { ok: true, reply: str_(payload.reply) || newOrder.refused, change: null,
             newOrder: null, couldNotDo: newOrder.refused };
  }

  // An empty reply used to come back as the word "Done." — which reads like
  // an answer and is not one. Say something true instead: describe the change
  // if there is one, and otherwise admit nothing came back.
  var reply = str_(payload.reply);
  if (!reply && checked) {
    reply = (checked.direction === 'set' ? 'Set ' + checked.product + ' to '
           : checked.direction === 'out' ? 'Take out ' : 'Add ') +
            checked.packages + (checked.direction === 'set' ? '' : ' × ' + checked.product) + '?';
  }
  if (!reply && newProduct) reply = 'Have a look at ' + newProduct.product + ' before I add it.';
  if (!reply && weights) {
    reply = weights.map(function (w) {
      return (w.product || 'line ' + w.line) + ' at ' + w.lb + ' lb';
    }).join(', ') + '.';
  }
  if (!reply && newOrder) {
    reply = newOrder.customer + ', ' + newOrder.when + ' — ' +
            newOrder.lines.length + (newOrder.lines.length === 1 ? ' line' : ' lines') +
            ', $' + newOrder.total + ' at ' + newOrder.channel + '. Have a look before you save it.';
  }
  if (!reply) {
    logSignInTrouble_('ask', 'Kenji answered with nothing to say', str_(who && who.email), req);
    reply = 'Nothing came back that time — ask me again?';
  }

  return { ok: true, reply: reply,
           change: checked || null, newProduct: newProduct || null,
           newOrder: newOrder || null, weights: weights || null };
}

/**
 * The number on a scale, read off a photograph of it.
 *
 * Standing at a scale with cold hands and a pack of meat in one of them, a
 * photograph is quicker than typing and far quicker than taking a glove off.
 * It reads one thing — the weight — and says plainly when it cannot, because
 * a wrong weight is a wrong price and a wrong price goes to a customer.
 */
function scaleRead_(req) {
  var b64 = str_(req.image);
  if (!b64) return { ok: false, error: 'No photo came through.' };
  var mime = str_(req.mime) || 'image/jpeg';

  var cfg = settings_();
  var key = str_(cfg[CLAUDE_KEY_SETTING]);
  if (!key) {
    return { ok: false, needsKey: true,
             error: 'Reading photos needs an API key. Put it on the SETTINGS tab ' +
                    'next to ' + CLAUDE_KEY_SETTING + '.' };
  }
  var model = str_(cfg[CLAUDE_MODEL_SETTING]) || CLAUDE_MODEL_DEFAULT;
  var want = str_(req.unit).toLowerCase() === 'kg' ? 'kg' : 'lb';

  var ask = [
    'This photograph is of one of two things, and you work out which:',
    '  a weighing scale with a pack of meat on it, or',
    '  the printed label on a pack of meat, which carries its weight.',
    'Read the weight off it and nothing else.',
    '',
    'A label may show the weight more than once — net weight, and a price',
    'worked out from it. Take the NET WEIGHT of the meat. Ignore the price,',
    'the date, the lot number and the barcode.',
    '',
    'Give the weight in ' + want + '. If what you see is in kilograms and ' + want +
      ' was asked for, convert it (1 kg = 2.20462 lb) and say so in unitSeen.',
    'If it is in ounces, convert (16 oz = 1 lb).',
    '',
    'Answer with JSON only, in this shape:',
    '{"weight": n, "unitSeen": "lb|kg|oz", "from": "scale|label",',
    ' "shown": "what it reads, verbatim", "sure": true|false,',
    ' "why": "only if sure is false"}',
    '',
    'sure is false if it is blurred, cut off, still settling, shows a zero,',
    'or you are looking at neither a scale nor a label. A guess at a weight',
    'becomes a price on somebody\u2019s invoice, so say you could not read it',
    'rather than giving a number you are not certain of.'
  ].join('\n');

  var body = {
    model: model,
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
        { type: 'text', text: ask }
      ]
    }],
    system: 'You read weights off scales and off printed meat labels. ' +
            'Answer with JSON only.'
  };

  var code = 0, text = '';
  var waits = [0, 600, 2000];
  for (var i = 0; i < waits.length; i++) {
    if (waits[i]) Utilities.sleep(waits[i]);
    try {
      var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        payload: JSON.stringify(body),
        muteHttpExceptions: true
      });
      code = res.getResponseCode();
      text = res.getContentText();
    } catch (netErr) { code = 0; text = String(netErr); }
    if (code === 200) break;
    if (code === 400 || code === 401 || code === 403 || code === 404) {
      return { ok: false, error: photoApiError_(code, text, model) };
    }
  }
  if (code !== 200) {
    return { ok: false, error: 'Could not reach the photo reader just now. Try again.' };
  }

  var said = '';
  try {
    var parsed = JSON.parse(text);
    (parsed.content || []).forEach(function (part) {
      if (part && part.type === 'text') said += part.text;
    });
  } catch (err) {
    return { ok: false, error: 'The photo reader sent back something unreadable.' };
  }

  var out = kenjiJson_(said);
  if (!out) return { ok: false, error: 'Could not make out a weight on that photo.' };

  var w = num_(out.weight);
  if (!(w > 0) || out.sure === false) {
    return { ok: false,
             error: str_(out.why) || 'Could not read the display clearly. Try again, or type it.' };
  }
  return { ok: true, weight: Math.round(w * 100) / 100,
           shown: str_(out.shown), unitSeen: str_(out.unitSeen),
           from: str_(out.from) === 'label' ? 'label' : 'scale' };
}

function photoCount_(req) {
  var b64 = str_(req.image);
  if (!b64) return { ok: false, error: 'No photo came through.' };
  var mime = str_(req.mime) || 'image/jpeg';

  var cfg = settings_();
  var key = str_(cfg[CLAUDE_KEY_SETTING]);
  if (!key) {
    return { ok: false, needsKey: true,
             error: 'Reading photos needs an API key. Put it on the SETTINGS tab ' +
                    'next to ' + CLAUDE_KEY_SETTING + '.' };
  }
  var model = str_(cfg[CLAUDE_MODEL_SETTING]) || CLAUDE_MODEL_DEFAULT;

  var products = indexProducts_();
  var names = Object.keys(products)
    .filter(function (k) { return products[k].active !== false; })
    .map(function (k) {
      return products[k].product + (products[k].content ? ' (' + products[k].content + ')' : '');
    });

  var body = {
    model: model,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
        { type: 'text', text: photoPrompt_(names) }
      ]
    }]
  };

  var res = null, code = 0, text = '';
  var waits = [600, 2000];
  for (var i = 0; ; i++) {
    try {
      res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        payload: JSON.stringify(body),
        muteHttpExceptions: true
      });
      code = res.getResponseCode();
      text = res.getContentText();
    } catch (netErr) { code = 0; text = String(netErr); }
    if (code === 200) break;
    // 400/401/403/404 are answers, not blips: a bad key or a wrong model name.
    if (code === 400 || code === 401 || code === 403 || code === 404) {
      return { ok: false, error: photoApiError_(code, text, model) };
    }
    if (i >= waits.length) {
      return { ok: false, error: 'Could not reach the photo reader just now (' + code + '). Try again.' };
    }
    Utilities.sleep(waits[i]);
  }

  var said = '';
  try {
    var parsed = JSON.parse(text);
    (parsed.content || []).forEach(function (part) {
      if (part && part.type === 'text') said += part.text;
    });
  } catch (err) {
    return { ok: false, error: 'The photo reader sent back something unreadable.' };
  }

  var out = null;
  try {
    var first = said.indexOf('{');
    var last = said.lastIndexOf('}');
    out = JSON.parse(said.slice(first, last + 1));
  } catch (err2) {
    return { ok: false, error: 'Could not make sense of what the photo reader said.' };
  }

  // Turn the names it used into real SKUs, with the same resolver the price
  // lookup uses — so "ExL Denver" and "flat iron" land correctly here too.
  var lines = (out.lines || []).map(function (l) {
    var guess = resolveProduct_(str_(l.product), {});
    return {
      asRead: str_(l.product),
      sku: guess && guess.ok ? guess.sku : '',
      product: guess && guess.ok ? guess.product : str_(l.product),
      matched: !!(guess && guess.ok),
      sure: !!(guess && guess.confident),
      count: Math.max(0, Math.round(num_(l.count) || 0)),
      weightLb: num_(l.weightLb) || 0,
      confidence: str_(l.confidence) || 'low',
      note: str_(l.note),
      alternatives: (guess && guess.alternatives) || []
    };
  }).filter(function (l) { return l.count > 0 || l.matched; });

  return {
    ok: true,
    from: str_(out.from) || 'meat',
    note: str_(out.note),
    lines: lines,
    // Said plainly so the app can say it plainly too.
    mustConfirm: true
  };
}

function photoApiError_(code, text, model) {
  var detail = '';
  try {
    var j = JSON.parse(text);
    detail = str_(j.error && j.error.message);
  } catch (err) {}
  if (code === 401 || code === 403) {
    return 'The API key on the SETTINGS tab was refused. Check ' + CLAUDE_KEY_SETTING + '.';
  }
  if (/model/i.test(detail)) {
    /* Not every 400 about a model is a bad name. The one that cost a day was
       "this model does not support assistant message prefill", which is about
       how we asked rather than which model we asked — and telling Paul to
       change the model name sent him looking in the wrong place. */
    if (/prefill|must end with a user message/i.test(detail)) {
      return 'Kenji asked in a way this model will not take. Nothing to change ' +
             'on the SETTINGS tab — the app needs updating. (' + detail + ')';
    }
    return 'The model name "' + model + '" was refused. Change ' +
           CLAUDE_MODEL_SETTING + ' on the SETTINGS tab. (' + detail + ')';
  }
  return 'The photo reader refused the request' + (detail ? ': ' + detail : ' (' + code + ').');
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
  CURRENT_SESSION_EXP = 0;
  CURRENT_SESSION_TOKEN = '';
  try {
    var params = (e && e.parameter) || {};
    var req = body || params;
    var action = str_(req.action) || 'bootstrap';

    // Three things happen before we know who is asking: a connectivity check,
    // and the two ends of signing in.
    // ping carries the build so the app can show which backend it is talking
    // to. It is the only way to tell from outside whether a paste and
    // redeploy actually took.
    // ping also says whether this deployment can read Kenji's hourly brief,
    // so "is it wired up?" is answered by asking the thing rather than by
    // reading settings over somebody's shoulder. Just ok or unreadable — no
    // account name, because ping takes no sign-in.
    if (action === 'ping')   return json_({ ok: true, build: BACKEND_BUILD,
                                            brief: kenjiBrief_() ? 'ok' : 'unreadable',
                                            serverTime: new Date().toISOString() });
    if (action === 'login')  return json_(login_(req.idToken, req.joinWord));
    if (action === 'logout') return json_(logout_(req.sessionToken));

    // People sign in with Google and carry a session. Kenji's bridge is a
    // server talking to a server — it cannot sit through a Google sign-in, so
    // it still uses the shared API token.
    var me = null;
    if (str_(req.sessionToken)) {
      me = readSession_(req.sessionToken);
      if (!me) {
        logSignInTrouble_(action, LAST_REJECT, LAST_REJECT_EMAIL, req);
        // sessionDead tells the phone this is really over, as opposed to any
        // other failure. Without it the app was matching on words in the
        // message, which swept up errors that had nothing to do with signing
        // in and threw people out for them.
        return json_({ ok: false, sessionDead: true, reason: LAST_REJECT,
                       error: 'Signed out — ' + LAST_REJECT + '.' });
      }
    } else if (str_(req.token || params.token)) {
      var expected = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
      if (!expected) return json_({ ok: false, error: 'Backend not set up — run setup().' });
      if (str_(req.token || params.token) !== expected) {
        return json_({ ok: false, error: 'That API token is not right.' });
      }
      me = { email: 'kenji@' + HOME_DOMAIN, name: 'Kenji', role: 'Robot', robot: true };
    } else {
      // Neither a session nor an API token. This used to answer "Please sign
      // in.", which the app read as a dead session and acted on by throwing
      // the session away — so one request that lost its token on the way out
      // cost a full sign-in. It is explicitly NOT a dead session now.
      logSignInTrouble_(action, 'the request arrived with no sign-in on it', '', req);
      return json_({ ok: false, noCredentials: true,
                     error: 'That request arrived without a sign-in. Try again.' });
    }

    // A signed-in person owns what they write: the phone does not get to put
    // somebody else's name on it. Kenji is different — the bridge acts on
    // whoever asked it, so a name it passes through is kept, and only an
    // unnamed call is recorded as Kenji's own doing.
    req.user = me.robot ? (str_(req.user) || me.name) : (me.name || me.email);
    req.userEmail = me.email;

    // Every reply carries the session's current expiry so the phone can keep
    // its own copy in step with the server's, instead of counting down to a
    // date the server has already moved.
    CURRENT_SESSION_EXP = me.renewedExp || 0;
    CURRENT_SESSION_TOKEN = me.renewedToken || '';

    // Anything that is not on this list may write, so the data version is
    // bumped after it. Unknown and future actions fall on the writing side on
    // purpose: an unnecessary bump costs one extra refresh, while a missed one
    // would leave a phone showing stale stock, which is far worse.
    var READ_ONLY = ['bootstrap','me','history','scans','price','priceByName','findProduct',
                     'customer','schedule','lists','boxes','ageing','followups','stock',
                     'photoCount','scaleRead',
                     'ask'];          // both propose only; nothing is written
    if (READ_ONLY.indexOf(action) === -1) {
      try { bumpDataVersion_(); } catch (errBump) {}
    }

    switch (action) {
      case 'bootstrap':   return json_(bootstrap_(req.since));
      case 'me':          return json_({ ok: true, me: me });
      case 'submit':      return json_(submit_(req));
      case 'addProduct':  return json_(addProduct_(req.product || {}));
      case 'updateProduct': return json_(updateProduct_(req.product || {}));
      case 'addBox':      return json_(addBox_(req.box || {}));
      case 'photoCount':  return json_(photoCount_(req));
      case 'scaleRead':   return json_(scaleRead_(req));
      case 'setBoxParts': return json_(setBoxParts_(req));
      case 'addBatch':    return json_(addBatch_(req.batch || {}));
      case 'ask':         return json_(askKenji_(req, me));
      case 'freezerReport': return json_(freezerReport(req.from, req.to));
      case 'updateBatch': return json_(updateBatch_(req.batch || {}));
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
      case 'priceByName': return json_(priceByName_(req));
      case 'findProduct': return json_({ ok: true, match: resolveProduct_(req.name || req.text) });
      case 'customer':    return json_(customerFile_(req.customer || req.name));
      case 'schedule':    return json_(schedule_(req));
      case 'calendarAdd': return json_(calendarAdd_(req));
      case 'calendarSync':return json_({ ok: true, touched: syncCalendar_() });
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

/* Set for the length of one request, so every reply can tell the phone the
 * session's current expiry without threading it through fifty handlers. */
var CURRENT_SESSION_EXP = 0;
var CURRENT_SESSION_TOKEN = '';

function json_(obj) {
  if (CURRENT_SESSION_EXP && obj && typeof obj === 'object' && !obj.sessionExp) {
    obj.sessionExp = CURRENT_SESSION_EXP;
  }
  // A renewed note is a new note, so the phone has to be given it.
  if (CURRENT_SESSION_TOKEN && obj && typeof obj === 'object' && !obj.sessionToken) {
    obj.sessionToken = CURRENT_SESSION_TOKEN;
  }
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function bootstrap_(since) {
  // The phone tells us the stamp it already has. If nothing has changed we can
  // say so in three quick calls instead of reading a dozen tabs and opening
  // the sales sheet. This is the difference between a sync that feels instant
  // and one that makes you wait on a weak signal.
  if (str_(since)) {
    var nowStamp = null;
    try { nowStamp = dataStamp_(); } catch (errStamp) { nowStamp = null; }
    if (nowStamp && nowStamp === str_(since)) {
      return { ok: true, unchanged: true, stamp: nowStamp,
               serverTime: new Date().toISOString() };
    }
  }

  rebuildInventory();
  /* A price typed straight into the PRODUCTS tab changes what everybody is
     charged, so it goes on the record the same as one changed in the app.
     Nothing here is slow: it is one read of a tab already in memory, and it
     only runs when something in the sheet has actually moved. */
  try { sweepPriceEdits_(); } catch (errPrice) {}
  // Cheap — one heading row each — and it is what stops a column added in
  // the code from being invisible in the sheet.
  try { ensureOrderHeaders_(); } catch (errHead) {}
  var products = indexProducts_();
  return {
    ok: true,
    stamp: dataStamp_(),
    serverTime: new Date().toISOString(),
    settings: publicSettings_(),
    products: Object.keys(products).map(function (k) { return products[k]; }),
    batches: indexBatches_(),
    freezers: indexFreezers_(),
    stock: currentStock_(),
    orders: readOrders_(),
    committed: committedBySku_(),
    scansPending: listScans_('Pending').scans.length,
    ageing: ageing_(),
    boxes: buildable_(),
    boxList: boxesForApp_(),
    boxedBySku: boxedBySku_(),
    lists: lists_(),
    followups: followups_(),
    sendAs: sendAs_(),
    priceChanges: recentPriceChanges_(60),
    // The company's own sales book, so the Sales screen shows the year as it
    // really was rather than only what went through this app.
    salesBook: salesBookRows_(400),
    // Anything the app should put a banner up about, and what each freezer
    // was reading when it was last looked at.
    alerts: openAlerts_(),
    freezers_seen: freezerLatest_(),
    freezers_history: freezerHistory_(14),
    freezer_record: freezerRecordState_(),
    // So the app can draw the lines in the same place this put them.
    freezer_limits: freezerLimits_(),
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

  // Whoever is signed in owns every line they send. The phone no longer gets
  // to say who it is, so the ledger cannot be signed with someone else's name.
  if (str_(req.user)) {
    ops.forEach(function (op) { op.user = req.user; });
  }

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
    // Refusals, each tied to the operation that caused it.
    var refusedOps = [];
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
        result = orderStatus_(op, products, stock, allowNegative, warnings);
        if (!result.error && !result.rows) result.rows = [];
      } else if (type === 'ORDER_EDIT') {
        // Editing an assembled order moves stock, so whatever rows it hands
        // back go into the ledger like any other movement.
        result = orderEdit_(op, products, stock, allowNegative, warnings);
        if (!result.error && !result.rows) result.rows = [];
      } else if (type === 'BUILD_BOX' || type === 'BREAK_BOX') {
        var built = buildBoxOps_(op, stock);
        if (built.error) { result = { error: built.error }; }
        else {
          result = { rows: [] };
          built.ops.forEach(function (sub) {
            var r = expandOp_(sub, products, stock, allowNegative, warnings);
            if (r.error) warnings.push(r.error);
            else r.rows.forEach(function (x) { result.rows.push(x); });
          });
        }
      } else if (type === 'ALERT_DISMISS') {
        result = alertDismiss_(op);
        if (!result.error) result.rows = [];
      } else if (type === 'ORDER_PACK') {
        result = orderPackRows_(op, products, stock, allowNegative, warnings);
      } else {
        result = expandOp_(op, products, stock, allowNegative, warnings);
      }
      /* A refusal is attached to the operation that caused it. Without the
         client key the phone cannot tell WHICH of the things it sent was
         turned away, so it keeps every one of them and sends the lot again
         on the next sync — the same red banner, for ever, and a queue that
         never empties. With the key it can set that one aside and get on. */
      if (result.error) {
        warnings.push(result.error);
        refusedOps.push({ clientKey: clientKey, why: String(result.error),
                          type: type, sku: str_(op.sku) });
        return;
      }

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
  // Two different things, split apart. "refused" is an operation that did not
  // happen and the person needs to know now. "stockNotes" is the freezer
  // running low or going negative — true, worth seeing, but not worth
  // interrupting a count for. The app shows the first and files the second.
  var refused = [], stockNotes = [];
  warnings.forEach(function (w) {
    if (String(w).indexOf('STOCK: ') === 0) stockNotes.push(String(w).slice(7));
    else refused.push(String(w));
  });

  return { ok: true, accepted: accepted, warnings: warnings,
           refused: refused, refusedOps: refusedOps, stockNotes: stockNotes,
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
    /* The grade the APP sent, and nothing else.
       This used to fall back to the product's default grade, which quietly
       wrote a movement against a lot that does not exist. Breakfast Sausage
       sits in a lot with no grade and has "Gold" as its default, so moving it
       to Freezer 3 wrote the out-leg against a phantom "Gold" lot: the four
       packs never left Unassigned, a minus-four appeared beside them, and the
       screen showed three lines where there should be one. It also meant
       Charles's three Best of Both Worlds sold at the door came off a lot
       that was not there, and the real count never moved.
       Grading new stock is the app's job and it already does it; a movement
       against stock already on the shelf must carry that stock's own grade or
       it is about a different lot. */
    grade: str_(op.grade),
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
      // New stock, and the only case where the product's default grade is
      // the right answer when none was given: there is no existing lot for
      // it to disagree with.
      if (!qty) return { error: 'Intake of ' + base.product + ' had no package count.' };
      return { rows: [merge_(base, { type: 'INTAKE', packages: qty, weight: round2_(weight),
                                     grade: base.grade || str_(p.grade) })] };

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

    /* A lot was recorded under the wrong freezer, grade, size or batch. The
     * ledger is append-only, so nothing is edited: the packs are moved out of
     * the lot they were wrongly in and into the right one, carrying their
     * weight with them. The history still shows what was first written and
     * what it was corrected to, which is the point of a ledger. */
    case 'RELABEL': {
      var want = {
        size: op.toSize === undefined ? pickedSize : str_(op.toSize),
        grade: op.toGrade === undefined ? pickedGrade : str_(op.toGrade),
        batch: op.toBatch === undefined ? base.batch : str_(op.toBatch),
        freezer: op.toFreezer === undefined ? base.freezer : str_(op.toFreezer)
      };
      var same = want.size === pickedSize && want.grade === pickedGrade &&
                 want.batch === base.batch && want.freezer === base.freezer;
      if (same) return { error: 'Nothing was changed on that lot.' };

      var from = findLine_(stock, sku, pickedSize, pickedGrade, base.batch, base.freezer);
      if (!from) {
        // The lot is not where the phone thought it was. Almost always this
        // is the same correction arriving twice — the phone redraws from the
        // data it has while the first one is still on its way, so a second
        // tap looks for a lot that has already moved. If the stock is already
        // sitting where this was meant to put it, the job is done: say so
        // quietly rather than refusing something that has in fact happened.
        var already = findLine_(stock, sku, want.size, want.grade, want.batch, want.freezer);
        if (already) return { rows: [] };

        return { error: 'Could not find ' + base.product + ' in ' +
                 (base.freezer || 'no freezer') + ' / ' + (base.batch || 'no batch') +
                 (pickedGrade ? ' / ' + pickedGrade : '') +
                 '. It may already have been moved — open the product again to see where it is.' };
      }
      var moving = qty || from.packages;
      // Deliberately ignores ALLOW_NEGATIVE. Overselling into the negative is
      // a real thing that happens at a market; relabelling packs that do not
      // exist is never anything but a mistake, and allowing it would split one
      // lot into a negative and a positive that look like stock.
      if (moving > from.packages) {
        return { error: 'Only ' + from.packages + ' of ' + base.product +
                        ' under those details — cannot correct ' + moving + '.' };
      }
      var perPack = from.packages ? from.weight / from.packages : num_(p.avgWeight);
      var relWeight = round2_(moving * perPack);
      var how = 'corrected to ' +
        [want.freezer, want.grade, want.size, want.batch].filter(function (x) { return x; }).join(' · ');

      return { rows: [
        // Exactly the lot that was found, not whatever base happens to hold —
        // the out-leg has to cancel real packs, and a single wrong field on
        // it invents a second lot instead of emptying the first.
        merge_(base, { type: 'TRANSFER_OUT', packages: -moving, weight: -relWeight,
                       size: pickedSize, grade: pickedGrade,
                       batch: base.batch, freezer: base.freezer,
                       party: base.party || how }),
        merge_(base, { type: 'TRANSFER_IN', packages: moving, weight: relWeight,
                       size: want.size, grade: want.grade, batch: want.batch,
                       freezer: want.freezer,
                       party: base.party || ('was ' + [base.freezer, pickedGrade, pickedSize, base.batch]
                         .filter(function (x) { return x; }).join(' · ')) })
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
          warnings.push('STOCK: Sold ' + qty + ' of ' + base.product + ' but only ' + l.packages + ' were on hand — stock now shows negative.');
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
    warnings.push('STOCK: Sold ' + remaining + ' more ' + base.product + ' than the sheet shows on hand.');
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

/* ========================= THE PRICE LIST ITSELF =========================
 *
 * Paul's rule, in his words: a price change counts when it is made on the
 * Price tab or typed into the sheet. A price agreed on one order is an
 * arrangement with that customer, not a new rule, and never comes near this.
 *
 * So every change to a price ON THE CATALOGUE is written down — what it was,
 * what it is now, who did it and which way they did it. Prices typed straight
 * into the PRODUCTS tab are caught by comparing against the last picture this
 * script took of them, so a change made in the Sheet with nobody's phone
 * involved still ends up on the record.
 */

var PRICE_COLS = ['Price / pack', 'Price / lb', 'Price / kg',
                  'Market / pack', 'Market / lb',
                  'Website / pack', 'Website / lb'];
var PRICE_SNAP_KEY = 'PRICE_LIST_SNAPSHOT';

/** The PRICE CHANGES tab, made on the spot if the sheet predates it. */
function priceLogSheet_() {
  var ss = ss_();
  var sh = null;
  try { sh = ss.getSheetByName(TABS.PRICELOG); } catch (err) { sh = null; }
  if (!sh) {
    sh = ss.insertSheet(TABS.PRICELOG);
    sh.getRange(1, 1, 1, HEADERS.PRICELOG.length).setValues([HEADERS.PRICELOG])
      .setFontWeight('bold').setBackground('#3c2415').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Every price on the catalogue right now, as { SKU: { column: number } }. */
function priceSnapshot_() {
  var out = {};
  readTable_(TABS.PRODUCTS).forEach(function (r) {
    var sku = str_(r['SKU']).toUpperCase();
    if (!sku) return;
    var one = { product: str_(r['Product']) };
    PRICE_COLS.forEach(function (c) {
      one[c] = str_(r[c]) === '' ? '' : Math.round(num_(r[c]) * 100) / 100;
    });
    out[sku] = one;
  });
  return out;
}

/* Kept as one short line per product rather than JSON — script properties
   are capped at a few kilobytes and the catalogue is sixty products wide. */
function snapToString_(snap) {
  return Object.keys(snap).sort().map(function (sku) {
    return sku + '=' + PRICE_COLS.map(function (c) { return snap[sku][c]; }).join('/');
  }).join('\n');
}

function snapFromString_(s) {
  var out = {};
  String(s || '').split('\n').forEach(function (line) {
    var at = line.indexOf('=');
    if (at < 1) return;
    var sku = line.slice(0, at);
    var parts = line.slice(at + 1).split('/');
    var one = { product: '' };
    PRICE_COLS.forEach(function (c, i) {
      one[c] = parts[i] === undefined || parts[i] === '' ? '' : Number(parts[i]);
    });
    out[sku] = one;
  });
  return out;
}

function readPriceSnap_() {
  try {
    return snapFromString_(PropertiesService.getScriptProperties().getProperty(PRICE_SNAP_KEY));
  } catch (err) { return {}; }
}

function savePriceSnap_(snap) {
  try {
    PropertiesService.getScriptProperties()
      .setProperty(PRICE_SNAP_KEY, snapToString_(snap));
  } catch (err) {}
}

/**
 * Write down what moved between two pictures of the price list.
 *
 * A product that has only just been added is not a price change — there was
 * no old price to change — so it is recorded in the snapshot and passed over.
 */
function logPriceChanges_(before, after, who, where, note) {
  var rows = [];
  var now = new Date();
  Object.keys(after).forEach(function (sku) {
    var was = before[sku];
    if (!was) return;                              // new to the catalogue
    PRICE_COLS.forEach(function (c) {
      var a = was[c] === '' || was[c] === undefined ? '' : Math.round(Number(was[c]) * 100) / 100;
      var b = after[sku][c] === '' ? '' : Math.round(Number(after[sku][c]) * 100) / 100;
      if (a === b) return;
      if (a === '' && b === '') return;
      rows.push(['', now, sku, after[sku].product, c,
                 a === '' ? '' : a, b === '' ? '' : b,
                 str_(who) || 'Unknown', str_(where), str_(note)]);
    });
  });
  if (!rows.length) return 0;
  var stamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMddHHmmss');
  rows.forEach(function (r, i) { r[0] = 'PR' + stamp + '-' + (i + 1); });
  var sh = priceLogSheet_();
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.PRICELOG.length).setValues(rows);
  return rows.length;
}

/**
 * Anything typed straight into the PRODUCTS tab since the last look.
 *
 * Runs on an ordinary sync, so a price changed in the Sheet on a Tuesday is
 * on the record by the time anybody's phone next talks to it. Changes made
 * through the app have already been written down and their snapshot saved,
 * so they are not counted twice.
 */
/** The most recent price changes, newest first, for the app to show. */
function recentPriceChanges_(limit) {
  var rows;
  try { rows = readTable_(TABS.PRICELOG); } catch (err) { return []; }
  return rows.map(function (r, i) {
    return {
      // Where it sits on the tab, which settles the order of two changes
      // written in the same second. The clock alone cannot.
      at: i,
      id: str_(r['Change ID']),
      when: r['When'] instanceof Date ? r['When'].toISOString() : str_(r['When']),
      sku: str_(r['SKU']),
      product: str_(r['Product']),
      which: str_(r['Which price']),
      was: str_(r['Was']) === '' ? '' : num_(r['Was']),
      now: str_(r['Now']) === '' ? '' : num_(r['Now']),
      by: str_(r['Changed by']),
      where: str_(r['Where']),
      why: str_(r['Note'])
    };
  }).sort(function (a, b) {
    var byWhen = String(b.when).localeCompare(String(a.when));
    return byWhen || (b.at - a.at);
  }).slice(0, num_(limit) || 60);
}

function sweepPriceEdits_() {
  var before = readPriceSnap_();
  var after = priceSnapshot_();
  // Nothing on file yet: this is the first look, so take the picture and
  // claim nothing. Otherwise the whole catalogue would read as changed.
  if (!Object.keys(before).length) { savePriceSnap_(after); return 0; }
  var n = logPriceChanges_(before, after, 'Sheet', 'Typed into the sheet', '');
  if (n) savePriceSnap_(after);
  return n;
}

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
  // A product that has just been invented has not had its price changed, but
  // it belongs in the picture so the next change to it is seen as a change.
  savePriceSnap_(priceSnapshot_());
  var all = indexProducts_();
  return { ok: true, sku: sku, products: Object.keys(all).map(function (k) { return all[k]; }) };
}

/* Change a product that already exists. Only the fields actually sent are
 * touched, so a phone editing the price cannot blank the notes it never
 * showed. The SKU never changes — it is what the ledger is keyed on. */
function updateProduct_(p) {
  var sku = str_(p.sku).toUpperCase();
  if (!sku) return { ok: false, error: 'Which product?' };

  var sh = sheet_(TABS.PRODUCTS);
  var rows = readTable_(TABS.PRODUCTS);
  var at = -1;
  for (var i = 0; i < rows.length; i++) {
    if (str_(rows[i]['SKU']).toUpperCase() === sku) { at = i; break; }
  }
  if (at === -1) return { ok: false, error: sku + ' is not in the catalogue.' };

  // Renaming must not collide with another product.
  if (p.product !== undefined && str_(p.product)) {
    var wanted = str_(p.product).toLowerCase();
    for (var j = 0; j < rows.length; j++) {
      if (j === at) continue;
      if (str_(rows[j]['Product']).toLowerCase() === wanted &&
          str_(rows[j]['Content']).toLowerCase() ===
            str_(p.content === undefined ? rows[at]['Content'] : p.content).toLowerCase()) {
        return { ok: false, error: 'Another product is already called "' + str_(p.product) +
                 '" with the same pack contents.' };
      }
    }
  }

  // Build the row against the header row the sheet actually has, not the one
  // this file expects. They differ whenever a column has been added since the
  // sheet was set up, and writing by our own order would then put prices in
  // the wrong cells — silently, which is the worst way for it to go wrong.
  var head = ensureProductColumns_();
  var col = {};
  head.forEach(function (h, k) { if (h) col[h] = k; });
  var row = head.map(function (h) {
    return (h && rows[at][h] !== undefined) ? rows[at][h] : '';
  });

  var put = function (field, header, numeric) {
    if (p[field] === undefined) return;
    if (col[header] === undefined) return;      // a column this sheet does not have
    var v = p[field];
    if (numeric) row[col[header]] = (v === '' || v === null) ? '' : num_(v);
    else row[col[header]] = str_(v);
  };
  var clear = function (header) { if (col[header] !== undefined) row[col[header]] = ''; };
  put('product', 'Product');
  put('category', 'Category');
  put('content', 'Content');
  put('sizes', 'Sizes');
  put('avgWeight', 'Avg weight (lb)', true);
  put('grade', 'Default grade');
  put('price', 'Price / pack', true);
  put('pricePerLb', 'Price / lb', true);
  put('pricePerKg', 'Price / kg', true);
  put('marketPrice', 'Market / pack', true);
  put('marketPerLb', 'Market / lb', true);
  put('webSet', 'Website / pack', true);
  put('webSetPerLb', 'Website / lb', true);
  put('piecesPerPack', 'Pieces / pack', true);
  put('reorder', 'Reorder point', true);
  put('notes', 'Notes');
  if (p.active !== undefined) row[col['Active']] = yes_(p.active) ? 'Yes' : 'No';

  // Retyping one price should let the others follow it, as on a new product.
  // normalizePrices_ only fills blanks, so the ones that should be recomputed
  // have to be cleared first — otherwise a new pack price leaves a stale $/lb
  // sitting beside it, which is exactly the kind of quiet wrong number that
  // ends up on a price list.
  if (p.pricePerLb !== undefined) {
    clear('Price / kg');
    if (p.price === undefined) clear('Price / pack');
  } else if (p.pricePerKg !== undefined) {
    clear('Price / lb');
    if (p.price === undefined) clear('Price / pack');
  } else if (p.price !== undefined) {
    clear('Price / lb');
    clear('Price / kg');
  }
  // Same for the market columns.
  if (p.marketPrice !== undefined && p.marketPerLb === undefined) {
    clear('Market / lb');
  } else if (p.marketPerLb !== undefined && p.marketPrice === undefined) {
    clear('Market / pack');
  }
  // And for a website price set by hand.
  if (p.webSet !== undefined && p.webSetPerLb === undefined) {
    clear('Website / lb');
  } else if (p.webSetPerLb !== undefined && p.webSet === undefined) {
    clear('Website / pack');
  }
  // A changed pack weight makes every derived price wrong until it is redone.
  if (p.avgWeight !== undefined && p.pricePerLb === undefined && p.pricePerKg === undefined) {
    clear('Price / lb');
    clear('Price / kg');
    clear('Market / lb');
    clear('Website / lb');
  }

  /* Anything typed into the sheet since the last look is on the record
     before this change is made, so the two cannot be confused with each
     other. Then the change itself is written down. */
  sweepPriceEdits_();
  var pricesBefore = priceSnapshot_();

  sh.getRange(at + 2, 1, 1, row.length).setValues([row]);
  normalizePrices_();

  var pricesAfter = priceSnapshot_();
  logPriceChanges_(pricesBefore, pricesAfter, str_(p.user) || 'App',
                   str_(p.where) || 'Price tab', str_(p.why));
  savePriceSnap_(pricesAfter);

  var all = indexProducts_();
  return { ok: true, sku: sku,
           products: Object.keys(all).map(function (k) { return all[k]; }),
           boxes: boxesForApp_() };
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

/**
 * Change an existing batch — in practice, the date the meat went in, which
 * the app hangs off the batch rather than off each product. Only the fields
 * that were sent are touched, so sending a date does not wipe the notes.
 */
function updateBatch_(b) {
  var id = str_(b.id) || str_(b.batch);
  if (!id) return { ok: false, error: 'Which batch?' };

  var sh = sheet_(TABS.BATCHES);
  var rows = readTable_(TABS.BATCHES);
  var at = -1;
  for (var i = 0; i < rows.length; i++) {
    if (str_(rows[i]['Batch ID']).toUpperCase() === id.toUpperCase()) { at = i; break; }
  }
  if (at === -1) return { ok: false, error: 'There is no batch called ' + id + '.' };

  var width = Math.max(sh.getLastColumn(), HEADERS.BATCHES.length);
  var head = sh.getRange(1, 1, 1, width).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var col = {};
  head.forEach(function (h, k) { if (h) col[h] = k; });
  var row = head.map(function (h) {
    return (h && rows[at][h] !== undefined) ? rows[at][h] : '';
  });

  var put = function (field, header) {
    if (b[field] === undefined || col[header] === undefined) return;
    row[col[header]] = str_(b[field]);
  };
  put('animal', 'Animal / tag');
  put('outfit', 'Outfit');
  put('butcher', 'Butcher');
  put('killDate', 'Kill date');
  put('packDate', 'Pack date');
  put('grade', 'Grade (BMS)');
  put('notes', 'Notes');
  if (b.active !== undefined && col['Active'] !== undefined) {
    row[col['Active']] = yes_(b.active) ? 'Yes' : 'No';
  }

  sh.getRange(at + 2, 1, 1, row.length).setValues([row]);
  return { ok: true, id: id, batches: indexBatches_() };
}

function addFreezer_(f) {
  var name = str_(f.name);
  var id = str_(f.id).toUpperCase();
  // Nobody adding "Freezer 7" from a phone should have to invent a code for
  // it, so one is made from the name — the same way a product gets its SKU.
  if (!id) id = makeFreezerId_(name);
  if (!id) return { ok: false, error: 'A freezer needs a name.' };

  var existing = indexFreezers_();
  if (existing.some(function (x) { return x.id === id; })) {
    return { ok: false, error: 'Freezer ' + id + ' already exists.' };
  }
  if (name && existing.some(function (x) {
        return str_(x.name).toLowerCase() === name.toLowerCase(); })) {
    return { ok: false, error: 'There is already a freezer called "' + name + '".' };
  }

  sheet_(TABS.FREEZERS).appendRow([id, name || id, str_(f.location), 'Yes', str_(f.notes)]);
  return { ok: true, id: id, freezers: indexFreezers_() };
}

/* "Freezer 7" -> F7, "Edmonton" -> EDMONTON, and never a clash. */
function makeFreezerId_(name) {
  var clean = str_(name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!clean) return '';
  var numbered = clean.match(/^FREEZER-?(\d+)$/);
  var base = numbered ? ('F' + numbered[1]) : clean.slice(0, 16);
  var taken = {};
  indexFreezers_().forEach(function (x) { taken[x.id] = true; });
  if (!taken[base]) return base;
  for (var n = 2; n < 100; n++) {
    if (!taken[base + '-' + n]) return base + '-' + n;
  }
  return base + '-' + Date.now();
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

  // A price typed into the sheet is used exactly as typed — those are already
  // finished numbers. Only a weight × $/lb calculation gets rounded, because
  // those are the ones that come out at $84.37.
  var price = 0, basis = '', rounded = false;
  if (weight && perLb) {
    price = round59_(weight * perLb);
    rounded = true;
    basis = weight.toFixed(2) + ' lb × $' + perLb.toFixed(2) + '/lb';
  } else if (perPack) {
    price = perPack;
    basis = 'set price for one ' + p.product;
  } else if (perLb && p.avgWeight) {
    price = round59_(perLb * p.avgWeight);
    rounded = true;
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
    price: Math.round(price * 100) / 100, basis: basis, rounded: rounded,
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
               added: dateStr_(r['Added']), notes: str_(r['Notes']),
               // Somebody who has been invoiced has had their animal; everyone
               // else is still waiting on one. This is what splits the screen
               // into a waiting list and past customers.
               stage: (str_(r['Invoice']) || num_(r['Weight (lb)'])) ? 'past' : 'waiting' };
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
