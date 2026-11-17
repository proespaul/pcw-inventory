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

/* Opening a line panel now asks the backend what the other books hold for
   that person. That is a read, and the checks below are about what the app
   writes, so it is filtered out rather than counted as a call. */
const wrote = () => w.__sent.filter(s => s.action !== 'customer');
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
check('with no figure in the figure\'s place when there is no money down',
  Array.from(doc.querySelectorAll('#whOrderedList .item')).map(i => {
    const b = i.querySelector('.qty b');
    return b ? b.textContent : '';
  }), ['', '$500.00']);
check('a waiting line keeps what they want and when they asked',
  /Whole · asked \w+ \d+/.test(text('whWaitingList')), true);
check('and what they said', text('whWaitingList').indexOf('asked at the market') > -1, true);
/* A phone on the line showed on the few lines that carry one and nowhere
   else, which read as a difference between the customers. It belongs behind
   the name, where every line has one. */
check('no phone or email reaches a list line',
  ['780-555-0141', '780-555-0199', 'sp@example.com']
    .some(t => (text('whOrderedList') + ' ' + text('whWaitingList')).indexOf(t) > -1), false);

/* ───────── a title and its list are one card ───────── */
['whOrderedList', 'whWaitingList'].forEach(id => {
  const list = doc.getElementById(id);
  const wrap = list.parentElement;
  check(id + ' sits in the same card as its title',
    [wrap.className, wrap.querySelector('h2').textContent.replace(/\d+$/, '').trim()],
    ['joined', id === 'whOrderedList' ? 'Ordered' : 'Waiting list']);
  check('and the title is the element right above it',
    list.previousElementSibling.querySelector('h2') !== null, true);
  const css = w.getComputedStyle(list);
  check('with nothing between them to read as a gap',
    [css.marginTop, css.borderTopWidth, css.boxShadow],
    ['0px', '0px', 'none']);
});
check('the title says how many are under it',
  [text('whOrderedCount'), text('whWaitingCount')], ['2', '2']);
{
  const h2 = doc.querySelector('#whOrderedList').parentElement.querySelector('h2');
  const name = doc.querySelector('#whOrderedList .item .name b');
  const item = doc.querySelector('#whOrderedList .item');
  check('a section title is set larger than the names under it',
    parseFloat(w.getComputedStyle(h2).fontSize) >
    parseFloat(w.getComputedStyle(name).fontSize), true);
  check('and the names are stepped in from the title',
    parseFloat(w.getComputedStyle(item).paddingLeft) > 8, true);
}

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
  wrote().map(s => [s.action, s.payload.row, s.payload.customer, s.payload.to]),
  [['wholesaleMove', 4, 'Ivan Wiebe', 'ordered']]);

w.eval('__sent.length = 0; openWholesale(6); whAgainForm(6);');
w.eval('document.getElementById("whAgainWants").value = "Half"; whAgainSave(6);');
check('wanting another one sends the past line it came from',
  wrote().map(s => [s.action, s.payload.row, s.payload.customer, s.payload.wants]),
  [['wholesaleAgain', 6, 'Glen Hiebert', 'Half']]);

w.eval('__sent.length = 0; openWholesale(5); whEditForm(5);');
w.eval('document.getElementById("whEdPhone").value = "780-555-0177";' +
       'document.getElementById("whEdPriority").value = "High"; whEditSave(5);');
check('an edit sends only the fields on the form',
  wrote().map(s => [s.action, s.payload.row, s.payload.customer,
                    s.payload.fields.phone, s.payload.fields.priority]),
  [['wholesaleSave', 5, 'Sarah Penner', '780-555-0177', 'High']]);
check('what they already asked for is kept as an option, not rewritten',
  wrote()[0].payload.fields.wants, 'Quarter');

w.eval('__sent.length = 0; closeSheet(); whEditForm(5);' +
       'document.getElementById("whEdName").value = ""; whEditSave(5);');
check('a line cannot be saved nameless', wrote().length, 0);

w.eval('__sent.length = 0; whMove(99, "out");');
check('a row the app no longer knows is never sent', wrote().length, 0);

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
  wrote().map(s => [s.action, s.payload.entry.customer, s.payload.entry.status,
                     s.payload.entry.wants, s.payload.entry.priority, s.payload.entry.wantedBy]),
  [['addToList', 'Lorne Zacharias', 'Ordered', 'Quarter', 'High', '2027-03-01']]);

w.eval('closeSheet(); openWholesaleAdd(); __sent.length = 0; addWholesale();');
check('and a nameless one is not sent at all', wrote().length, 0);

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
check('an empty list leaves no count hanging in its title',
  [text('whOrderedCount'), text('whWaitingCount')], ['', '']);


/* ───────── two numbers are two buttons ─────────
   Picking the first for him is how a second number stayed invisible. */
{
  w.eval('closeSheet(); custCard = { ok: true, name: "Reene Beaudoin", app: null,' +
         ' known: { phone: [{ value: "780-837-1377", where: ["wholesale line"] },' +
         '                   { value: "250-299-4886", where: ["sales sheet"] }],' +
         '           email: [{ value: "reenebeaudoin@gmail.com", where: ["contacts"] }],' +
         '           town: [] }, alsoSpelled: ["Renee Beaudoin"], maybe: ["Reene Beaudion"] };' +
         'document.getElementById("sheetBody").innerHTML = custDetails(custCard);');
  body = text('sheetBody');
  check('both numbers and the email are listed',
    ['780-837-1377', '250-299-4886', 'reenebeaudoin@gmail.com']
      .every(t => body.indexOf(t) > -1), true);
  check('each one is tappable, by the right kind of link',
    Array.from(doc.querySelectorAll('#sheetBody a[href^="tel:"], #sheetBody a[href^="mailto:"]'))
      .map(a => a.getAttribute('href')),
    ['tel:7808371377', 'tel:2502994886', 'mailto:reenebeaudoin@gmail.com']);
  check('the card says how many are on file',
    /2 numbers/.test(body), true);
  check('and which other spelling it went through',
    body.indexOf('Also written Renee Beaudoin') > -1, true);
  check('a name that is merely close is asked about, not counted',
    [/Could .*Reene Beaudion.* be the same person/.test(doc.getElementById('sheetBody').innerHTML),
     body.indexOf('Nothing of theirs is counted above') > -1], [true, true]);
}

/* ───────── the cut waiting list, same shape as wholesale ───────── */
console.log('\ncut waiting list (browser)');
w.eval('closeSheet(); data.products = [{ sku: "GROUND-BEEF", product: "Ground beef" }];' +
       'window.physicalOnHand = function () { return 6; };' +
       'data.lists.waitlist = ' + JSON.stringify([
  { row: 2, customer: 'Neil Harder', phone: '780-555-0177', email: 'neil@example.com', wants: 'GROUND-BEEF',
    words: 'Ground beef', size: 'M', grade: '', packages: 2, added: '2026-11-04',
    status: 'Waiting', told: '', notes: 'wants it before Christmas' },
  { row: 3, customer: 'Alvin Toews', phone: '', email: 'at@example.com', wants: 'Pichana',
    words: 'Pichana', size: '', grade: '', packages: 1, added: '2026-10-28',
    status: 'Waiting', told: '', notes: '' }
]) + '; renderWaitlist();');

const wlNames = Array.from(doc.querySelectorAll('#waitlistList .item .name b'))
  .map(b => b.textContent.replace(/in stock now/g, '').trim());
check('both lines are drawn', wlNames, ['Neil Harder', 'Alvin Toews']);
check('a line reads name, product, when they asked, and the comment',
  /Ground beef · M · asked \w+ \d+/.test(text('waitlistList')) &&
  text('waitlistList').indexOf('wants it before Christmas') > -1, true);
check('and carries no phone or email',
  ['780-555-0177', 'neil@example.com', 'at@example.com']
    .some(t => text('waitlistList').indexOf(t) > -1), false);
check('what is on hand is still on the line',
  text('waitlistList').indexOf('on hand') > -1, true);

w.eval('openWaitlist(2);');
check('tapping a name opens their line', text('sheetTitle'), 'Neil Harder');
body = text('sheetBody');
check('with everything on them',
  ['Waiting for', 'Ground beef', 'Packages', 'Asked', 'Phone', 'Comment']
    .every(t => body.indexOf(t) > -1), true);
check('there is a way to call, text and email',
  Array.from(doc.querySelectorAll('#sheetBody a')).map(a => a.getAttribute('href').split(':')[0]),
  ['tel', 'sms', 'mailto']);
check('and a way through to their orders',
  body.indexOf('See everything they have ordered') > -1, true);

/* A line with no phone of its own falls back to the customer book. */
w.eval('closeSheet(); data.lists.customers = data.lists.customers.concat([' +
       '{ customer: "Alvin Toews", phone: "780-555-0190", email: "", town: "Fairview" }]);' +
       'openWaitlist(3);');
body = text('sheetBody');
check('a phone the line never had is filled in from the customer book',
  [body.indexOf('780-555-0190') > -1, body.indexOf('Fairview') > -1], [true, true]);

w.eval('__sent.length = 0; closeSheet(); wlEditForm(2);');
w.eval('document.getElementById("wlEdNotes").value = "rang her, still waiting";' +
       'document.getElementById("wlEdQty").value = "3"; wlEditSave(2);');
check('an edit quotes the row and the name on it, and sends what changed',
  wrote().map(s => [s.action, s.payload.row, s.payload.customer,
                    s.payload.fields.notes, s.payload.fields.packages,
                    s.payload.fields.wants]),
  [['waitlistSave', 2, 'Neil Harder', 'rang her, still waiting', '3', 'GROUND-BEEF']]);

w.eval('__sent.length = 0; closeSheet(); wlEditForm(2);' +
       'document.getElementById("wlEdName").value = ""; wlEditSave(2);');
check('a line cannot be saved nameless', wrote().length, 0);

w.eval('__sent.length = 0; openWaitlist(99);');
check('a row the app no longer knows opens nothing', wrote().length, 0);

w.eval('closeSheet(); data.lists.waitlist = data.lists.waitlist.concat([{ row: 9,' +
       ' customer: "Dave O\'Brien <script>", phone: "", email: "", wants: "Brisket",' +
       ' words: "Brisket", packages: 1, added: "2026-11-01", notes: "" }]);' +
       'renderWaitlist();');
check('a quote or a tag in a name is drawn as text, not markup',
  doc.querySelectorAll('#waitlistList script').length, 0);

w.eval('data.lists.waitlist = []; renderWaitlist();');
check('an empty list says so rather than going blank',
  text('waitlistList'), 'Nobody waiting on a cut.');

console.log(failures ? '\n' + failures + ' FAILED\n' : '\nAll browser checks passed.\n');
process.exit(failures ? 1 : 0);
