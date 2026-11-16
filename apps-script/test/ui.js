/* Browser-side checks for the Wholesale screen.
 *
 * index.html is one file with no build step, so the only honest way to test
 * it is to load the page and look at what it draws. jsdom does that. The
 * backend is replaced with a stub that records what the app would have sent,
 * because the point of these checks is the screen and the payloads — the
 * Sheet side is covered by run.js.
 *
 * Install it with `npm install --no-save jsdom`. Without it these checks skip
 * rather than fail, so the backend suite still runs anywhere.
 */
const fs = require('fs');
const path = require('path');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('\nwholesale screen (browser)\n  — skipped: jsdom is not installed\n');
  process.exit(0);
}

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log('  ✓ ' + label);
  else { failures++; console.log('  ✗ ' + label + '\n      expected ' + e + '\n      got      ' + a); }
}

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://proespaul.github.io/pcw-inventory/',
  pretendToBeVisual: true,
  beforeParse(w) {
    // Nothing in these checks should reach the network; if something tries,
    // the promise never settles rather than throwing somewhere confusing.
    w.fetch = () => new Promise(() => {});
    Object.defineProperty(w.navigator, 'serviceWorker', {
      value: { register: () => Promise.resolve({ update() {} }),
               addEventListener() {}, controller: null },
      configurable: true
    });
    w.scrollTo = () => {};
    w.alert = () => {};
  }
});
const w = dom.window;
const doc = w.document;

console.log('\nwholesale screen (browser)');

/* The lines the backend would serve, in the shape lists_() returns. */
const LINES = [
  { row: 2, customer: 'Dale Friesen', phone: '780-555-0141', email: '', wants: 'Half',
    status: 'Ordered', priority: 'High', wantedBy: '2027-02-01', deposit: 500,
    added: '2026-11-02', notes: '', stage: 'ordered' },
  { row: 3, customer: 'Renee Toews', phone: '780-555-0199', email: '', wants: 'Quarter',
    status: 'Ordered', priority: 'Normal', wantedBy: '2026-12-20', deposit: 0,
    added: '2026-11-09', notes: '', stage: 'ordered' },
  { row: 4, customer: 'Ivan Wiebe', phone: '', email: '', wants: 'Whole',
    status: 'Waiting', priority: 'High', wantedBy: '', deposit: 0,
    added: '2026-10-20', notes: 'asked at the market', stage: 'waiting' },
  { row: 5, customer: 'Sarah Penner', phone: '', email: 'sp@example.com', wants: 'Quarter',
    status: 'Waiting', priority: 'Low', wantedBy: '', deposit: 0,
    added: '2026-09-14', notes: '', stage: 'waiting' },
  { row: 6, customer: 'Glen Hiebert', phone: '780-555-0122', email: '', wants: 'Quarter',
    status: 'Past', priority: 'Normal', weight: 232, price: 2088, invoice: 'PCW 061',
    added: '2026-01-10', notes: '', stage: 'past', share: 'Quarter',
    due: '2026-04-10', dueNow: true },
  { row: 7, customer: 'Marie Doerksen', phone: '', email: '', wants: 'Half',
    status: 'Past', priority: 'Normal', weight: 561, price: 4488, invoice: 'PCW 058',
    added: '2026-06-15', notes: '', stage: 'past', share: 'Half',
    due: '2026-12-15', dueNow: false },
  { row: 8, customer: 'Matthias Haecki', phone: '', email: '', wants: 'Whole',
    status: 'Past', priority: 'Normal', weight: 1120, price: 8960, invoice: 'PCW 044',
    added: '2026-08-17', notes: '', stage: 'past', share: 'Whole',
    due: '2027-06-17', dueNow: false }
];

/* Whatever the app would have sent to the backend, caught instead. */
w.eval('window.__sent = [];');
w.api = function (action, payload) {
  w.__sent.push({ action, payload });
  return Promise.resolve({ ok: true, wholesale: [], waitlist: [], customers: [] });
};

w.eval('data.lists = ' + JSON.stringify({ wholesale: LINES, waitlist: [], customers: [
  { customer: 'Ivan Wiebe', phone: '780-555-0188', email: 'ivan@example.com', town: 'Grimshaw' }
] }) + '; renderWholesale();');

const text = id => doc.getElementById(id).textContent.replace(/\s+/g, ' ').trim();
const names = id => Array.from(doc.querySelectorAll('#' + id + ' .item .name b'))
  .map(b => b.textContent.replace(/High|Low/g, '').trim());

/* ───────── the three lists ───────── */
check('ordered and waiting are separate lists',
  [names('whOrderedList').length, names('whWaitingList').length], [2, 2]);
check('ordered is soonest wanted-by first',
  names('whOrderedList'), ['Renee Toews', 'Dale Friesen']);
check('the waiting list is keenest first',
  names('whWaitingList'), ['Ivan Wiebe', 'Sarah Penner']);
check('no past customer is on the screen',
  (text('whOrderedList') + text('whWaitingList')).indexOf('Glen Hiebert'), -1);
check('an ordered line says what the deposit is',
  text('whOrderedList').indexOf('deposit') > -1, true);
check('and says so when there is not one',
  text('whOrderedList').indexOf('no deposit') > -1, true);
check('a waiting line keeps what they want and when they asked',
  /Whole · asked \w+ \d+/.test(text('whWaitingList')), true);
check('and what they said', text('whWaitingList').indexOf('asked at the market') > -1, true);

/* ───────── past behind a button, with the timeframe ───────── */
check('past customers are a button with a count',
  text('whPastBtn'), 'Past customers (3)');
check('the call line counts who is due now',
  text('whCallLine').indexOf('1 is worth a call now') > -1, true);
check('and names who comes up next',
  /Then Marie Doerksen around \w+ \d+/.test(text('whCallLine')), true);

w.eval('openWholesalePast()');
const pastText = text('sheetBody');
check('the past list opens in a panel, soonest due first',
  pastText.indexOf('Glen Hiebert') < pastText.indexOf('Marie Doerksen'), true);
check('anyone due is tagged for a call',
  /Glen Hiebert\s*CALL/.test(doc.getElementById('sheetBody').textContent), true);
check('each one carries its own date',
  pastText.indexOf('freezer likely low') > -1, true);
check('and the invoice is there to see', pastText.indexOf('PCW 061') > -1, true);

/* ───────── one line, in full ───────── */
w.eval('closeSheet(); openWholesale(4);');
check('tapping a name opens their line', text('sheetTitle'), 'Ivan Wiebe');
check('which says where they are', text('sheetSub'), 'On the waiting list');
let body = text('sheetBody');
check('with what they want, how keen, and when they asked',
  ['Whole', 'High', 'What they want', 'How keen', 'Asked'].every(t => body.indexOf(t) > -1), true);
check('a phone the line never had is filled in from the customer book',
  body.indexOf('780-555-0188') > -1, true);
check('and the town with it', body.indexOf('Grimshaw') > -1, true);
check('there is a way to call, text and email',
  Array.from(doc.querySelectorAll('#sheetBody a')).map(a => a.getAttribute('href').split(':')[0]),
  ['tel', 'sms', 'mailto']);
check('a waiting line is moved on by one button',
  body.indexOf('They have ordered') > -1, true);
check('and offers everything they have ordered',
  body.indexOf('See everything they have ordered') > -1, true);

w.eval('closeSheet(); openWholesale(2);');
body = text('sheetBody');
check('an ordered line sends the animal out, or back to waiting',
  [body.indexOf('Animal has gone out') > -1, body.indexOf('Back to the waiting list') > -1],
  [true, true]);

w.eval('closeSheet(); openWholesale(6);');
body = text('sheetBody');
check('a past line shows the weight, the invoice and what it made',
  ['232 lb', 'PCW 061', '$2,088'].every(t => body.indexOf(t) > -1), true);
check('and when their freezer should be getting low',
  body.indexOf('worth a call') > -1, true);
check('a past line is the one that offers another animal',
  body.indexOf('They want another one') > -1, true);

/* ───────── what gets sent, and the row guard ───────── */
w.eval('__sent.length = 0; openWholesale(4); whMove(4, "ordered");');
check('a move quotes the row and the name on it',
  w.__sent.map(s => [s.action, s.payload.row, s.payload.customer, s.payload.to]),
  [['wholesaleMove', 4, 'Ivan Wiebe', 'ordered']]);

w.eval('__sent.length = 0; openWholesale(6); whAgainForm(6);');
w.eval('document.getElementById("whAgainWants").value = "Half"; whAgainSave(6);');
check('wanting another one sends the past line it came from',
  w.__sent.map(s => [s.action, s.payload.row, s.payload.customer, s.payload.wants]),
  [['wholesaleAgain', 6, 'Glen Hiebert', 'Half']]);

w.eval('__sent.length = 0; openWholesale(5); whEditForm(5);');
w.eval('document.getElementById("whEdPhone").value = "780-555-0177";' +
       'document.getElementById("whEdPriority").value = "High"; whEditSave(5);');
check('an edit sends only the fields on the form',
  w.__sent.map(s => [s.action, s.payload.row, s.payload.customer,
                     s.payload.fields.phone, s.payload.fields.priority]),
  [['wholesaleSave', 5, 'Sarah Penner', '780-555-0177', 'High']]);
check('what they already asked for is kept as an option, not rewritten',
  w.__sent[0].payload.fields.wants, 'Quarter');

w.eval('__sent.length = 0; closeSheet(); whEditForm(5);' +
       'document.getElementById("whEdName").value = ""; whEditSave(5);');
check('a line cannot be saved nameless', w.__sent.length, 0);

w.eval('__sent.length = 0; whMove(99, "out");');
check('a row the app no longer knows is never sent', w.__sent.length, 0);

/* ───────── adding somebody ───────── */
w.eval('closeSheet(); openWholesaleAdd();');
check('the form asks which list first',
  text('sheetBody').indexOf('Which list?'), 0);
check('and starts on the waiting list',
  doc.getElementById('whAddStage-waiting').className, 'on');
check('where a wanted-by date is not asked for',
  doc.getElementById('whAddByWrap').style.display, 'none');
w.eval('whSetAddStage("ordered");');
check('choosing ordered asks when they want it',
  doc.getElementById('whAddByWrap').style.display, '');

w.eval('__sent.length = 0;' +
       'document.getElementById("whAddName").value = "Lorne Zacharias";' +
       'document.getElementById("whAddPhone").value = "780-555-0150";' +
       'document.getElementById("whAddWants").value = "Quarter";' +
       'document.getElementById("whAddPriority").value = "High";' +
       'document.getElementById("whAddBy").value = "2027-03-01";' +
       'addWholesale();');
check('adding somebody to the ordered list sends it that way',
  w.__sent.map(s => [s.action, s.payload.entry.customer, s.payload.entry.status,
                     s.payload.entry.wants, s.payload.entry.priority, s.payload.entry.wantedBy]),
  [['addToList', 'Lorne Zacharias', 'Ordered', 'Quarter', 'High', '2027-03-01']]);

w.eval('closeSheet(); openWholesaleAdd(); __sent.length = 0; addWholesale();');
check('and a nameless one is not sent at all', w.__sent.length, 0);

/* ───────── a name with a quote in it must not break the markup ───────── */
w.eval('data.lists.wholesale = data.lists.wholesale.concat([{ row: 20,' +
       ' customer: "Dave O\'Brien <script>", phone: "", email: "", wants: "Half",' +
       ' status: "Waiting", priority: "Normal", added: "2026-11-01", notes: "",' +
       ' stage: "waiting" }]); renderWholesale();');
check('a quote or a tag in a name is drawn as text, not markup',
  doc.querySelectorAll('#whWaitingList script').length, 0);
check('and the name still reads right',
  text('whWaitingList').indexOf("Dave O'Brien <script>") > -1, true);

/* ───────── the empty screen ───────── */
w.eval('data.lists.wholesale = []; renderWholesale();');
check('an empty screen says so rather than going blank',
  [text('whOrderedList'), text('whWaitingList'), text('whPastBtn')],
  ['Nobody waiting on a steer.', 'Nobody on the waiting list.', 'Past customers']);
check('and the call line does not invent anybody',
  text('whCallLine'), 'Nobody has had an animal yet.');

console.log(failures ? '\n' + failures + ' FAILED\n' : '\nAll browser checks passed.\n');
process.exit(failures ? 1 : 0);
