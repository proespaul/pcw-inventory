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
/* A check can set __reply to the answer it wants the backend to give for
   one action, which is how the screens built from a reply get exercised. */
const replies = {};
const replyWith = (action, body) => { replies[action] = body; };
w.api = function (action, payload) {
  w.__sent.push({ action, payload });
  if (replies[action]) return Promise.resolve(replies[action]);
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


/* ───────── a line on the list can be corrected ─────────
   It could only be thrown away and typed again, so three packages entered
   as thirty cost the whole line. */
{
  w.eval('closeSheet(); intakeCart = [];' +
    'data.products = [{ sku: "RIBEYE", product: "Ribeye", category: "Steak",' +
    '                   sizes: "", content: "", grade: "Gold", active: true },' +
    '                 { sku: "GB", product: "Ground beef", category: "Ground",' +
    '                   content: "1 lb", sizes: "", active: true }];' +
    'data.freezers = [{ id: "MAIN", active: true }, { id: "SHOP", active: true }];' +
    'data.stock = [{ sku: "RIBEYE", freezer: "SHOP", packages: 9 }];' +
    'fillSelects();' +
    'document.getElementById("inProduct").value = "RIBEYE"; renderInSizes(); setLineFreezer();' +
    'document.getElementById("inQty").value = "30"; addIntakeLine();');
  check('the line goes on as typed', text('inLines').indexOf('30 pkg') > -1, true);
  check('no size is assigned at intake — there is no way to know one yet',
    JSON.parse(w.eval('JSON.stringify(intakeCart.map(l => l.size))')), ['']);
  check('and the grade it carries is the Gold the form defaults to',
    JSON.parse(w.eval('JSON.stringify(intakeCart.map(l => l.grade))')), ['Gold']);
  check('a steak is one to a pack, so the box is counting steaks',
    text('inPackWhat'), 'One steak to a pack, so this is how many steaks.');
  w.eval('document.getElementById("inProduct").value = "GB"; renderInSizes();');
  check('a pack of ground beef is a weight, and says so',
    text('inPackWhat'), 'One pack is 1 lb, so this is how many packs.');
  w.eval('document.getElementById("inProduct").value = "RIBEYE"; renderInSizes();');

  // Only Picanha has sizes in the catalogue, and steaks are the cut that
  // most needs sorting, so a steak without them still gets a list.
  check('a steak the catalogue says nothing about still has sizes to sort into',
    JSON.parse(w.eval('JSON.stringify(sizeList({ category: "Steak", sizes: "" }))')),
    ['Small', 'Medium', 'Large']);
  check('and the catalogue wins wherever it has an opinion',
    JSON.parse(w.eval('JSON.stringify(sizeList({ category: "Steak",' +
      ' sizes: "Small / Medium / Large" }))')), ['Small', 'Medium', 'Large']);

  /* The Sizes column also holds how a thing is sold. Shanks are packed one
     to a pack and merely go out in pairs, and ground beef bundles are bag
     counts — neither is a band to sort steaks into. */
  check('a selling bundle is not offered as a band to sort into',
    JSON.parse(w.eval('JSON.stringify(sizeList({ category: "Steak",' +
      ' sizes: "2 steaks / 4 steaks" }))')), ['Small', 'Medium', 'Large']);
  check('nor are the website bag bundles',
    JSON.parse(w.eval('JSON.stringify(sizeList({ category: "Ground",' +
      ' sizes: "4 lb / 10 lb / 20 lb (website bundles of 2 lb packs)" }))')), []);
  check('a band that merely sits beside a bundle still comes through',
    JSON.parse(w.eval('JSON.stringify(sizeList({ category: "Steak",' +
      ' sizes: "Small / Large / 4 lb" }))')), ['Small', 'Large']);
  check('a cut that is not a steak is not given bands it does not have',
    JSON.parse(w.eval('JSON.stringify(sizeList({ category: "Ground", sizes: "" }))')), []);

  w.eval('editIntakeLine(0);');
  check('the editor opens on that line with what it says',
    [doc.getElementById('elQty').value, doc.getElementById('elFreezer').value],
    ['30', 'SHOP']);

  w.eval('document.getElementById("elQty").value = "3";' +
         'document.getElementById("elWeight").value = "5.4";' +
         'document.getElementById("elGrade").value = "Silver";' +
         'document.getElementById("elFreezer").value = "MAIN"; saveIntakeLine(0);');
  check('and the correction lands on the line, not a new one',
    JSON.parse(w.eval('JSON.stringify(intakeCart.map(l => [l.packages, l.weight, l.grade, l.freezer]))')),
    [[3, 5.4, 'Silver', 'MAIN']]);
  check('the label follows the grade it was given',
    text('inLines').indexOf('Ribeye · Silver') > -1, true);

  w.eval('editIntakeLine(0); document.getElementById("elQty").value = "0"; saveIntakeLine(0);');
  check('a line cannot be saved down to nothing',
    JSON.parse(w.eval('JSON.stringify(intakeCart.map(l => l.packages))')), [3]);

  w.eval('editIntakeLine(0); dropIntakeLine(0);');
  check('and taking it off still works',
    Number(w.eval('intakeCart.length')), 0);
}

/* ───────── what a size band weighs ─────────
   A box is made up by putting similar steaks together and the price follows
   the weight, so the band has to say what one of them weighs. */
{
  w.eval('closeSheet(); data.stock = [' +
    '{ sku: "RIBEYE", size: "L", grade: "Gold", batch: "S4", freezer: "MAIN", packages: 6, weight: 11.4 },' +
    '{ sku: "RIBEYE", size: "L", grade: "Gold", batch: "S5", freezer: "SHOP", packages: 4, weight: 7.4 },' +
    '{ sku: "RIBEYE", size: "M", grade: "Gold", batch: "S4", freezer: "MAIN", packages: 5, weight: 0 },' +
    '{ sku: "RIBEYE", size: "S", grade: "Gold", batch: "S4", freezer: "MAIN", packages: 3, weight: 3.6 }];');

  const bands = JSON.parse(w.eval('JSON.stringify(sizeBands("RIBEYE"))'));
  check('the bands come out in order with their packs',
    bands.map(b => [b.size, b.packages]), [['L', 10], ['M', 5], ['S', 3]]);
  check('a band spanning two lots averages across both',
    Math.round(bands[0].each * 100) / 100, 1.88);
  check('a band nobody has weighed says so rather than averaging to nothing',
    bands[1].each, null);

  w.eval('document.getElementById("sheetBody").innerHTML = bandCard("RIBEYE");');
  body = text('sheetBody');
  check('the card reads as weight per steak',
    [/L · 10 packs/.test(body), /1\.88 lb each/.test(body), /M · 5 packs/.test(body),
     /not weighed/.test(body)],
    [true, true, true, true]);

  // Half a band weighed is worth saying, because the average is only of that half.
  w.eval('data.stock.push({ sku: "RIBEYE", size: "S", grade: "Gold", batch: "S5",' +
         ' freezer: "MAIN", packages: 2, weight: 0 });' +
         'document.getElementById("sheetBody").innerHTML = bandCard("RIBEYE");');
  check('a part-weighed band says how much of it the average covers',
    /3 of 5 weighed/.test(text('sheetBody')), true);
}

/* ───────── each cut goes back where that cut lives ─────────
   The freezers are organised by cut, so one freezer for a whole animal was
   wrong for most of it and the stock had to be moved afterwards. */
{
  w.eval('closeSheet(); intakeCart = [];' +
    'data.products = [{ sku: "RIBEYE", product: "Ribeye", active: true },' +
    '                 { sku: "OXTAIL", product: "Oxtail", active: true }];' +
    'data.freezers = [{ id: "MAIN", active: true }, { id: "SHOP", active: true }];' +
    'data.stock = [{ sku: "RIBEYE", freezer: "SHOP", packages: 9 },' +
    '              { sku: "RIBEYE", freezer: "MAIN", packages: 2 }];' +
    'fillSelects();');

  w.eval('document.getElementById("inFreezer").value = "MAIN";' +
         'document.getElementById("inProduct").value = "RIBEYE"; setLineFreezer();');
  check('a cut goes back to the freezer most of it is already in',
    doc.getElementById('inLineFreezer').value, 'SHOP');
  check('and says why', text('inFreezerWhy'), 'Where the rest of this cut is kept.');

  w.eval('document.getElementById("inProduct").value = "OXTAIL"; setLineFreezer();');
  check('a cut nobody has stocked falls back to the one on the steer card',
    [doc.getElementById('inLineFreezer').value, text('inFreezerWhy')],
    ['MAIN', 'This cut has not been in a freezer before.']);

  // Two cuts, two freezers, one submission.
  w.eval('document.getElementById("inProduct").value = "RIBEYE"; setLineFreezer();' +
         'document.getElementById("inQty").value = "12"; addIntakeLine();' +
         'document.getElementById("inProduct").value = "OXTAIL"; setLineFreezer();' +
         'document.getElementById("inQty").value = "3"; addIntakeLine();');
  check('each line keeps its own freezer',
    JSON.parse(w.eval('JSON.stringify(intakeCart.map(l => [l.sku, l.freezer]))')),
    [['RIBEYE', 'SHOP'], ['OXTAIL', 'MAIN']]);
  check('and the list shows which freezer each is bound for',
    [text('inLines').indexOf('SHOP') > -1, text('inLines').indexOf('MAIN') > -1],
    [true, true]);

  // The steer has to be an option on the select before it can be chosen.
  w.eval('var b = document.getElementById("inBatch");' +
         'b.innerHTML = "<option>2026-11-STEER-04</option>";' +
         'b.value = "2026-11-STEER-04"; queue.length = 0; submitIntake();');
  check('and the entries go to the freezer the cut lives in, not one for the lot',
    JSON.parse(w.eval('JSON.stringify(queue.filter(o => o.type === "INTAKE")' +
      '.map(o => [o.sku, o.freezer, o.packages]))')),
    [['RIBEYE', 'SHOP', 12], ['OXTAIL', 'MAIN', 3]]);
}

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

/* The screens built from a backend reply finish in a promise, so their
   checks have to wait for it. They run last, inside an async wrapper: a
   top-level await would turn this file into an ES module and the requires
   above would stop resolving. */
const pause = () => new Promise(r => setTimeout(r, 0));

(async () => {
  /* ───────── what came off the steer ─────────
     The yield number alone does not say whether a cut came up short. */
  {
    replyWith('steerYield', { ok: true, batch: 'S4', packages: 60, weight: 100,
      hanging: 200, live: 320, yieldPct: 50, usualYield: 56, comparedWith: 3,
      needsHanging: false, unweighed: 0, cuts: [
        { sku: 'GROUND', product: 'Ground beef', packages: 50, weight: 72, each: 1.44,
          share: 72, usual: 60, off: 'high' },
        { sku: 'RIBEYE', product: 'Ribeye', packages: 5, weight: 8, each: 1.6,
          share: 8, usual: 20, off: 'low' },
        { sku: 'BRISKET', product: 'Brisket', packages: 5, weight: 20, each: 4,
          share: 20, usual: 20, off: '' }] });
    w.eval('closeSheet(); var b = document.getElementById("inBatch");' +
           'b.innerHTML = "<option>S4</option>"; b.value = "S4"; openSteerYield();');
    await pause();
    body = text('sheetBody');
    check('the yield is shown against what the steers before it did',
      [/Yield/.test(body), /50%/.test(body), /56% over 3 steers/.test(body)],
      [true, true, true]);
    check('every cut is listed with its packs, weight and share',
      [/Ground beef/.test(body), /50 packs · 72 lb · 1.44 lb each/.test(body),
       /72%/.test(body)], [true, true, true]);
    check('a cut off its usual share is called out, in the right direction',
      [/Ground beef.*more than usual/.test(body), /Ribeye.*less than usual/.test(body),
       /Brisket.*than usual/.test(body)], [true, true, false]);

    // Nothing to compare against yet must not read as "everything is normal".
    /* A weight typed with a digit missing has to be correctable from here,
     which is the half the add-a-steer form deliberately will not do. */
  replyWith('steerGet', { ok: true, id: 'S4', row: 3, tag: '771', grade: 'BMS 8',
    butcher: 'Simard', killDate: '2026-10-02', packDate: '2026-10-09',
    liveWeight: 1320, hangingWeight: 2000, purchaseCost: 4200,
    butcherCost: 900, otherCost: null });
  replyWith('steerSave', { ok: true, id: 'S4', changed: ['Hanging weight (lb)'] });
  w.eval('closeSheet(); var b3 = document.getElementById("inBatch");' +
         'b3.innerHTML = "<option>S4</option>"; b3.value = "S4"; openSteerEdit();');
  await pause();
  check('the steer opens showing what is on it now',
    [doc.getElementById('seCarc').value, doc.getElementById('seButcher').value,
     doc.getElementById('seTag').value],
    ['2000', 'Simard', '771']);
  /* Carcass weight and hanging weight came apart once Paul said he keeps
     them apart: the carcass is what the plant weighed it at, the hanging
     weight is what it weighed after it hung, and on most animals nobody
     took the second. A steer recorded before the split has one number, and
     it is a carcass weight — so it fills the carcass box and leaves the
     hanging box empty rather than claiming a weight nobody took. */
  check('a steer from before the split reads as a carcass weight, not a hung one',
    doc.getElementById('seHang').value, '');
  check('an empty figure comes through as empty, not as a zero',
    doc.getElementById('seOther').value, '');

  w.eval('__sent.length = 0; document.getElementById("seHang").value = "200";' +
         'saveSteerEdit("S4");');
  await pause();
  const sent = w.__sent.filter(x => x.action === 'steerSave')[0];
  check('saving writes the corrected weight over the old one',
    [sent.payload.id, sent.payload.fields.hangingWeight, sent.payload.fields.butcher],
    ['S4', '200', 'Simard']);

  replyWith('steerYield', { ok: true, batch: 'FIRST', packages: 10, weight: 20,
      hanging: 0, live: 0, yieldPct: null, usualYield: null, comparedWith: 0,
      needsHanging: true, unweighed: 0, cuts: [{ sku: 'RIBEYE', product: 'Ribeye',
        packages: 10, weight: 20, each: 2, share: 100, usual: null, off: '' }] });
    // Closing the panel re-renders, which empties the steer select, so the
  // steer has to be put back before asking again.
  w.eval('closeSheet(); var b2 = document.getElementById("inBatch");' +
         'b2.innerHTML = "<option>FIRST</option>"; b2.value = "FIRST";' +
         'openSteerYield();');
    await pause();
    body = text('sheetBody');
    check('the first steer says it has nothing to be compared with',
      /needs a couple of steers/.test(body), true);
    check('and a missing hanging weight says where to put it',
      [/No hanging weight/.test(body), /New steer/.test(body)], [true, true]);
  }

  /* ───────── the two screens that went ─────────
     Inventory status listed what the stock screen already tags, and Price
     changes was an audit trail of a two-person shop. Both are off the menu;
     the gathering the first one did is now a line on the stock screen. */
  {
    const menu = doc.getElementById('view-menu').innerHTML;
    check('the menu no longer offers a separate stock-status screen',
      /Inventory status/.test(menu), false);
    check('nor a price-changes screen',
      /Price changes/.test(menu), false);
    /* Market day went too, once Paul described how he actually sells one
       ribeye at the table: open the product, read the market price off it,
       take one out as "Sold in person". Four taps on a screen he was using
       anyway, against a screen he was not. */
    check('nor a market-day screen', /Market day/.test(menu), false);
    check('and the cattle do have one', /Cattle performance/.test(menu), true);
    check('and no dead screens were left behind',
      [!!doc.getElementById('view-status'), !!doc.getElementById('view-pricelog'),
       !!doc.getElementById('view-market')],
      [false, false, false]);
  }

  /* ───────── what is short, gathered on the stock screen ───────── */
  {
    w.eval('invKind = "cuts";' +
      'data.products = [' +
      '{sku:"RIBEYE", product:"Ribeye Steak", price:63, kind:"Steak"},' +
      '{sku:"TALLOW", product:"Whipped Tallow", price:30, kind:"Other"},' +
      '{sku:"JERKY",  product:"Jerky", price:12, kind:"Other"}];' +
      // productTotals reads the stock lines, so they are what decides status.
      'window.productTotals = function () { return [' +
      '{sku:"RIBEYE", product:"Ribeye Steak", content:"", packages:40, weight:40,' +
      ' value:0, committed:0, available:40, status:"ok", days:1, lines:[]},' +
      '{sku:"TALLOW", product:"Whipped Tallow", content:"", packages:-3, weight:0,' +
      ' value:0, committed:0, available:-3, status:"oversold", days:1, lines:[]},' +
      '{sku:"JERKY", product:"Jerky", content:"", packages:1, weight:1,' +
      ' value:0, committed:0, available:1, status:"low", days:1, lines:[]}];};' +
      'document.getElementById("stockSearch").value = "";' +
      'invTrouble = false; renderStock();');

    check('the stock screen says how many need looking at',
      /2 to look at/.test(text('stockTrouble')), true);
    check('and names what is wrong with them',
      [/promised more than we have/.test(text('stockTrouble')),
       /running low/.test(text('stockTrouble'))], [true, true]);
    check('everything is listed until it is asked to narrow',
      names('stockList').length, 3);

    w.eval('toggleTrouble();');
    const narrowed = names('stockList');
    check('tapping it leaves only those two',
      [narrowed.length, narrowed.indexOf('Ribeye Steak')], [2, -1]);
    check('and it says it is narrowed, with a way back',
      [/Showing 2 to look at/.test(text('stockTrouble')),
       /\ball\b/.test(text('stockTrouble'))], [true, true]);
    /* The card at the top counts the freezer, not the narrowed list. Counted
       after narrowing it read "−2 packages" — the shortfall, shown as
       everything there is. */
    check('the totals still count the whole freezer, not the two shown',
      /38 packages/.test(text('stockTotals')), true);

    w.eval('toggleTrouble();');
    check('tapping again puts everything back', names('stockList').length, 3);

    // Nothing wrong anywhere: the line goes rather than reading "0 to look at".
    w.eval('window.productTotals = function () { return [' +
      '{sku:"RIBEYE", product:"Ribeye Steak", content:"", packages:40, weight:40,' +
      ' value:0, committed:0, available:40, status:"ok", days:1, lines:[]}];};' +
      'renderStock();');
    check('with nothing short, no line appears at all',
      doc.getElementById('stockTrouble').innerHTML, '');
  }

  /* ───────── customers, filed by surname ─────────
     Alphabetical by last name, which is the last word of it — except where
     the last word is not a surname, and then the 'File as' column decides. */
  {
    w.eval('data.lists.customers = ' + JSON.stringify([
      { customer: 'Neil Fehr', phone: '780-555-0101', email: '', last: '2026-11-01' },
      { customer: 'What The Chuck', phone: '', email: '', fileAs: 'What The Chuck' },
      { customer: 'Abby Redman', phone: '', email: 'abby@example.com', last: '2026-01-04' },
      { customer: 'Cameron & Faith Beaudoin', phone: '', email: '' },
      { customer: 'Angelica', phone: '', email: '' }
    ]) + '; document.getElementById("clientSearch").value = ""; renderClients();');

    check('the list runs A to Z by surname, not by who ordered last',
      names('clientList'),
      ['Angelica', 'Cameron & Faith Beaudoin', 'Neil Fehr', 'Abby Redman', 'What The Chuck']);
    check('each letter is written once above its names',
      Array.from(doc.querySelectorAll('#clientList .kindhead')).map(h => h.textContent),
      ['A', 'B', 'F', 'R', 'W']);
    check('and the count is said out loud',
      /5 customers/.test(text('clientCount')), true);

    // Searching is looking for one person, so the letters get out of the way.
    w.eval('document.getElementById("clientSearch").value = "abby"; renderClients();');
    check('a search drops the letters and leaves the match',
      [doc.querySelectorAll('#clientList .kindhead').length, names('clientList')],
      [0, ['Abby Redman']]);
    w.eval('document.getElementById("clientSearch").value = ""; renderClients();');

    check('the three books are no longer a thing to manage above the list',
      /three books/i.test(doc.getElementById('clientBooks').innerHTML), false);
    check('squaring them up still is',
      /syncBooks/.test(doc.getElementById('clientBooks').innerHTML), true);
  }

  /* ───────── cattle performance ─────────
     Most of these animals went home with the customer straight from the
     butcher and were never weighed by us. A weight nobody took has to read
     as "unavailable" — a zero would average into the yield, and a blank
     reads as though somebody forgot to type it. */
  {
    /* June was weighed on the rail and F2 on the hoof, so their yields are
       not the same measurement: 530.8 over a carcass against 996.9 over a
       live weight. Averaged together they would read as one usual. */
    /* It arrives with the sync now, not on opening the tab: five animals
       that change a few times a year were being fetched from the script
       every single time the screen was looked at. */
    const herd = { ok: true, weighed: 2, usualCut: 41.12, usualTake: 52.47,
      cutters: 1, takers: 1, steers: [
      { id: 'June-2026', outfit: 'PCW', when: '2026-06-01', live: null, hanging: 1290.8,
        hung: null, meat: 530.8, aside: 362.5, packages: 0, yieldPct: 41.12,
        cutYield: 41.12, takeYield: null, yieldKind: 'carcass',
        covers: '', hasBreakdown: true, fromRecord: true, notes: '' },
      { id: 'F2', outfit: 'PCW', when: '2026-03-31', live: 1900, hanging: null,
        hung: null, meat: 996.9, aside: 201.3, packages: 222, yieldPct: 52.47,
        cutYield: null, takeYield: 52.47, yieldKind: 'live',
        covers: "PCW's own share only", hasBreakdown: true, fromRecord: true, notes: '' },
      { id: 'June-2026-Wholesale', outfit: 'Wholesale', when: '', live: 1154.2,
        hanging: null, hung: null, meat: null, aside: null, packages: null,
        yieldPct: null, cutYield: null, takeYield: null, yieldKind: '',
        covers: '', hasBreakdown: false, fromRecord: false, notes: '' }
    ]};
    w.eval('data.cattle = ' + JSON.stringify(herd) + '; showView("cattle");');
    /* Nothing answers a 'cattle' call in this test, so the screen below
       could only have been drawn from what the sync brought down. */
    check('the herd draws with no reply waiting for it',
      names('cattleList').length > 0, true);

    /* A phone that has not synced since the herd was added to the payload
       has none in its data, and an empty card reads as "no animals". It
       asks for it instead. */
    replyWith('cattle', herd);
    w.eval('data.cattle = null; openCattle.asking = false; showView("cattle");');
    await pause(); await pause();
    check('a phone with no herd yet goes and asks for one',
      names('cattleList').length, 3);

    /* And a phone holding an OLD herd asks too. This is the one that bit:
       the June steer sat there with its meat weight and no yield, because
       the only test for going back was whether the list was empty, and a
       stale list is not an empty one. */
    const fresher = JSON.parse(JSON.stringify(herd));
    fresher.steers[0].yieldPct = 41.12;
    fresher.steers[0].hanging = 1290.8;
    replyWith('cattle', fresher);
    w.eval('data.cattle = ' + JSON.stringify((function () {
      const old = JSON.parse(JSON.stringify(herd));
      old.steers[0].yieldPct = null;
      old.steers[0].cutYield = null;
      old.steers[0].hanging = null;
      old.steers[0].yieldKind = '';
      return old;
    })()) + '; openCattle.asking = false; showView("cattle");');
    check('the stale figure is what it draws first, with no waiting',
      /unavailable/.test(text('cattleList')), true);
    await pause(); await pause();
    check('and it is replaced by the current one a moment later',
      /41.12%/.test(text('cattleList')), true);

    /* And a herd that came back broken says so rather than drawing as a
       herd of none. */
    w.eval('data.cattle = { ok: false, steers: [], error: "the tab is missing" };' +
           'renderCattle();');
    check('a herd that could not be read says so, not "no animals"',
      [/Could not read the herd/.test(text('cattleTop')),
       /no animals/i.test(text('cattleList'))], [true, false]);
    w.eval('data.cattle = ' + JSON.stringify(herd) + '; renderCattle();');

    // The tags sit inside the name, so take the text before them.
    const cNames = Array.from(doc.querySelectorAll('#cattleList .item .name b'))
      .map(b => (b.firstChild ? b.firstChild.textContent : b.textContent).trim());
    check('every animal is listed, newest first',
      cNames, ['June-2026', 'F2', 'June-2026-Wholesale']);
    check('the ones with no date go last, not first',
      cNames[cNames.length - 1], 'June-2026-Wholesale');

    const body = text('cattleList');
    check('a weight nobody took says so rather than reading as a blank',
      /carcass unavailable/.test(body), true);
    check('and a yield that cannot be worked out is not drawn as 0%',
      [/unavailable/.test(body), /\b0%/.test(body)], [true, false]);
    check('a steer somebody else took says whose it was',
      /Wholesale/.test(doc.getElementById('cattleList').innerHTML), true);
    check('one with nothing recorded off it says that too',
      /nothing recorded off it/.test(body), true);
    check('the two kinds of yield are averaged apart, not together',
      [/41.12% of the carcass/.test(text('cattleTop')),
       /52.47% of the live weight/.test(text('cattleTop'))], [true, true]);
    check('and each animal says which of the two its own figure is',
      [/of the carcass/.test(body), /of the live weight/.test(body)], [true, true]);
    check('and the count is on the menu', text('cCattle'), '3');

    // Tapping a name opens the cut-by-cut, and says what it covers when the
    // record is only part of the animal.
    replyWith('steerYield', { ok: true, batch: 'F2', live: null, hanging: 1900,
      packages: 222, weight: 996.9, recordedWeight: 293.6, partial: true,
      covers: "PCW's own share only — 293.6 lb of the 996.9 lb the animal made",
      aside: 201.3, yieldPct: 52.47, usualYield: 41.12, comparedWith: 1,
      needsHanging: false, unweighed: 0, weighedPackages: 222, sharesCover: 100,
      cuts: [{ sku: 'GROUND-BEEF-1-LB', product: 'Ground Beef', packages: 130,
               weight: 129.5, each: 1, counts: true, share: 44.1, usual: null, off: '' },
             { sku: 'CROSS-RIB-ROAST', product: 'Cross Rib Roast', packages: 0,
               weight: 21.1, each: null, counts: true, share: 7.19, usual: null, off: '' },
             { sku: 'RENDERED-TALLOW', product: 'Fat', packages: 0, weight: 171.5,
               each: null, counts: false, share: null, usual: null, off: '' }] });
    w.eval('openSteerBreakdown("F2", "cattle");');
    await pause(); await pause();
    const sheet = text('sheetBody');
    check('the breakdown says the whole animal\u2019s weight',
      /996.9 lb/.test(sheet), true);
    check('and says the cut list under it is only part of that',
      [/293.6 lb/.test(sheet), /share only/.test(sheet)], [true, true]);
    check('fat, bone and organs are named as outside the yield',
      /Fat, bone, organs/.test(sheet) && /outside the yield/.test(sheet), true);
    /* A weight deliberately left out of the yield is not a weight nobody
       took. 171.5 lb of tallow read "needs weighing" until these were told
       apart, and the shares are of what is listed, not of the whole animal
       when only part of it is listed. */
    check('a share worked out over part of the animal says so',
      /of what is listed/.test(sheet), true);
    const asideRow = Array.from(doc.querySelectorAll('#sheetBody .item'))
      .find(d => /Fat/.test(d.textContent));
    check('and the fat is called out of the yield, not unweighed',
      [/not in the yield/.test(asideRow.textContent),
       /needs weighing/.test(asideRow.textContent)], [true, false]);
    check('a cut the sheet never counted says so rather than "0 packs"',
      /no pack count/.test(sheet), true);
  }

  /* ───────── the sales behind a figure ─────────
     Every number on this screen totals particular sales, and the question
     it raises is always "which ones?". It used to be answered by a list of
     all 46 underneath, which answers a different question. */
  {
    w.eval('data.salesBook = ' + JSON.stringify([
      { date: '2026-04-02', customer: 'Katelyn Kelly', by: 'Hannah', what: '20 lb ground beef',
        amount: 240, net: 0, paid: false, paymentType: '', note: '', orderId: '' },
      { date: '2026-04-29', customer: 'Dorothy Douglas', by: 'Hannah', what: '20 lb GB',
        amount: 439, net: 0, paid: false, paymentType: '', note: '', orderId: '' },
      { date: '2026-06-23', customer: 'Jeff Cappis', by: 'Website', what: 'Front quarter',
        amount: 1649, net: 0, paid: true, paymentType: 'E-transfer',
        note: 'Entered QBO \u00b7 PCW #048 $1649.00', orderId: '' },
      { date: '2026-06-10', customer: 'Katelyn Kelly', by: 'Hannah', what: 'pepperoni',
        amount: 100, net: 0, paid: true, paymentType: 'Cash', note: '', orderId: '' }
    ]) + '; data.settings = data.settings || {}; data.settings.FISCAL_YEAR_STARTS = 4;' +
      'data.orders = []; showView("sales");');

    check('the long list of every sale is gone from the screen',
      !!doc.getElementById('salesList'), false);

    // The figure Paul asked about: what is it made of?
    w.eval('openSalesList("unpaid");');
    const unpaid = text('sheetBody');
    check('the unpaid figure opens the sales that make it up',
      [/Katelyn Kelly/.test(unpaid), /Dorothy Douglas/.test(unpaid)], [true, true]);
    check('and leaves out the ones that were paid for',
      /Jeff Cappis/.test(unpaid), false);
    check('the sheet says what it adds up to',
      /679/.test(text('sheetSub')), true);
    /* The Payment column being empty is not the same as the customer not
       having paid, and the difference is the whole of what Paul wanted to
       know. The card says so rather than calling them debts. */
    check('and says what an empty Payment column actually means',
      /never ticked|left empty/.test(unpaid), true);

    // By customer, for a year's worth; one by one, for a month's.
    w.eval('salesListBy("person");');
    const byPerson = text('sheetBody');
    check('the same figure can be read by customer instead',
      /Katelyn Kelly/.test(byPerson) && /2 sales|1 sale/.test(byPerson), true);
    w.eval('salesListBy("date");');

    w.eval('openSalesList("all");');
    const all = text('sheetBody');
    check('"sold" opens everything, paid or not', /Jeff Cappis/.test(all), true);
    /* An invoice number is written in the comment, because the sheet has
       no column for one. It is pulled out where there is one. */
    check('an invoice number written in a comment is found and shown',
      /PCW #048/.test(doc.getElementById('sheetBody').innerHTML), true);

    w.eval('openSalesList("2026-04");');
    const apr = text('sheetBody');
    check('a month opens its own sales and no others',
      [/Katelyn Kelly/.test(apr), /Jeff Cappis/.test(apr)], [true, false]);
    w.eval('closeSheet();');
  }

  /* ───────── Kenji says nothing about how long he will be ───────── */
  {
    w.eval('kenjiWaiting("how many ribeye");');
    check('the bar says something is running',
      doc.getElementById('kBar').className, 'going');
    check('and no countdown is guessed at',
      /\d+\s*s\b/.test(text('kSay')), false);
    w.eval('kenjiDoneWaiting(true);');
    check('and it stops when the answer lands',
      doc.getElementById('kBar').className, '');
  }

  console.log(failures ? '\n' + failures + ' FAILED\n' : '\nAll browser checks passed.\n');
  process.exit(failures ? 1 : 0);
})();
