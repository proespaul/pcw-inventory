const { buildContext } = require('./harness');

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log('  ✓ ' + label); }
  else { failures++; console.log('  ✗ ' + label + '\n      expected ' + e + '\n      got      ' + a); }
}

const ctx = buildContext();
const ss = ctx.__ss;

console.log('\nsetup()');
ctx.setup();
check('all tabs created', Object.keys(ss.sheets).sort(),
  ['ALERTS','BATCHES','BOX RECIPES','CUSTOMERS','CUT WAITLIST','CUT YIELD MODEL','FOLLOW-UPS',
   'FREEZER TEMPS','FREEZERS','INVENTORY',
   'MOVEMENTS','ORDER ITEMS','ORDERS','PRICE CHANGES','PRODUCTS','SALES HISTORY','SCANS','SETTINGS',
   'SIGN-IN LOG','STAFF','STEER CUT RECORD','STEER PERFORMANCE',
   'STOCK BY PRODUCT','WHOLESALE']);
check('freezers seeded', ctx.indexFreezers_().map(f => f.id), ['MAIN','SHOP','TRUCK']);
check('token generated', typeof ctx.PropertiesService.getScriptProperties().getProperty('API_TOKEN'), 'string');

console.log('\ncatalogue');
ctx.addProduct_({ product: 'Ribeye Steak', content: '2 × 12 oz', avgWeight: 1.6, grade: 'Gold', price: 44, reorder: 6 });
ctx.addProduct_({ product: 'Ground Beef', content: '1 lb', avgWeight: 1, price: 14, reorder: 20 });
ctx.addBatch_({ id: '2026-STEER-01', animal: '812', outfit: 'PCW', packDate: '2026-06-10', grade: 'Gold' });
ctx.addBatch_({ id: '2026-STEER-02', animal: '907', outfit: 'PCW', packDate: '2026-09-01', grade: 'Bronze' });
check('SKUs generated', Object.keys(ctx.indexProducts_()).sort(), ['GROUND-BEEF','RIBEYE-STEAK']);
check('duplicate product refused', ctx.addProduct_({ product: 'Ribeye Steak' }).ok, false);

console.log('\nprice columns');
ctx.rebuildInventory();   // normalizePrices_ runs as part of every rebuild
let prods = ctx.indexProducts_();
check('per-lb derived from pack price ÷ avg weight', prods['RIBEYE-STEAK'].pricePerLb, 27.5);
check('per-kg derived from per-lb', prods['RIBEYE-STEAK'].pricePerKg, 60.63);
ctx.addProduct_({ product: 'Striploin Roast', content: '3 lb', avgWeight: 3, pricePerLb: 32 });
prods = ctx.indexProducts_();
check('per-kg filled from a per-lb entry', prods['STRIPLOIN-ROAST'].pricePerKg, 70.55);
check('pack price filled from per-lb × weight', prods['STRIPLOIN-ROAST'].price, 96);
ctx.addProduct_({ product: 'Brisket', content: 'whole', avgWeight: 12, pricePerKg: 44 });
ctx.rebuildInventory();
check('per-lb back-filled from per-kg', ctx.indexProducts_()['BRISKET'].pricePerLb, 19.96);
check('a typed price is never overwritten', ctx.indexProducts_()['GROUND-BEEF'].price, 14);

console.log('\nmigrating a sheet built before the price columns existed');
{
  const old2 = buildContext();
  const sh = old2.__ss.insertSheet('PRODUCTS');
  sh.data = [
    ['SKU','Product','Category','Content','Avg weight (lb)','Default grade','Price','Reorder point','Active','Notes'],
    ['TBONE','T-Bone','Steak','1 × 16 oz',1.3,'Gold',38,4,'Yes','keep']
  ];
  old2.setup();
  const row = old2.readTable_('PRODUCTS')[0];
  check('header updated in place', Object.keys(row).indexOf('Price / lb') > -1, true);
  check('reorder point did not slide into a price column', row['Reorder point'], 4);
  check('notes stayed put', row['Notes'], 'keep');
  check('the old Price column became Price / pack', old2.indexProducts_()['TBONE'].price, 38);
  old2.rebuildInventory();
  check('per-lb computed for the migrated row', old2.indexProducts_()['TBONE'].pricePerLb, 29.23);
  check('per-kg computed for the migrated row', old2.indexProducts_()['TBONE'].pricePerKg, 64.44);
}

const TOKEN = ctx.PropertiesService.getScriptProperties().getProperty('API_TOKEN');
const call = (action, payload) => JSON.parse(ctx.handle_({ parameter: {} },
  Object.assign({ action, token: TOKEN }, payload || {}))._text);

console.log('\nauth');
// ping deliberately takes no sign-in — it is the only way to read the build
// from outside, so it is not the action to test the door with.
check('ping is open by design', JSON.parse(ctx.handle_({ parameter: {} }, { action: 'ping' })._text).ok, true);
check('bad token refused', JSON.parse(ctx.handle_({ parameter: {} }, { action: 'lists', token: 'nope' })._text).ok, false);
check('and no token at all refused', JSON.parse(ctx.handle_({ parameter: {} }, { action: 'lists' })._text).ok, false);
check('good token ok', call('ping').ok, true);
check('good token opens a real action', call('lists').ok, true);

console.log('\nintake');
call('submit', { ops: [
  { clientKey: 'a1', type: 'INTAKE', sku: 'RIBEYE-STEAK', batch: '2026-STEER-01', freezer: 'MAIN', packages: 10, weight: 16, grade: 'Gold' },
  { clientKey: 'a2', type: 'INTAKE', sku: 'GROUND-BEEF',  batch: '2026-STEER-01', freezer: 'MAIN', packages: 40 }
]});
let stock = ctx.currentStock_();
check('ribeye on hand', stock.find(l => l.sku === 'RIBEYE-STEAK').packages, 10);
check('ribeye weight', stock.find(l => l.sku === 'RIBEYE-STEAK').weight, 16);
check('ground weight from avg', stock.find(l => l.sku === 'GROUND-BEEF').weight, 40);

console.log('\nidempotent replay (offline queue sent twice)');
const replay = call('submit', { ops: [
  { clientKey: 'a1', type: 'INTAKE', sku: 'RIBEYE-STEAK', batch: '2026-STEER-01', freezer: 'MAIN', packages: 10, weight: 16 }
]});
check('duplicate accepted but not doubled', ctx.currentStock_().find(l => l.sku === 'RIBEYE-STEAK').packages, 10);
check('client key echoed back', replay.accepted, ['a1']);

console.log('\nsecond batch + oldest-first allocation');
call('submit', { ops: [
  { clientKey: 'b1', type: 'INTAKE', sku: 'RIBEYE-STEAK', batch: '2026-STEER-02', freezer: 'SHOP', packages: 8, weight: 13.6, grade: 'Bronze' }
]});
call('submit', { ops: [
  { clientKey: 'c1', type: 'SALE', sku: 'RIBEYE-STEAK', packages: 12, party: 'J. Wiebe' }
]});
stock = ctx.currentStock_();
const b1 = stock.find(l => l.batch === '2026-STEER-01' && l.sku === 'RIBEYE-STEAK');
const b2 = stock.find(l => l.batch === '2026-STEER-02' && l.sku === 'RIBEYE-STEAK');
check('oldest batch drained first', b1, undefined);
check('remainder off the newer batch', b2.packages, 6);
check('weight followed the packages', b2.weight, 10.2);

console.log('\ntransfer between freezers');
call('submit', { ops: [
  { clientKey: 'd1', type: 'TRANSFER', sku: 'GROUND-BEEF', batch: '2026-STEER-01', freezer: 'MAIN', toFreezer: 'TRUCK', packages: 6 }
]});
stock = ctx.currentStock_();
check('left MAIN', stock.find(l => l.sku === 'GROUND-BEEF' && l.freezer === 'MAIN').packages, 34);
check('arrived in TRUCK', stock.find(l => l.sku === 'GROUND-BEEF' && l.freezer === 'TRUCK').packages, 6);
check('transfer is weight-neutral overall',
  Math.round(stock.filter(l => l.sku === 'GROUND-BEEF').reduce((s, l) => s + l.weight, 0) * 100) / 100, 40);

console.log('\nrecount + shrink');
call('submit', { ops: [
  { clientKey: 'e1', type: 'COUNT', sku: 'GROUND-BEEF', batch: '2026-STEER-01', freezer: 'MAIN', packages: 31, party: 'Freezer count' }
]});
check('recount wrote the difference', ctx.currentStock_().find(l => l.sku === 'GROUND-BEEF' && l.freezer === 'MAIN').packages, 31);
call('submit', { ops: [
  { clientKey: 'e2', type: 'ADJUST', sku: 'GROUND-BEEF', batch: '2026-STEER-01', freezer: 'TRUCK', packages: -2, party: 'Spoiled / freezer burn' }
]});
check('spoilage removed', ctx.currentStock_().find(l => l.sku === 'GROUND-BEEF' && l.freezer === 'TRUCK').packages, 4);

console.log('\noversell handling');
const over = call('submit', { ops: [
  { clientKey: 'f1', type: 'SALE', sku: 'RIBEYE-STEAK', packages: 10, party: 'Big order' }
]});
check('warns rather than silently failing', over.warnings.length > 0, true);
check('stock shows the shortfall', ctx.currentStock_().find(l => l.sku === 'RIBEYE-STEAK' && l.packages < 0) !== undefined, true);

console.log('\norders');
// Restock so the order has something to draw on.
call('submit', { ops: [
  { clientKey: 'g0', type: 'INTAKE', sku: 'RIBEYE-STEAK', batch: '2026-STEER-02', freezer: 'MAIN', packages: 20, weight: 32 },
  { clientKey: 'g0b', type: 'INTAKE', sku: 'GROUND-BEEF', batch: '2026-STEER-02', freezer: 'MAIN', packages: 20 }
]});
const before = ctx.currentStock_().filter(l => l.sku === 'RIBEYE-STEAK').reduce((s, l) => s + l.packages, 0);

call('submit', { ops: [{
  clientKey: 'o1', type: 'ORDER_NEW', orderId: 'ORD-TEST-1', customer: 'J. Wiebe',
  contact: '780-555-0101', deliveryDate: '2026-09-25', method: 'Delivery', user: 'Hannah',
  lines: [{ sku: 'RIBEYE-STEAK', packages: 4 }, { sku: 'GROUND-BEEF', packages: 10 }]
}]});
let orders = ctx.readOrders_();
check('order created', orders.length, 1);
check('order starts open', orders[0].status, 'Open');
check('lines stored', orders[0].items.map(i => i.sku + ':' + i.packages), ['RIBEYE-STEAK:4','GROUND-BEEF:10']);
check('delivery date kept', orders[0].deliveryDate, '2026-09-25');
check('stock untouched until packed',
  ctx.currentStock_().filter(l => l.sku === 'RIBEYE-STEAK').reduce((s, l) => s + l.packages, 0), before);

call('submit', { ops: [{ clientKey: 'o1', type: 'ORDER_NEW', orderId: 'ORD-TEST-1', customer: 'J. Wiebe',
  lines: [{ sku: 'RIBEYE-STEAK', packages: 4 }] }]});
check('re-sent order does not duplicate', ctx.readOrders_().length, 1);

const packed = call('submit', { ops: [{
  clientKey: 'p1', type: 'ORDER_PACK', orderId: 'ORD-TEST-1', user: 'Hannah'
}]});
orders = ctx.readOrders_();
check('order marked packed', orders[0].status, 'Packed');
check('packing took the meat out',
  ctx.currentStock_().filter(l => l.sku === 'RIBEYE-STEAK').reduce((s, l) => s + l.packages, 0), before - 4);
check('packed quantities written back', orders[0].items.map(i => i.packed), [4, 10]);
check('movements name the order',
  ctx.readTable_('MOVEMENTS').filter(r => String(r['Note']).indexOf('ORD-TEST-1') > -1).length > 0, true);
check('re-packing is a no-op',
  (call('submit', { ops: [{ clientKey: 'p2', type: 'ORDER_PACK', orderId: 'ORD-TEST-1' }]}),
   ctx.currentStock_().filter(l => l.sku === 'RIBEYE-STEAK').reduce((s, l) => s + l.packages, 0)), before - 4);

call('submit', { ops: [{ clientKey: 's1', type: 'ORDER_STATUS', orderId: 'ORD-TEST-1', status: 'Delivered' }]});
check('order delivered', ctx.readOrders_()[0].status, 'Delivered');

// Short pack: only some of what was ordered actually goes in the box.
call('submit', { ops: [{
  clientKey: 'o2', type: 'ORDER_NEW', orderId: 'ORD-TEST-2', customer: 'M. Friesen',
  deliveryDate: '2026-09-24', lines: [{ sku: 'GROUND-BEEF', packages: 8 }]
}]});
const gBefore = ctx.currentStock_().filter(l => l.sku === 'GROUND-BEEF').reduce((s, l) => s + l.packages, 0);
call('submit', { ops: [{
  clientKey: 'p3', type: 'ORDER_PACK', orderId: 'ORD-TEST-2',
  lines: [{ sku: 'GROUND-BEEF', packages: 5 }]
}]});
check('short pack deducts only what went in the box',
  ctx.currentStock_().filter(l => l.sku === 'GROUND-BEEF').reduce((s, l) => s + l.packages, 0), gBefore - 5);
check('order sheet totals filled', (ctx.rebuildInventory(),
  ctx.readTable_('ORDERS').find(r => r['Order ID'] === 'ORD-TEST-2')['Packages packed']), 5);
check('bad status refused',
  call('submit', { ops: [{ clientKey: 's9', type: 'ORDER_STATUS', orderId: 'ORD-TEST-2', status: 'Whenever' }]}).warnings.length > 0, true);

console.log('\nsizes as a lot dimension');
{
  const c = buildContext();
  c.setup();
  c.addProduct_({ product: 'Sirloin Steak', content: '2 per pack', sizes: 'S, M, L', avgWeight: 1.0, price: 24.9, reorder: 6 });
  c.addBatch_({ id: 'M26', packDate: '2026-06-01' });
  c.addBatch_({ id: 'OLD', packDate: '2025-10-01' });
  const tk = c.PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  const go = (a, p) => JSON.parse(c.handle_({ parameter: {} }, Object.assign({ action: a, token: tk }, p || {}))._text);

  go('submit', { ops: [
    { clientKey: 'z1', type: 'INTAKE', sku: 'SIRLOIN-STEAK', size: 'L', grade: 'Silver', batch: 'M26', freezer: 'MAIN', packages: 5, weight: 6.5 },
    { clientKey: 'z2', type: 'INTAKE', sku: 'SIRLOIN-STEAK', size: 'M', grade: 'Silver', batch: 'M26', freezer: 'MAIN', packages: 8, weight: 8 },
    { clientKey: 'z3', type: 'INTAKE', sku: 'SIRLOIN-STEAK', size: 'M', grade: 'Bronze', batch: 'OLD', freezer: 'SHOP', packages: 4, weight: 3.8 }
  ]});
  const stock = c.currentStock_();
  check('one product, three lots', stock.length, 3);
  check('sizes kept apart', stock.map(l => l.size + '/' + l.grade).sort(), ['L/Silver','M/Bronze','M/Silver']);
  check('product rolls them up', (c.rebuildInventory(),
    c.readTable_('STOCK BY PRODUCT').find(r => r['SKU'] === 'SIRLOIN-STEAK')['Packages']), 17);
  check('sizes listed on the product', c.indexProducts_()['SIRLOIN-STEAK'].sizes, 'S, M, L');

  // selling a size takes it from that size only, oldest batch first
  go('submit', { ops: [{ clientKey: 'z4', type: 'SALE', sku: 'SIRLOIN-STEAK', size: 'M', packages: 5, party: 'Market' }]});
  const after = c.currentStock_();
  check('oldest M drained', after.find(l => l.batch === 'OLD'), undefined);
  check('large untouched', after.find(l => l.size === 'L').packages, 5);
  check('remainder off the newer M', after.find(l => l.size === 'M' && l.batch === 'M26').packages, 7);
  check('INVENTORY has a Size column', Object.keys(c.readTable_('INVENTORY')[0]).indexOf('Size') > -1, true);
}

console.log('\nphotographed labels');
{
  const c = buildContext();
  c.setup();
  c.addProduct_({ product: 'Ribeye Steak', content: '2 per pack', sizes: 'M, L' });
  c.addBatch_({ id: 'M26', packDate: '2026-06-29' });
  const tk = c.PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  const go = (a, p) => JSON.parse(c.handle_({ parameter: {} }, Object.assign({ action: a, token: tk }, p || {}))._text);
  const img = 'data:image/jpeg;base64,' + Buffer.from('fake-photo').toString('base64');

  const up = go('scan', { clientKey: 'scan-1', image: img, mime: 'image/jpeg',
    batch: 'M26', freezer: 'MAIN', user: 'Hannah', note: 'stack of ribeye labels' });
  check('photo accepted', up.ok, true);
  check('photo filed in Drive', up.url.indexOf('https://drive/') === 0, true);
  check('queued as pending', go('scans', { status: 'Pending' }).scans.length, 1);
  check('re-sent photo does not duplicate',
    (go('scan', { clientKey: 'scan-1', image: img }), go('scans').scans.length), 1);
  check('nothing in stock yet', c.currentStock_().length, 0);

  const filed = go('fileScan', { scanId: 'scan-1',
    read: 'RIBEYE L GOLD 1.72 lb — packed 2026-06-29',
    ops: [{ clientKey: 'fs-1', type: 'INTAKE', sku: 'RIBEYE-STEAK', size: 'L', grade: 'Gold',
            batch: 'M26', freezer: 'MAIN', packages: 1, weight: 1.72, party: 'Label scan' }]});
  check('scan filed', filed.status, 'Filed');
  check('stock appeared', c.currentStock_()[0].packages, 1);
  check('with the label weight', c.currentStock_()[0].weight, 1.72);
  check('nothing left pending', go('scans', { status: 'Pending' }).scans.length, 0);
  check('the row records what was read',
    c.readTable_('SCANS')[0]['What the label says'].indexOf('RIBEYE L GOLD') > -1, true);
  check('and what it became', c.readTable_('SCANS')[0]['Filed as'], 'RIBEYE-STEAK ×1');
  check('bootstrap tells the app the count', go('bootstrap').scansPending, 0);
}

console.log('\nweighing a lot after the fact');
{
  const c = buildContext();
  c.setup();
  c.addProduct_({ product: 'Ribeye Steak', content: '2 per pack', sizes: 'M, L' });
  c.addBatch_({ id: 'M26', packDate: '2026-06-29' });
  const tk = c.PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  const go = (a, p) => JSON.parse(c.handle_({ parameter: {} }, Object.assign({ action: a, token: tk }, p || {}))._text);

  go('submit', { ops: [{ clientKey: 'w1', type: 'INTAKE', sku: 'RIBEYE-STEAK', size: 'L',
    batch: 'M26', freezer: 'MAIN', packages: 8, weight: '' }]});
  check('counted with no weight', c.currentStock_()[0].weight, 0);
  check('sheet leaves the weight blank', (c.rebuildInventory(),
    c.readTable_('INVENTORY')[0]['Weight (lb)']), '');

  go('submit', { ops: [{ clientKey: 'w2', type: 'WEIGH', sku: 'RIBEYE-STEAK', size: 'L',
    batch: 'M26', freezer: 'MAIN', weight: 13.6, user: 'Hannah' }]});
  check('weight filled in later', c.currentStock_()[0].weight, 13.6);
  check('count untouched', c.currentStock_()[0].packages, 8);
  check('average per pack appears', (c.rebuildInventory(),
    c.readTable_('INVENTORY')[0]['Avg wt / pkg']), 1.7);

  go('submit', { ops: [{ clientKey: 'w3', type: 'WEIGH', sku: 'RIBEYE-STEAK', size: 'L',
    batch: 'M26', freezer: 'MAIN', weight: 1.9, perPackage: true }]});
  check('or entered per pack', c.currentStock_()[0].weight, 15.2);

  // selling from a weighed lot carries weight out at that lot's average
  go('submit', { ops: [{ clientKey: 'w4', type: 'SALE', sku: 'RIBEYE-STEAK', packages: 2, party: 'X' }]});
  check('sale took the average weight out', c.currentStock_()[0].weight, 11.4);
  check('ledger shows the weigh-in', c.readTable_('MOVEMENTS').filter(r => r['Type'] === 'WEIGH').length, 2);
}

console.log('\ncommitted vs available');
{
  const c = buildContext();
  c.setup();
  c.addProduct_({ product: 'Ribeye Steak', content: '2 x 12 oz', avgWeight: 1.6, price: 44, reorder: 4 });
  c.addBatch_({ id: 'B1', packDate: '2026-06-01' });
  const tk = c.PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  const go = (action, payload) => JSON.parse(c.handle_({ parameter: {} },
    Object.assign({ action, token: tk }, payload || {}))._text);

  go('submit', { ops: [{ clientKey: 'i1', type: 'INTAKE', sku: 'RIBEYE-STEAK', batch: 'B1', freezer: 'MAIN', packages: 20, weight: 32 }]});
  go('submit', { ops: [{ clientKey: 'n1', type: 'ORDER_NEW', orderId: 'O-1', customer: 'A', deliveryDate: '2026-10-01',
    lines: [{ sku: 'RIBEYE-STEAK', packages: 8 }] }]});
  go('submit', { ops: [{ clientKey: 'n2', type: 'ORDER_NEW', orderId: 'O-2', customer: 'B', deliveryDate: '2026-10-02',
    lines: [{ sku: 'RIBEYE-STEAK', packages: 6 }] }]});
  c.rebuildInventory();
  let row = c.readTable_('STOCK BY PRODUCT')[0];
  check('on hand unchanged by orders', row['Packages'], 20);
  check('both open orders are committed', row['Committed'], 14);
  check('available nets them out', row['Available'], 6);
  check('still OK above the reorder point', row['Status'], 'OK');

  go('submit', { ops: [{ clientKey: 'n3', type: 'ORDER_NEW', orderId: 'O-3', customer: 'C', deliveryDate: '2026-10-03',
    lines: [{ sku: 'RIBEYE-STEAK', packages: 3 }] }]});
  c.rebuildInventory();
  row = c.readTable_('STOCK BY PRODUCT')[0];
  check('third order eats into the buffer', row['Available'], 3);
  check('flagged LOW on available, not on hand', row['Status'], 'LOW');

  go('submit', { ops: [{ clientKey: 'n4', type: 'ORDER_NEW', orderId: 'O-4', customer: 'D', deliveryDate: '2026-10-04',
    lines: [{ sku: 'RIBEYE-STEAK', packages: 5 }] }]});
  c.rebuildInventory();
  row = c.readTable_('STOCK BY PRODUCT')[0];
  check('promising more than exists shows negative', row['Available'], -2);
  check('and reads OVERSOLD', row['Status'], 'OVERSOLD');

  go('submit', { ops: [{ clientKey: 'p9', type: 'ORDER_PACK', orderId: 'O-1' }]});
  c.rebuildInventory();
  row = c.readTable_('STOCK BY PRODUCT')[0];
  check('packing moves 8 from committed to gone', [row['Packages'], row['Committed']], [12, 14]);
  check('available unchanged by packing', row['Available'], -2);

  go('submit', { ops: [{ clientKey: 'x1', type: 'ORDER_STATUS', orderId: 'O-4', status: 'Cancelled' }]});
  c.rebuildInventory();
  row = c.readTable_('STOCK BY PRODUCT')[0];
  check('cancelling releases the commitment', [row['Committed'], row['Available']], [9, 3]);
  check('committed map reaches the app', go('bootstrap').committed['RIBEYE-STEAK'], 9);
}

console.log('\nageing, boxes, steers and the calculator');
{
  const c = buildContext();
  c.setup();
  const tk = c.PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  const go = (a, p) => JSON.parse(c.handle_({ parameter: {} }, Object.assign({ action: a, token: tk }, p || {}))._text);

  c.addProduct_({ product: 'Ribeye Steak', category: 'Steak', content: '1 per pack',
                  avgWeight: 0.71, pricePerLb: 63, marketPerLb: 57, reorder: 4 });
  c.addProduct_({ product: 'Tenderloin Steak', category: 'Steak', content: '1 per pack',
                  avgWeight: 0.39, pricePerLb: 85 });
  c.addProduct_({ product: 'Best of Both Worlds', category: 'Box', content: 'box',
                  price: 115, marketPrice: 104 });

  // the box recipe
  const bx = c.__ss.getSheetByName('BOX RECIPES');
  const BOX = 'BEST-OF-BOTH-WORLDS';
  bx.data.push([BOX,'Best of Both Worlds','RIBEYE-STEAK','Ribeye Steak',1,'']);
  bx.data.push([BOX,'Best of Both Worlds','TENDERLOIN-STEAK','Tenderloin Steak',1,'']);

  // a steer, with its costs
  go('addSteer', { steer: { id: 'S-01', tag: '812', killDate: '2026-01-05', packDate: '2026-01-12',
    hangingWeight: 700, purchaseCost: 3200, butcherCost: 1100, otherCost: 200 } });
  check('steer became a batch too', c.indexBatches_().some(b => b.id === 'S-01'), true);

  // stock, cut back in January — old by September
  go('submit', { ops: [
    { clientKey: 'a', type: 'INTAKE', sku: 'RIBEYE-STEAK', batch: 'S-01', freezer: 'MAIN',
      packages: 9, weight: 63.9, timestamp: '2026-01-12T12:00:00Z' },
    { clientKey: 'b', type: 'INTAKE', sku: 'TENDERLOIN-STEAK', batch: 'S-01', freezer: 'MAIN',
      packages: 5, weight: 19.5, timestamp: '2026-01-12T12:00:00Z' }
  ]});

  const aged = go('ageing').lots;
  check('old lots flagged', aged.length, 2);
  check('flagged urgent once past the urgent line', aged[0].level, 'urgent');
  check('with a suggestion', aged[0].suggestion.length > 10, true);
  check('and the days counted', aged[0].days > 250, true);

  const boxes = go('boxes').boxes;
  check('box buildability worked out', boxes[0].canBuild, 5);
  check('and names what runs out first', boxes[0].shortOf.indexOf('Tenderloin Steak') > -1, true);

  go('submit', { ops: [{ clientKey: 'bb', type: 'BUILD_BOX', boxSku: BOX,
    count: 3, freezer: 'MAIN', batch: 'S-01' }]});
  let st = {};
  c.currentStock_().forEach(l => st[l.sku] = l.packages);
  check('cuts came out', [st['RIBEYE-STEAK'], st['TENDERLOIN-STEAK']], [6, 2]);
  check('boxes went in', st[BOX], 3);

  go('submit', { ops: [{ clientKey: 'bk', type: 'BREAK_BOX', boxSku: BOX,
    count: 1, freezer: 'MAIN', batch: 'S-01' }]});
  st = {};
  c.currentStock_().forEach(l => st[l.sku] = l.packages);
  check('breaking one puts the cuts back', [st['RIBEYE-STEAK'], st[BOX]], [7, 2]);

  c.rebuildInventory();
  const steer = c.readTable_('STEER PERFORMANCE')[0];
  check('steer cost totalled', steer['Total cost'], 4500);
  check('yield worked out', steer['Yield %'] > 0, true);
  check('cost per saleable lb', steer['Cost / saleable lb'] > 0, true);

  // $63 is the price list, which IS the wholesale rate. A quote with no
  // channel named is a website quote: +30%, so $82/lb, then the piece rounded.
  const q = go('quote', { sku: 'RIBEYE-STEAK', weight: 1.1 });
  check('quoted on real weight', q.price, 91);
  check('and shows the working', q.basis, '1.10 lb × $82.00/lb');
  const qw = go('quote', { sku: 'RIBEYE-STEAK', weight: 1.1, channel: 'wholesale' });
  check('a wholesale quote is the list rate, to the cent', qw.price, 69.3);
  const qm = go('quote', { sku: 'RIBEYE-STEAK', weight: 1.1, channel: 'market' });
  check('market price is different', qm.price, 63);
  const qkg = go('quote', { sku: 'RIBEYE-STEAK', weight: 0.5, kg: true });
  check('kilograms accepted', qkg.price, 91);
  const boxSku = Object.keys(c.indexProducts_()).filter(k => k.indexOf('BEST-OF-BOTH') === 0)[0];
  const qb = go('quote', { sku: boxSku });
  check('a box quotes at its set price', qb.price, 115);
  check('the floor comes off the steer', q.cost > 0, true);
  check('and the margin with it', q.margin !== '', true);

  go('addToList', { list: 'waitlist', entry: { customer: 'R. Dyck', phone: '780-555-0199',
    wants: 'Tenderloin', size: 'L', packages: 4, notes: 'wants it before Christmas' } });
  go('addToList', { list: 'wholesale', entry: { customer: 'Bergen family', email: 'b@example.com',
    wants: 'Half', wantedBy: '2026-11-01', deposit: 500 } });
  const L = go('lists');
  check('cut waitlist saved', L.waitlist[0].customer, 'R. Dyck');
  check('with the comment that came with it', L.waitlist[0].notes, 'wants it before Christmas');
  check('and the row it sits on, so it can be opened and changed',
    L.waitlist[0].row, 2);
  check('wholesale list saved', L.wholesale[0].wants, 'Half');

  // Changing a cut waiting line, with the same row guard the wholesale tab has.
  const wlSaved = go('waitlistSave', { row: L.waitlist[0].row, customer: 'R. Dyck',
    fields: { phone: '780-555-0144', notes: 'rang her, still waiting' } });
  check('a waiting line can be changed',
    [wlSaved.waitlist[0].phone, wlSaved.waitlist[0].notes],
    ['780-555-0144', 'rang her, still waiting']);
  check('and what nobody touched is left alone',
    [wlSaved.waitlist[0].size, wlSaved.waitlist[0].packages], ['L', 4]);
  check('a waiting line cannot be left nameless',
    go('waitlistSave', { row: L.waitlist[0].row, customer: 'R. Dyck',
      fields: { customer: '' } }).ok, false);
  check('and a row that reads somebody else is refused',
    go('waitlistSave', { row: L.waitlist[0].row, customer: 'Somebody Else',
      fields: { notes: 'no' } }).ok, false);
  check('the refusal leaves the line as it was',
    go('lists').waitlist[0].notes, 'rang her, still waiting');

  go('submit', { ops: [{ clientKey: 'o', type: 'ORDER_NEW', orderId: 'ORD-9', customer: 'J. Wiebe',
    contact: 'jw@example.com', deliveryDate: '2026-10-02', lines: [{ sku: 'RIBEYE-STEAK', packages: 2 }] }]});
  c.rebuildInventory();
  const cust = go('lists').customers;
  check('customer filed from the order', cust[0].customer, 'J. Wiebe');
  check('with their email', cust[0].email, 'jw@example.com');
  check('and what they spent', cust[0].spend > 0, true);
}

console.log('\nreading the 2026 sales sheet');
{
  const c = buildContext();
  c.setup();
  const tk = c.PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  const go = (a, p) => JSON.parse(c.handle_({ parameter: {} }, Object.assign({ action: a, token: tk }, p || {}))._text);
  c.addProduct_({ product: 'Picanha', pricePerLb: 18.15 });
  c.addProduct_({ product: 'Ground Beef', content: '2 lb', pricePerLb: 13 });

  // A stand-in for the real workbook, shaped exactly like it.
  const FakeSheet = c.__ss.getSheetByName('PRODUCTS').constructor;
  const foreign = { _s: {}, getSheetByName(n) { return this._s[n] || null; } };
  const add = (name, rows) => { const sh = new FakeSheet(name); sh.data = rows; foreign._s[name] = sh; };

  add('Wholesale Waiting List', [
    ['Date booked','Customer Name','Email','Cell #','Deposit','Product, Weight and Price',
     'Order Status','Priority','Notes','Form of Contact'],
    ['2026-06-04',"Neil (Lana Gagnon's dad)",'','12502994886','','1/4 or 1/2 steer','Awaiting Animal','High','',''],
    ['2026-06-04','Melissa Griffin','','','','','Awaiting Animal','Low','For Summer 2027',''],
    ['2026-06-24','Jeff Cappis','kjcayd@gmail.com','250-329-7791','','1/2 steer','Awaiting Animal','Low',
     'Check with customer winter 2026','']
  ]);
  add('Product Waiting List', [
    ['Date booked','Customer Name','Email','Cell #','Deposit','Product, Weight and Price',
     'Order Status','Priority','Notes','Form of Contact'],
    ['2026-06-04',"Neil (Lana Gagnon's dad)",'','12502994886','','2x 20lb ground beef','In Progress','','',''],
    ['2026-06-04','Alvin (Filipino)','','17802287981','','Pichana','In Progress','','','in-person with Hannah'],
    ['2026-06-04','Renee Beaudoin','','','','Cowhide (low priority)','','','','']
  ]);
  add("Customers' info", [
    ['Customer List 2025-2026','','','','','','',''],
    ['Customer','Phone number','email address','address/location','Purchase history','# of order','Postcards received','Sales person'],
    ['Avery Gee','780-219-8155','averygeerogers@gmail.com','','Steak Lovers Box',1,'','Hannah'],
    ['Bert Guenette','7809830073','','','Gold Steak Pack, Steak Lovers Box',1,'','Paul'],
    ['Branden Jansons','','','','Silver Steak Box, Hot Dogs',2,'','Eli']
  ]);
  // Real rows, warts and all: a second column also called "Date", hand-typed
  // dates in four different shapes, and prices written as working notes.
  add('Whole Steer Sales', [
    ['Date',"Customer's name",'Email','Phone','Purchased part','Weight','Deposit',
     'Deposit invoice',
     'Price (Price per pound - deposit) (Whole $8/lb, Half $9/lb, Quarter $10/lb)',
     'Final invoice','Payment','Total owing to Dynastar','Paid','Date'],
    ['2/28/2026','Jean & Val Sylvain','jvalsylv@gmail.com','','Half','580lbs','','',
     '$7/lb x 580 lbs = S4060','PCW 041','','','FALSE',''],
    ['3/1/2026','Andrea Schneebeli','AndreaSchneebeli@gmail.com','','','339lbs ','','',
     '$7/lb x 339 lbs = $2373','PCW 038','','339 x $5.70/lb = $1932.30','FALSE',''],
    ['6/23/2026','Jeff Cappis','kjcayd@gmail.com','250-329-7791','Front Quarter','307 lbs',
     '$500','PCW 043','$7/lb x 307 lbs = $2149 - $500 = $1649','PCW 048','E-transfer','','FALSE',''],
    ['8/17/2026','Matthias and Marianne Haecki','haeckipower@gmail.com','','Whole','1336 lbs',
     '$5,344','PCW 051','$8/lb x 1336lbs = $10,688','','','','TRUE',''],
    ['','','','','','','','','','','','','FALSE','']
  ]);
  add('Sales', [
    ['Date of sale','Customer','Salesman','Type of cuts/order (weights)','Total price',
     'Payment','Payment type',' Comments'],
    ['Jan 9/26','Mathieu Bergeron','Website','Steak Lover Box 2.0','295 - Stripe fees = 286.14',
     'Paid','Stripe (website)','Entered QBO'],
    ['Mar 7/2026','Avery Gee','Hannah','1x dinner for two','$165.00','Paid','E-transfer','Entered QBO'],
    ['Mar 26/2026','Skyler Gibbs','Website','Steak Lover Box 2.0',
     '$265.50 - Stripe fees= $257.50','Paid','Stripe (website)','GIBBS10'],
    ['3/16/2026','Avery Gee','Hannah','6 lbs ground beef','$67.00','','','']
  ]);
  add('Promotions', [
    ['Date of sale','Customer','Salesman','Type of cuts/order (weights)','Total price',
     'Payment','Payment type',' Comments'],
    ['January 6/2026','Zacharias Naizghi','','Christmas Special','$289.00','','Promotion',
     'Christmas gift raffle'],
    ['January 23/26','Photoshoot','','2x gold ribeye, 1 gold Striploin','$256.00','','Other',
     'For the January photoshoot'],
    ['February 9/26','Paul Olivares','Paul','1x medium pep, hot dogs','$62.00','',
     'Quality control','']
  ]);
  c.__foreign['SALES-2026'] = foreign;

  check('it asks for the file ID first', go('importSales').error.indexOf('SALES_SHEET_ID') > -1, true);
  const st = c.__ss.getSheetByName('SETTINGS');
  st.data.forEach(r => { if (r && r[0] === 'SALES_SHEET_ID') r[1] = 'SALES-2026'; });

  const res = go('importSales');
  check('wholesale list read, whole-animal sales included', res.wholesale, 7);
  check('cut waiting list read', res.waitlist, 3);
  check('customers read', res.customers, 3);

  const L = go('lists');
  const waiting = L.wholesale.filter(r => r.status === 'Waiting');
  check('names came across', waiting.map(r => r.customer).sort()[0], 'Jeff Cappis');
  check('"Awaiting Animal" became Waiting', waiting.length, 3);
  check('priority kept', L.wholesale.filter(r => r.customer.indexOf('Neil') === 0)[0].priority, 'High');
  check('phone kept', L.wholesale.filter(r => r.customer === 'Jeff Cappis')[0].phone, '250-329-7791');
  check('notes folded together',
    L.wholesale.filter(r => r.customer === 'Melissa Griffin')[0].notes, 'For Summer 2027');

  check('a plainly named product is matched to its SKU',
    L.waitlist.filter(r => r.customer.indexOf('Neil') === 0)[0].wants, 'GROUND-BEEF');
  check('a misspelling is kept as written, not guessed',
    L.waitlist.filter(r => r.customer.indexOf('Alvin') === 0)[0].wants, 'Pichana');
  check('and so is something we do not sell as a product',
    L.waitlist.filter(r => r.customer === 'Renee Beaudoin')[0].wants, 'Cowhide (low priority)');

  check('customers carry their history', L.customers.length, 3);
  check('with what they bought before',
    L.customers.filter(x => x.customer === 'Branden Jansons')[0].bought, 'Silver Steak Box, Hot Dogs');
  check('and their order count from before the app',
    L.customers.filter(x => x.customer === 'Branden Jansons')[0].prior, 2);

  // Whole, half and quarter sales land on the wholesale list.
  const jean = L.wholesale.filter(r => r.customer === 'Jean & Val Sylvain')[0];
  check('an invoiced half steer reads as past', jean.status, 'Past');
  check('its rail weight came across', jean.weight, 580);
  check('the price is the number at the end of the sum', jean.price, 4060);
  check('the final invoice came across', jean.invoice, 'PCW 041');
  check('the date survives a second column also called Date', jean.added, '2026-02-28');

  const jeff2 = L.wholesale.filter(r => r.customer === 'Jeff Cappis' && r.invoice === 'PCW 048')[0];
  check('a past quarter sits beside the same name on the waiting list', !!jeff2, true);
  check('and the price is net of the deposit', jeff2.price, 1649);
  check('with the deposit taken', jeff2.deposit, 500);

  const haecki = L.wholesale.filter(r => r.customer.indexOf('Matthias') === 0)[0];
  check('a paid whole animal reads as past too', haecki.status, 'Past');
  check('a deposit written with a comma still parses', haecki.deposit, 5344);
  check('and so does a price', haecki.price, 10688);
  check('what Dynastar is owed is kept in the notes',
    L.wholesale.filter(r => r.customer === 'Andrea Schneebeli')[0].notes.indexOf('1932.30') > -1, true);

  check('the last number in a messy line is the amount',
    [c.parseAmount_('295 - Stripe fees = 286.14'), c.parseAmount_('$7/lb x 580 lbs = S4060'),
     c.parseAmount_('$8/lb x 1336lbs = $10,688'), c.parseAmount_(''), c.parseAmount_('cash')],
    [286.14, 4060, 10688, 0, 0]);
  check('hand-typed dates all come out the same way',
    ['Jan 9/26', 'January 6/2026', 'Mar 26/2026', '3/16/2026', 'February 9/26', 'gibberish']
      .map(d => c.looseDate_(d)),
    ['2026-01-09', '2026-01-06', '2026-03-26', '2026-03-16', '2026-02-09', 'gibberish']);

  const hist = c.readTable_(c.TABS.HISTORY);
  check('sales, promotions and whole animals are all on record', hist.length, 11);
  check('none of it is deducted from stock',
    hist.every(r => r['Counted in stock?'] === 'No — before the opening count'), true);
  check('the Stripe fee is taken off the sale',
    hist.filter(r => r['Customer'] === 'Mathieu Bergeron')[0]['Amount'], 286.14);
  check('and off a discounted one',
    hist.filter(r => r['Customer'] === 'Skyler Gibbs')[0]['Amount'], 257.5);
  check('a giveaway is a Promotion',
    hist.filter(r => r['Customer'] === 'Zacharias Naizghi')[0]['Kind'], 'Promotion');
  check('photoshoot meat is a promotion too, whatever the sheet calls it',
    hist.filter(r => r['Customer'] === 'Photoshoot')[0]['Kind'], 'Promotion');
  check('a taste test is quality control, not a sale',
    hist.filter(r => r['Customer'] === 'Paul Olivares')[0]['Kind'], 'Quality control');
  check('a whole-animal sale is on the record too',
    hist.filter(r => r['Kind'] === 'Whole animal').length, 4);
  check('a hand-typed date is readable on the record',
    hist.filter(r => r['Customer'] === 'Mathieu Bergeron')[0]['Date'], '2026-01-09');

  const gee = L.customers.filter(x => x.customer === 'Avery Gee')[0];
  check('prior spend adds up across their sales', gee.priorSpend, 232);
  check('and their last order is the newest of them', gee.last, '2026-03-16');
  check('promotions do not count as spend',
    L.customers.filter(x => x.customer === 'Photoshoot').length, 0);

  const again = go('importSales');
  check('running it twice adds nothing',
    [again.wholesale, again.waitlist, again.customers, again.history], [0, 0, 0, 0]);

  // App orders must not clobber the imported history.
  go('submit', { ops: [{ clientKey: 'q1', type: 'ORDER_NEW', orderId: 'O-1', customer: 'Avery Gee',
    contact: 'averygeerogers@gmail.com', deliveryDate: '2026-10-01',
    lines: [{ sku: 'PICANHA', packages: 2 }] }]});
  c.rebuildInventory();
  const avery = go('lists').customers.filter(x => x.customer === 'Avery Gee')[0];
  check('an app order counts separately', avery.orders, 1);
  check('the old count survives', avery.prior, 1);
  c.rebuildInventory();
  check('and a second rebuild does not double it',
    go('lists').customers.filter(x => x.customer === 'Avery Gee')[0].orders, 1);
}

console.log('\nwhat a rail should produce');
{
  const c = buildContext();
  c.setup();
  const tk = c.PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  const go = (a, p) => JSON.parse(c.handle_({ parameter: {} }, Object.assign({ action: a, token: tk }, p || {}))._text);

  // The model, held per 100 lb of rail (from the Drive yield workbook).
  const ym = c.__ss.getSheetByName('CUT YIELD MODEL');
  ym.data.push(['Ribeye Steak','RIBEYE-STEAK','Steak', 7.5, 7.5, 63, 'Gold', 'Yes', '']);
  ym.data.push(['Ground Beef','GROUND-BEEF','Ground', 24.6, 12.3, 13, 'All', 'Yes', '']);
  ym.data.push(['T-Bone','','Steak', 7.8, 6.5, 67, 'Gold', 'No', 'conflicts with the loin cuts']);

  const m = go('model', { railWeight: 660 }).model;
  check('model scales to the rail', m.lb, 211.9);
  check('and prices it', m.revenue, 5229.18);
  check('cuts marked Use? = No are left out', m.cuts.length, 2);
  check('half the rail, half the yield', go('model', { railWeight: 330 }).model.lb, 106);

  c.addProduct_({ product: 'Ribeye Steak', pricePerLb: 63, avgWeight: 0.71 });
  go('addSteer', { steer: { id: 'S-9', hangingWeight: 660, purchaseCost: 3000, butcherCost: 900 } });
  go('submit', { ops: [{ clientKey: 'y1', type: 'INTAKE', sku: 'RIBEYE-STEAK', batch: 'S-9',
    freezer: 'MAIN', packages: 40, weight: 28 }]});
  c.rebuildInventory();
  const s = c.readTable_('STEER PERFORMANCE').find(r => r['Steer ID'] === 'S-9');
  check('the steer row carries the model', s['Model revenue'], 5229.18);
  check('and what it should have weighed', s['Model saleable lb'], 211.9);
  check('with the gap against what actually came in', s['Variance vs model'] < 0, true);
}

console.log('\nbox ideas and automatic steer rows');
{
  const c = buildContext();
  c.setup();
  const tk = c.PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  const go = (a, p) => JSON.parse(c.handle_({ parameter: {} }, Object.assign({ action: a, token: tk }, p || {}))._text);

  c.addProduct_({ product: 'Italian Sausage', category: 'Sausage & deli', price: 16, reorder: 6 });
  c.addProduct_({ product: 'Minute Steaks', category: 'Steak', price: 22, reorder: 4 });
  c.addProduct_({ product: 'Sirloin Steak', category: 'Steak', price: 31, reorder: 6 });
  c.addProduct_({ product: 'Ribeye Steak', category: 'Steak', price: 45, reorder: 4 });
  c.addBatch_({ id: 'OLD', packDate: '2025-06-01' });
  c.addBatch_({ id: 'M26', packDate: '2026-08-20' });

  go('submit', { ops: [
    { clientKey: 's1', type: 'INTAKE', sku: 'ITALIAN-SAUSAGE', batch: 'OLD', freezer: 'MAIN',
      packages: 26, timestamp: '2025-06-05T12:00:00Z' },
    { clientKey: 's2', type: 'INTAKE', sku: 'MINUTE-STEAKS', batch: 'OLD', freezer: 'MAIN',
      packages: 7, timestamp: '2025-06-05T12:00:00Z' },
    { clientKey: 's3', type: 'INTAKE', sku: 'SIRLOIN-STEAK', batch: 'M26', freezer: 'MAIN',
      packages: 12, timestamp: '2026-08-25T12:00:00Z' },
    { clientKey: 's4', type: 'INTAKE', sku: 'RIBEYE-STEAK', batch: 'M26', freezer: 'MAIN',
      packages: 9, timestamp: '2026-08-25T12:00:00Z' }
  ]});

  const ideas = go('boxIdeas').ideas;
  check('ideas came back for each price point', ideas.length > 0, true);
  check('prices end in 5 or 9', ideas.every(b => [5, 9].indexOf(b.price % 10) > -1), true);
  check('every idea has items', ideas.every(b => b.items.length > 0), true);
  check('the oldest stock leads', ideas[0].items[0].product, 'Italian Sausage');
  check('it says what the box clears out', ideas[0].clears.indexOf('Italian Sausage') > -1, true);
  check('it never boxes more than there is',
    ideas.every(b => b.items.every(i => i.qty <= 26)), true);
  check('a box lands near its target',
    ideas.every(b => b.raw >= b.target * 0.8 && b.raw <= b.target * 1.08), true);
  check('each idea explains itself', ideas.every(b => b.reason.length > 40), true);
  check('the reason names the money at risk', ideas[0].reason.indexOf('freezer burn') > -1, true);

  // Taking an idea turns it into a box that can be built like any other.
  const pick = ideas[0];
  const saved = go('saveBoxIdea', { name: 'Freezer Clear-Out Box', price: pick.price,
    marketPrice: pick.price - 10, why: pick.reason, items: pick.items });
  check('idea became a product', saved.ok, true);
  check('and a recipe that can be built',
    saved.boxes.filter(b => b.sku === saved.sku)[0].canBuild > 0, true);
  check('priced as proposed', c.indexProducts_()[saved.sku].price, pick.price);
  check('building it consumes the real cuts',
    (go('submit', { ops: [{ clientKey: 'bx1', type: 'BUILD_BOX', boxSku: saved.sku, count: 1,
       freezer: 'MAIN' }]}),
     c.currentStock_().filter(l => l.sku === saved.sku)[0].packages), 1);


  // Nothing was entered on the steer sheet, yet the batches show up there.
  c.rebuildInventory();
  const steers = c.readTable_('STEER PERFORMANCE').map(r => r['Steer ID']).sort();
  check('batches became steer rows by themselves', steers, ['M26', 'OLD']);
  check('with the packages already counted',
    c.readTable_('STEER PERFORMANCE').find(r => r['Steer ID'] === 'M26')['Packages cut'], 21);
  check('and no duplicate row on a second rebuild',
    (c.rebuildInventory(), c.readTable_('STEER PERFORMANCE').length), 2);

  // Filling in the animal's own numbers is the only typing left.
  const sh = c.__ss.getSheetByName('STEER PERFORMANCE');
  const head = sh.data[0];
  const row = sh.data.find(r => r && r[0] === 'M26');
  row[head.indexOf('Hanging weight (lb)')] = 620;
  row[head.indexOf('Purchase cost')] = 3000;
  row[head.indexOf('Butcher cost')] = 950;
  c.rebuildInventory();
  const m26 = c.readTable_('STEER PERFORMANCE').find(r => r['Steer ID'] === 'M26');
  check('yield needs no second entry', m26['Packages cut'], 21);
  check('and the cost follows', m26['Total cost'], 3950);
}

console.log('\nwebsite order emails');
{
  const c = buildContext();
  c.setup();
  c.addProduct_({ product: 'Dinner for Two', category: 'Box', content: 'box', price: 119 });
  c.addProduct_({ product: 'Ribeye Steak', category: 'Steak', pricePerLb: 63, avgWeight: 0.71 });

  const body = [
    'A new order has been placed on Peace Country Wagyu.',
    '', 'Order #10453', '',
    'Ship to', 'Janice Wiebe', '123 Range Road', 'Peace River, AB',
    '', 'jwiebe@example.com', '',
    '2 x Dinner for Two   $238.00',
    '1 x Ribeye Steak   $44.73',
    '', 'Delivery', 'Total $282.73'
  ].join('\n');

  const p = c.parseOrderEmail_(body, 'New order #10453 — Peace Country Wagyu');
  check('order number read', p.orderId, 'WEB-10453');
  check('customer read', p.customer, 'Janice Wiebe');
  check('email read', p.email, 'jwiebe@example.com');
  check('items matched to products', p.lines.map(l => l.sku + '×' + l.packages),
    ['DINNER-FOR-TWO×2', 'RIBEYE-STEAK×1']);
  check('delivery not pickup', p.method, 'Delivery');

  const pickup = c.parseOrderEmail_(body.replace('Delivery', 'Local pickup'), 'order #10454');
  check('pickup spotted', pickup.method, 'Pickup');

  const odd = c.parseOrderEmail_('Order #10455\n3 x Mystery Sampler  $99\nbuyer@example.com', 'x');
  check('an unknown item is flagged, not dropped', odd.notes.indexOf('COULD NOT MATCH') > -1, true);
  check('no items invented', odd.lines.length, 0);

  check('a non-order email is ignored', c.parseOrderEmail_('Hello, just checking in.', 'Hi'), null);
}

console.log('\nsheet views');
ctx.rebuildInventory();
const inv = ctx.readTable_('INVENTORY');
const sum = ctx.readTable_('STOCK BY PRODUCT');
check('INVENTORY has a row per line', inv.length > 0, true);
check('summary ties to the ledger',
  Math.round(sum.reduce((s, r) => s + Number(r['Packages'] || 0), 0) * 100) / 100,
  Math.round(ctx.currentStock_().reduce((s, l) => s + l.packages, 0) * 100) / 100);
check('low/out flagged', sum.some(r => ['LOW','OUT','OVERSOLD'].indexOf(r['Status']) > -1), true);

console.log('\nbootstrap payload');
const boot = call('bootstrap');
check('products returned', boot.products.length, 4);
check('batches returned', boot.batches.length, 2);
check('freezers returned', boot.freezers.length, 3);
check('stock returned', boot.stock.length > 0, true);
check('history returns rows', call('history', { limit: 5 }).moves.length, 5);
check('orders returned to the app', boot.orders.length, 2);
check('open orders carry their lines', boot.orders.every(o => o.items.length > 0), true);


console.log('\nreorder follow-ups');
{
  const c = buildContext();
  c.setup();
  const tk = c.PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  const go = (a, p) => JSON.parse(c.handle_({ parameter: {} }, Object.assign({ action: a, token: tk }, p || {}))._text);
  const today = c.today_();
  const back = m => {
    const d = new Date(today + 'T12:00:00');
    d.setMonth(d.getMonth() - m);
    return d.toISOString().slice(0, 10);
  };
  const backDays = n => new Date(new Date(today + 'T12:00:00') - n * 86400000)
    .toISOString().slice(0, 10);

  const wh = c.__ss.getSheetByName('WHOLESALE');
  const row = (name, email, wants, weight, added, status) =>
    wh.data.push([name, '', email, wants, status || 'Done', 'Normal', '', 0, weight, 0, '', 'Yes', added, '']);
  row('Gilles Gagnon', 'gil44val@gmail.com', 'Half', 593.2, back(9));        // long overdue
  row('Carmen Labrecque', 'dclabr@hotmail.com', 'Hind Quarter', 254, backDays(97)); // due now
  row('Keith Anderson', 'anderka47@gmail.com', 'Front Quarter', 351, back(1)); // not yet
  row('Andrea Schneebeli', 'a@example.com', '', 339, back(7));               // share guessed
  row('Page Rey', '', '1/4 or 1/2 steer?', 0, back(2), 'Waiting');           // no animal yet

  c.rebuildInventory();
  const byName = () => {
    const o = {};
    go('followups').followups.forEach(f => { o[f.customer] = f; });
    return o;
  };
  let f = byName();

  check('a half nine months back is overdue', f['Gilles Gagnon'].status, 'Overdue');
  check('a quarter just past three months is due now', f['Carmen Labrecque'].status, 'Due now');
  check('a month-old quarter is still upcoming', f['Keith Anderson'].status, 'Upcoming');
  check('the due date is the purchase plus the clock',
    f['Gilles Gagnon'].due, c.addMonths_(back(9), 6));
  check('a blank share is read off the rail weight', f['Andrea Schneebeli'].share, 'Quarter');
  check('and says so rather than stating it as fact',
    f['Andrea Schneebeli'].flags.indexOf('guessed') > -1, true);
  check('somebody still waiting is not chased for a reorder', !f['Page Rey'], true);
  check('the longest overdue leads the list',
    go('followups').followups[0].customer, 'Andrea Schneebeli');
  check('and nobody upcoming sits above somebody overdue',
    go('followups').followups.map(x => x.status).indexOf('Upcoming') >
    go('followups').followups.map(x => x.status).lastIndexOf('Overdue'), true);

  check('month arithmetic does not roll off the end of a short month',
    c.addMonths_('2026-01-31', 1), '2026-02-28');

  // The draft has to sound like it came from somebody who knows them.
  c.__ss.getSheetByName('SALES HISTORY').data.push(
    [back(9), 'Gilles Gagnon', 'Hannah', 'Gold Steak Pack', 480, 'Sale', 'E-transfer',
     'No — before the opening count', '']);
  const d = go('draft', { customer: 'Gilles Gagnon' });
  check('it is addressed to them', d.to, 'gil44val@gmail.com');
  check('by first name', d.body.indexOf('Hi Gilles') === 0, true);
  check('it knows what they took', d.body.indexOf('a half') > -1, true);
  check('and roughly when', d.body.indexOf('9 months ago') > -1, true);
  check('it names what they bought before', d.body.indexOf('Gold Steak Pack') > -1, true);
  check('the subject fits the share', d.subject, 'Time for another half?');
  check('house style: no dashes used as punctuation',
    /—|–/.test(d.body + d.subject), false);
  check('and it says who wrote it', d.writtenBy, 'Composed by the app');

  check('somebody waiting on a cut gets that folded in', (() => {
    c.addToList_({ list: 'waitlist', entry: { customer: 'Carmen Labrecque', wants: 'Cowhide',
      words: 'Cowhide (low priority)' } });
    return go('draft', { customer: 'Carmen Labrecque' }).body.indexOf('Cowhide') > -1;
  })(), true);

  check('no address means no send',
    go('sendFollowup', { customer: 'Page Rey', to: '', subject: 'x', body: 'y' }).ok, false);
  check('and neither does an empty draft',
    go('sendFollowup', { customer: 'Gilles Gagnon', to: d.to, subject: 'x', body: '' }).ok, false);

  // Nobody has set sales@ up as a send-as alias yet.
  const sent = go('sendFollowup', { clientKey: 'fu1', customer: 'Gilles Gagnon', to: d.to,
    subject: d.subject, body: d.body, user: 'Hannah' });
  check('sending goes out once', [sent.ok, c.__sent.length], [true, 1]);
  check('through the company mail, signed as the business',
    c.__sent[0].opts.name, 'Peace Country Wagyu');
  check('replies point at the sales inbox even so',
    c.__sent[0].opts.replyTo, 'sales@pcwagyu.com');
  check('but it does not claim to send from an address it cannot',
    c.__sent[0].opts.from, undefined);
  check('and says plainly why', sent.warning.indexOf('Send mail as') > -1, true);

  check('a replayed send does not go twice', (() => {
    const again = go('sendFollowup', { clientKey: 'fu1', customer: 'Gilles Gagnon', to: d.to,
      subject: d.subject, body: d.body });
    return [again.already, c.__sent.length];
  })(), [true, 1]);
  // Once the alias exists it is used, and the warning goes away.
  c.__aliases = ['sales@pcwagyu.com'];
  const sent2 = go('sendFollowup', { clientKey: 'fu-alias', customer: 'Andrea Schneebeli',
    to: 'a@example.com', subject: 'x', body: 'y' });
  check('it sends as sales@ once that is set up',
    [c.__sent[1].opts.from, c.__sent[1].opts.replyTo],
    ['sales@pcwagyu.com', 'sales@pcwagyu.com']);
  check('with nothing to warn about', [sent2.warning, sent2.from],
    ['', 'sales@pcwagyu.com']);
  check('the app can ask before anyone taps send', go('sendAs').usable, true);
  c.__aliases = [];
  f = byName();
  check('and the row records who did it', [f['Gilles Gagnon'].status,
    f['Gilles Gagnon'].contactedBy], ['Done', 'Hannah']);
  c.rebuildInventory();
  check('a rebuild does not put them back on the list', byName()['Gilles Gagnon'].status, 'Done');

  go('markFollowup', { customer: 'Carmen Labrecque', what: 'snooze', days: 60,
    note: 'Asked for the new year' });
  f = byName();
  check('not now holds them off', f['Carmen Labrecque'].status, 'Held');
  check('with the reason kept', f['Carmen Labrecque'].notes.indexOf('new year') > -1, true);
  c.rebuildInventory();
  check('and the hold survives a rebuild', byName()['Carmen Labrecque'].status, 'Held');

  // The radar's judgement lands on top of the arithmetic.
  c.__drive['pcw-followups.json'] = JSON.stringify({
    generated: '2026-10-05',
    people: [
      { customer: 'Keith Anderson', boughtOn: back(1), subject: 'Your next quarter',
        body: 'Hi Keith,\n\nHope the front quarter is treating you well.\n\nPaul',
        flags: 'two addresses on file' },
      { customer: 'Jeff Cappis', boughtOn: '2026-06-23', status: 'Held',
        holdUntil: '2027-01-15', flags: 'asked to be checked with in winter 2026',
        subject: 'Winter check in', body: 'Hi Jeff,\n\nAs promised.\n\nPaul' }
    ]
  });
  const pulled = go('pullRadar');
  check('the radar file is picked up', [pulled.applied, pulled.added], [1, 1]);
  f = byName();
  check('its draft lands on the right person',
    f['Keith Anderson'].draft.indexOf('front quarter') > -1, true);
  check('credited to the radar', f['Keith Anderson'].writtenBy, 'The weekly radar');
  check('its flags come across', f['Keith Anderson'].flags, 'two addresses on file');
  check('the app serves the radar draft rather than writing its own',
    go('draft', { customer: 'Keith Anderson' }).writtenBy, 'The weekly radar');
  check('but you can ask for a fresh one',
    go('draft', { customer: 'Keith Anderson', rewrite: true }).writtenBy, 'Composed by the app');
  check('somebody the arithmetic never saw is kept anyway', !!f['Jeff Cappis'], true);
  check('and their own timing beats the clock', f['Jeff Cappis'].status, 'Held');
  check('the file is moved aside so next rebuild does not reapply it',
    go('pullRadar').applied, 0);
  c.rebuildInventory();
  check('the radar draft survives the rebuild',
    byName()['Keith Anderson'].draft.indexOf('front quarter') > -1, true);
}

console.log('\nthe wholesale screen: ordered, waiting, past');
{
  const c = buildContext();
  c.setup();
  const tk = c.PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  const go = (a, p) => JSON.parse(c.handle_({ parameter: {} }, Object.assign({ action: a, token: tk }, p || {}))._text);
  const wh = c.__ss.getSheetByName('WHOLESALE');
  // Customer, Phone, Email, Wants, Status, Priority, Wanted by, Deposit,
  // Weight (lb), Price, Invoice, Paid, Added, Notes
  const row = r => wh.data.push([r.name, r.phone || '', r.email || '', r.wants || '',
    r.status || 'Waiting', r.priority || 'Normal', r.wantedBy || '', r.deposit || 0,
    r.weight || '', r.price || '', r.invoice || '', r.paid || '', r.added || '', r.notes || '']);
  const setSetting = (k, v) => {
    const sh = c.__ss.getSheetByName('SETTINGS');
    const head = sh.data[0].map(String);
    const ki = head.indexOf('Key'), vi = head.indexOf('Value');
    for (let i = 1; i < sh.data.length; i++) {
      if (sh.data[i] && String(sh.data[i][ki]) === k) { sh.data[i][vi] = v; return; }
    }
  };
  const byName = () => {
    const o = {};
    go('lists').wholesale.forEach(r => { o[r.customer] = r; });
    return o;
  };

  row({ name: 'Dale Friesen', phone: '780-555-0141', wants: 'Half', priority: 'High',
        wantedBy: '2027-02-01', deposit: 500, status: 'Ordered', added: '2026-11-02' });
  row({ name: 'Renee Toews', phone: '780-555-0199', wants: 'Quarter', priority: 'Normal',
        status: 'Ordered', added: '2026-11-09' });
  row({ name: 'Ivan Wiebe', wants: 'Whole', priority: 'High', added: '2026-10-20',
        notes: 'asked at the market' });
  row({ name: 'Sarah Penner', wants: 'Quarter', priority: 'Low', added: '2026-09-14' });
  row({ name: 'Glen Hiebert', wants: 'Quarter', weight: 232, price: 2088,
        invoice: 'PCW 061', added: '2026-01-10' });            // freezer low by April
  row({ name: 'Marie Doerksen', wants: 'Half', weight: 561, price: 4488,
        invoice: 'PCW 058', added: '2026-06-15' });            // not low until December

  let w = byName();
  check('ordered, waiting and past are told apart',
    ['Dale Friesen', 'Ivan Wiebe', 'Glen Hiebert'].map(n => w[n].stage),
    ['ordered', 'waiting', 'past']);
  check('an ordered line is not treated as having had its animal',
    [w['Renee Toews'].stage, !!w['Renee Toews'].due], ['ordered', false]);
  check('what they want, when they asked and how keen all survive',
    [w['Ivan Wiebe'].wants, w['Ivan Wiebe'].added, w['Ivan Wiebe'].priority],
    ['Whole', '2026-10-20', 'High']);
  check('the deposit comes through on an ordered line', w['Dale Friesen'].deposit, 500);

  check('a past line carries its share size', w['Glen Hiebert'].share, 'Quarter');
  check('and when the freezer should be getting low', w['Glen Hiebert'].due, '2026-04-10');
  check('which is already past, so they are worth a call', w['Glen Hiebert'].dueNow, true);
  check('a half bought in June is not due yet',
    [w['Marie Doerksen'].due, w['Marie Doerksen'].dueNow], ['2026-12-15', false]);

  setSetting('HALF_MONTHS', '4');
  check('moving HALF_MONTHS on the SETTINGS tab moves everybody at once',
    [byName()['Marie Doerksen'].due, byName()['Marie Doerksen'].dueNow], ['2026-10-15', true]);
  setSetting('HALF_MONTHS', '6');

  // ---- the row a line sits on, and the guard on writing to it ----
  const dale = byName()['Dale Friesen'];
  check('a line knows which row it is on', dale.row, 2);
  wh.data.push(['', '', '', '', '', '', '', '', '', '', '', '', '', '']);
  row({ name: 'Lorne Zacharias', wants: 'Quarter', added: '2026-11-14' });
  check('a blank row does not make the row numbers lie',
    byName()['Lorne Zacharias'].row, 9);

  check('writing to a row that now reads somebody else is refused',
    go('wholesaleMove', { row: dale.row, customer: 'Renee Toews', to: 'out' }).ok, false);
  check('and says so in words Paul can act on',
    go('wholesaleMove', { row: dale.row, customer: 'Renee Toews', to: 'out' })
      .error.indexOf('Dale Friesen') > -1, true);
  check('nothing was written to the wrong person',
    byName()['Dale Friesen'].stage, 'ordered');
  check('a row that has gone from the tab is refused too',
    go('wholesaleMove', { row: 400, customer: 'Dale Friesen', to: 'out' }).ok, false);

  // ---- moving a line along ----
  go('wholesaleMove', { row: byName()['Ivan Wiebe'].row, customer: 'Ivan Wiebe',
                        to: 'ordered', wantedBy: '2027-05-01', deposit: 250 });
  w = byName();
  check('the waiting list to ordered', w['Ivan Wiebe'].stage, 'ordered');
  check('with the date they want it by and the deposit',
    [w['Ivan Wiebe'].wantedBy, w['Ivan Wiebe'].deposit], ['2027-05-01', 250]);

  go('wholesaleMove', { row: w['Ivan Wiebe'].row, customer: 'Ivan Wiebe', to: 'waiting' });
  check('and back to the waiting list', byName()['Ivan Wiebe'].stage, 'waiting');
  check('the deposit is left alone on the way back', byName()['Ivan Wiebe'].deposit, 250);

  go('wholesaleMove', { row: byName()['Renee Toews'].row, customer: 'Renee Toews',
                        to: 'out', weight: 228, price: 2052, invoice: 'PCW 067' });
  w = byName();
  check('ordered to gone out', w['Renee Toews'].stage, 'past');
  check('taking the hanging weight and invoice with it',
    [w['Renee Toews'].weight, w['Renee Toews'].invoice], [228, 'PCW 067']);
  check('and the reorder clock starts from there', !!w['Renee Toews'].due, true);

  check('an invoiced line will not go back to the waiting list',
    go('wholesaleMove', { row: w['Renee Toews'].row, customer: 'Renee Toews', to: 'waiting' }).ok,
    false);
  check('it stays where the money says it is', byName()['Renee Toews'].stage, 'past');
  check('a move with no destination is refused',
    go('wholesaleMove', { row: byName()['Sarah Penner'].row, customer: 'Sarah Penner',
                          to: 'somewhere' }).ok, false);

  // ---- editing the details ----
  go('wholesaleSave', { row: byName()['Sarah Penner'].row, customer: 'Sarah Penner',
    fields: { phone: '780-555-0177', priority: 'High', wants: 'Half',
              notes: 'wants it before Christmas' } });
  w = byName();
  check('the details can be changed',
    [w['Sarah Penner'].phone, w['Sarah Penner'].priority, w['Sarah Penner'].wants],
    ['780-555-0177', 'High', 'Half']);
  check('and a field nobody touched is left alone', w['Sarah Penner'].added, '2026-09-14');
  check('a line cannot be left nameless',
    go('wholesaleSave', { row: w['Sarah Penner'].row, customer: 'Sarah Penner',
                          fields: { customer: '' } }).ok, false);
  go('wholesaleSave', { row: w['Sarah Penner'].row, customer: 'Sarah Penner',
                        fields: { customer: 'Sarah Penner-Klassen' } });
  check('a name can be corrected', !!byName()['Sarah Penner-Klassen'], true);

  // ---- they want another one ----
  const glen = byName()['Glen Hiebert'];
  go('wholesaleAgain', { row: glen.row, customer: 'Glen Hiebert', wants: 'Half',
                         priority: 'High' });
  const glens = go('lists').wholesale.filter(r => r.customer === 'Glen Hiebert');
  check('a past customer who wants another gets a second line', glens.length, 2);
  check('the old one keeps its invoice',
    glens.filter(r => r.stage === 'past')[0].invoice, 'PCW 061');
  check('the new one starts on the waiting list, asked today',
    glens.filter(r => r.stage === 'waiting').map(r => [r.wants, r.added, r.priority])[0],
    ['Half', c.today_(), 'High']);
  check('and says what they had last time',
    glens.filter(r => r.stage === 'waiting')[0].notes.indexOf('had Quarter') > -1, true);

  // ---- the follow-up radar must not chase somebody who has no animal ----
  c.rebuildInventory();
  const fu = {};
  go('followups').followups.forEach(f => { fu[f.customer] = f; });
  check('a past customer is chased', !!fu['Marie Doerksen'], true);
  check('somebody ordered and still waiting on a steer is not',
    !!fu['Dale Friesen'], false);
  check('nor is anybody merely on the waiting list', !!fu['Ivan Wiebe'], false);
}

/* ---- what came off the steer ----
   "63% yield" does not say whether the ribeyes came up short, and there is
   no published table for a Wagyu steer cut to our own order, so the only
   yardstick is our own past animals. */
{
  const c = buildContext();
  c.setup();
  // A movement is only accepted against a product that exists.
  c.addProduct_({ product: 'Ribeye', content: '2 steaks', avgWeight: 2, price: 44 });
  c.addProduct_({ product: 'Ground', content: '1 lb', avgWeight: 1.5, price: 14 });
  c.addProduct_({ product: 'Brisket', content: 'whole', avgWeight: 4, price: 60 });
  let bk = 0;
  const book = (batch, sku, packs, weight) => c.submit_({ ops: [{
    clientKey: 'y' + (++bk),
    type: 'INTAKE', sku: sku, product: sku, batch: batch, freezer: 'MAIN',
    packages: packs, weight: weight, party: 'From the butcher' }] });

  // Three steers that broke down much the same way.
  [['S1', 100], ['S2', 100], ['S3', 100]].forEach(([b]) => {
    book(b, 'RIBEYE', 10, 20);
    book(b, 'GROUND', 40, 60);
    book(b, 'BRISKET', 5, 20);
  });
  // The fourth is light on ribeye and heavy on ground.
  book('S4', 'RIBEYE', 5, 8);
  book('S4', 'GROUND', 50, 72);
  book('S4', 'BRISKET', 5, 20);

  c.addSteer_({ steer: { id: 'S4', hangingWeight: 200 } });
  ['S1', 'S2', 'S3'].forEach(id => c.addSteer_({ steer: { id: id, hangingWeight: 200 } }));

  const y = c.steerYield_({ batch: 'S4' });
  check('every cut comes back, heaviest first',
    y.cuts.map(x => x.sku), ['GROUND', 'BRISKET', 'RIBEYE']);
  check('with its packs, weight and what one weighs',
    [y.cuts[2].packages, y.cuts[2].weight, y.cuts[2].each], [5, 8, 1.6]);
  check('the yield is the meat against the hanging weight',
    [y.weight, y.hanging, y.yieldPct], [100, 200, 50]);
  check('and is set against what the steers before it did',
    [y.usualYield, y.comparedWith], [50, 3]);

  const by = {};
  y.cuts.forEach(x => { by[x.sku] = x; });
  check('a cut well under its usual share is flagged low',
    [by.RIBEYE.share, by.RIBEYE.usual, by.RIBEYE.off], [8, 20, 'low']);
  check('a cut well over it is flagged high',
    [by.GROUND.share, by.GROUND.usual, by.GROUND.off], [72, 60, 'high']);
  // Correcting a mistake is a different job from filling a blank, and the
  // app could only do the second: a hanging weight typed as 2000 was stuck.
  check('a steer can be read back as it stands',
    [c.steerGet_({ id: 'S4' }).hangingWeight, c.steerGet_({ id: 'S4' }).ok], [200, true]);
  check('and a wrong weight can be written over',
    c.steerSave_({ id: 'S4', fields: { hangingWeight: 250 } }).changed,
    ['Hanging weight (lb)']);
  check('which the yield is worked out from straight away',
    c.steerYield_({ batch: 'S4' }).hanging, 250);
  check('a field sent unchanged is not reported as a change',
    c.steerSave_({ id: 'S4', fields: { hangingWeight: 250 } }).changed, []);
  check('a value can be cleared back to empty',
    [c.steerSave_({ id: 'S4', fields: { liveWeight: '' } }).ok,
     c.steerGet_({ id: 'S4' }).liveWeight], [true, null]);
  check('a steer that is not there cannot be written to',
    [c.steerSave_({ id: 'NOPE', fields: { liveWeight: 1 } }).ok,
     c.steerGet_({ id: 'NOPE' }).ok], [false, false]);
  // Put it back for the checks below.
  c.steerSave_({ id: 'S4', fields: { hangingWeight: 200 } });

  check('completing a steer that stock created reports what it filled',
    c.addSteer_({ steer: { id: 'S4', hangingWeight: 999, butcher: 'Simard' } }).completed,
    ['Butcher']);
  check('and never writes over a weight that was already there',
    c.steerYield_({ batch: 'S4' }).hanging, 200);
  check('and one that came out normal is not flagged at all',
    [by.BRISKET.share, by.BRISKET.off], [20, '']);

  /* Only the ground beef weighed is the real state of a steer in the books,
     and it used to come out as ground beef being the whole animal. */
  {
    const h = buildContext();
    h.setup();
    h.addProduct_({ product: 'Ground', content: '1 lb', avgWeight: 1, price: 14 });
    h.addProduct_({ product: 'Denver', content: '1 steak', avgWeight: 1, price: 30 });
    h.submit_({ ops: [
      { clientKey: 'm1', type: 'INTAKE', sku: 'GROUND', product: 'Ground',
        batch: 'M26', freezer: 'MAIN', packages: 14, weight: 14 },
      { clientKey: 'm2', type: 'INTAKE', sku: 'DENVER', product: 'Denver',
        batch: 'M26', freezer: 'MAIN', packages: 19, weight: 0 }] });
    const m = h.steerYield_({ batch: 'M26' });
    const by = {};
    m.cuts.forEach(x => { by[x.sku] = x; });
    check('a cut nobody weighed has no share, rather than none of the animal',
      by.DENVER.share, null);
    check('the screen is told how much of the steer those shares cover',
      [m.weighedPackages, m.packages, m.sharesCover], [14, 33, 42.42]);
  }

  /* A steer butchered before the app, written up on paper. Booking it in as
     stock would put hundreds of pounds into the freezer that are not there,
     so its breakdown is recorded instead and the yield reads that. */
  {
    const j = buildContext();
    j.setup();
    j.addProduct_({ product: 'Ribeye', content: '1 steak', avgWeight: 1, price: 63 });
    j.addProduct_({ product: 'Ground', content: '1 lb', avgWeight: 1, price: 13 });
    const before = j.currentStock_().length;

    const saved = j.steerCutsSave_({ batch: 'JUNE-2026', source: 'June profit sheet',
      cuts: [{ sku: 'RIBEYE', weight: 21.1 }, { sku: 'GROUND', weight: 380.5 },
             { product: 'Fat / Tallow', weight: 259.1 },
             { product: 'Scraps', weight: 61.4 }] });
    check('the breakdown is recorded', saved.recorded, 4);
    check('and not one package enters the freezer',
      j.currentStock_().length, before);

    j.addSteer_({ steer: { id: 'JUNE-2026', liveWeight: 1290.8, hangingWeight: 775 } });
    const y2 = j.steerYield_({ batch: 'JUNE-2026' });
    check('tallow and scraps are kept out of the weight the yield is figured on',
      [y2.weight, y2.aside], [401.6, 320.5]);
    check('so the yield is of saleable meat, not of everything that came off',
      y2.yieldPct, 51.82);

    const by2 = {};
    y2.cuts.forEach(x => { by2[x.sku || x.product] = x; });
    check('they are still listed, with their weight and marked as outside it',
      [by2['Fat / Tallow'].weight, by2['Fat / Tallow'].counts,
       by2['Fat / Tallow'].share], [259.1, false, null]);
    check('and a real cut is a share of the saleable meat',
      by2.RIBEYE.share, 5.25);
    /* The ID gets typed by hand on the record, on the performance tab and on
       a batch; one of them in a different case is not a different steer. */
    /* A spreadsheet reads "JUNE-2026" as a date. Written plain it became
       Mon Jun 01 2026 and the steer stopped matching its own ID. */
    check('an ID a spreadsheet turned into a date still finds its steer',
      [j.sameSteer_(new Date(2026, 5, 1), 'JUNE-2026'),
       j.sameSteer_(new Date(2026, 5, 1), 'june-2026')], [true, true]);
    check('and is not mistaken for a different month or year',
      [j.sameSteer_(new Date(2026, 6, 1), 'JUNE-2026'),
       j.sameSteer_(new Date(2025, 5, 1), 'JUNE-2026')], [false, false]);

    check('the breakdown is found however the ID was capitalised',
      [j.steerYield_({ batch: 'june-2026' }).ok,
       j.steerYield_({ batch: 'June-2026' }).weight], [true, 401.6]);
    check('and the steer row is found the same way',
      j.steerGet_({ id: 'june-2026' }).liveWeight, 1290.8);
    check('so the same animal is never added twice under two spellings',
      j.addSteer_({ steer: { id: 'june-2026', butcher: 'Simard' } }).completed,
      ['Butcher']);

    check('the screen is told the figures came off a written record',
      y2.fromRecord, true);

    // Re-recording replaces, so a corrected sheet can just be sent again.
    j.steerCutsSave_({ batch: 'JUNE-2026',
      cuts: [{ sku: 'RIBEYE', weight: 30 }, { sku: 'GROUND', weight: 380.5 }] });
    check('a steer that arrives as text over the query string is read all the same',
      j.addSteer_({ steer: JSON.stringify({ id: 'TEXT-STEER', liveWeight: 900 }) }).ok, true);
    check('and its figures landed',
      j.steerGet_({ id: 'TEXT-STEER' }).liveWeight, 900);
    check('an edit sent as text works the same way',
      [j.steerSave_({ id: 'TEXT-STEER',
        fields: JSON.stringify({ hangingWeight: 500 }) }).ok,
       j.steerGet_({ id: 'TEXT-STEER' }).hangingWeight], [true, 500]);
    check('and text that will not parse is refused, not read as nothing given',
      [j.addSteer_({ steer: 'not json' }).ok,
       j.steerSave_({ id: 'TEXT-STEER', fields: 'not json' }).ok], [false, false]);

    check('a list that arrives as text over the query string is read all the same',
      j.steerCutsSave_({ batch: 'TEXT-1',
        cuts: JSON.stringify([{ sku: 'RIBEYE', weight: 4 }]) }).recorded, 1);
    check('and text that is not a list is refused rather than half-written',
      j.steerCutsSave_({ batch: 'TEXT-2', cuts: 'not json' }).ok, false);

    check('sending it again replaces what was there rather than doubling it',
      j.steerYield_({ batch: 'JUNE-2026' }).weight, 410.5);
  }

  // The very first steer has nothing to be measured against, and says so
  // rather than inventing a range for it.
  {
    const f = buildContext();
    f.setup();
    f.addProduct_({ product: 'Ribeye', content: '2 steaks', avgWeight: 2, price: 44 });
    f.submit_({ ops: [{ clientKey: 'f1', type: 'INTAKE', sku: 'RIBEYE', product: 'Ribeye',
      batch: 'FIRST', freezer: 'MAIN', packages: 10, weight: 20 }] });
    const lone = f.steerYield_({ batch: 'FIRST' });
    check('the first steer is compared with nothing and flags nothing',
      [lone.comparedWith, lone.cuts.every(x => x.off === ''), lone.cuts[0].usual],
      [0, true, null]);
  }

  check('a steer nothing has been booked against says so',
    c.steerYield_({ batch: 'S9' }).ok, false);
  check('and asking for no steer at all is refused',
    c.steerYield_({}).ok, false);

  // A missing hanging weight is the one number the yield cannot do without.
  c.addSteer_({ steer: { id: 'S5' } });
  book('S5', 'RIBEYE', 4, 9);
  const noHang = c.steerYield_({ batch: 'S5' });
  check('without a hanging weight the yield is blank and says why',
    [noHang.yieldPct, noHang.needsHanging], [null, true]);
}

/* ---- telling one customer from another ----
   Real pairs out of the books. The first two are one person spelled two
   ways; the third is two different people whose surnames are a letter
   apart, and merging them would move a phone number onto the wrong woman. */
{
  const c = buildContext();
  const like = (a, b) => c.nameLikeness_(a, b);

  check('a swapped pair of letters is the same person',
    like('Reene Beaudoin', 'Renee Beaudoin'), 'same');
  check('and so is a single wrong letter',
    like('Charlene Pizychi', 'Charlene Pizycki'), 'same');
  check('case and punctuation are not a difference at all',
    [like('kelly whalen (b&b)', 'Kelly Whalen'), like('Simard Butcher Co. Ltd.', 'simard butcher')],
    ['same', 'same']);

  // Six edits apart once the first names are counted, which is what keeps
  // Carmen's phone number off Maggie's record.
  check('two different people are never the same, however close the surname',
    like('Maggie Labreque', 'Carmen Labrecque'), '');
  check('two letters out is asked about, not merged',
    like('Bert Guenette', 'Bert Gunuette'), 'maybe');
  check('a name sitting inside a longer one is asked about',
    like('Val Sylvain', 'Jean and Val Sylvain'), 'maybe');

  check('sharing only a surname is not a match',
    [like('Dixie Hodgson', 'Jacob Hodgson'), like('Eli Hodgson', 'Duey Hodgson')], ['', '']);
  check('nor is a shared first name',
    like('Melissa Labreque', 'Melissa Anctil'), '');
  check('and an empty name matches nothing', like('', 'Reene Beaudoin'), '');

  /* One edit is most of a short name and almost none of a long one. These
     two are both in the books and are not the same person. */
  check('a short name has to match outright',
    [like('Joe (Jamie Cloutier)', 'Opey'), like('Opey', 'Opel')], ['', '']);
  check('the real one-letter pairs in the books still come through',
    [like('Andrea Schneebeli', 'Andrea Schneebli'), like('Page Rey', 'Paige Rey')],
    ['same', 'same']);
}

/* ---- a phone on a wholesale line reaches the customer card ----
   Reene Beaudoin's email was on a wholesale line, her waiting line was
   blank, the customer book had never heard of her, and the card showed
   nothing because it only ever read two of the four tabs. */
{
  const c = buildContext();
  c.setup();
  c.addToList_({ list: 'wholesale', entry: { customer: 'Reene Beaudoin',
    email: 'reenebeaudoin@gmail.com', phone: '780-837-1377', wants: 'Quarter' } });
  c.addToList_({ list: 'waitlist', entry: { customer: 'Renee Beaudoin',
    wants: 'Cowhide', words: 'Cowhide (low priority)' } });

  const card = c.customerWhere_('Renee Beaudoin');
  check('the card finds what the other spelling knows',
    [card.known.email.map(v => v.value), card.known.phone.map(v => v.value)],
    [['reenebeaudoin@gmail.com'], ['780-837-1377']]);
  check('and says which line it came off',
    card.known.email[0].where, ['wholesale line']);
  check('and reports the other spelling it had to go through',
    card.alsoSpelled, ['Reene Beaudoin']);

  // Somebody genuinely different on a line nearby is only ever a question.
  c.addToList_({ list: 'waitlist', entry: { customer: 'Carmen Labrecque',
    phone: '780-837-1771', wants: 'Ground beef' } });
  const other = c.customerWhere_('Maggie Labreque');
  check('and a different woman with a near-identical surname is left alone',
    [other.maybe, other.known.phone.length, other.alsoSpelled], [[], 0, []]);

  // One worth asking about is shown as a question and nothing more.
  c.addToList_({ list: 'waitlist', entry: { customer: 'Bert Gunuette',
    phone: '780-983-0073', wants: 'Ground beef' } });
  const bert = c.customerWhere_('Bert Guenette');
  check('a two-letter difference is raised as a question, not used',
    [bert.maybe, bert.known.phone.length], [['Bert Gunuette'], 0]);
}

/* ---- an address is not a list of towns ----
   Splitting the town cell on its commas turned "Peace River, AB T8S 1A6"
   into two towns: the app got the first fragment, the sales sheet was
   rewritten with " / " where the comma had been, and the two halves were
   reported as the books disagreeing. Thirteen real addresses were mangled
   that way before anyone read one back. */
{
  const c = buildContext();
  c.setup();
  const addr = '8206 96 St\r\nPeace River, AB T8S 1A6\r\nCanada';
  const sh = c.sheet_(c.TABS.CUSTOMERS);
  sh.appendRow(['Mija Oh', 'michelleoh07@gmail.com', '', addr, '', '',
                0, 1, 0, 0, 0, 'Website', '', '']);
  const card = c.customerWhere_('Mija Oh');
  check('an address stays one address, commas and all',
    card.known.town.map(v => v.value), [addr]);

  const saved = c.customerSave_({ customer: 'Mija Oh', town: addr });
  check('and saving it back does not put slashes through it',
    [saved.ok !== false, sh.getRange(2, 4, 1, 1).getValues()[0][0]], [true, addr]);

  // A cell that really does hold two places still splits; the app's own cell
  // holds one, which is why only the first is written back to it.
  check('two towns separated on purpose are still two',
    c.splitCell_('Peace River / Grimshaw', c.TOWN_SPLIT), ['Peace River', 'Grimshaw']);
  check('and an address is left whole',
    c.splitCell_(addr, c.TOWN_SPLIT), [addr]);

  // Phones and emails keep splitting on commas, which is how they are written.
  check('a phone cell with two numbers still splits on the comma',
    c.splitCell_('780-555-0100, 780-555-0199'), ['780-555-0100', '780-555-0199']);
}

/* ---- a customer write that cannot land must say so ----
   appWrite_ answers false when the heading is missing, and every caller used
   to throw that away: the save came back ok, the sales sheet took the value,
   and the app's own cell stayed empty with nothing to say so. */
{
  const c = buildContext();
  c.setup();
  const sh = c.sheet_(c.TABS.CUSTOMERS);
  sh.appendRow(['Board and Barrel', 'boardnbarrel@gmail.com', '', '', '', '',
                0, 1, 0, 0, 0, 'Paul', '', 'Bones']);

  const ok = c.customerSave_({ customer: 'Board and Barrel', phone: '587-749-1188' });
  check('a phone saved against a customer lands in the app book',
    [ok.ok !== false, sh.getRange(2, 3, 1, 1).getValues()[0][0]],
    [true, '587-749-1188']);

  // Now take the Phone heading away and try the same save again.
  sh.getRange(1, 3).setValue('');
  const bad = c.customerSave_({ customer: 'Board and Barrel', phone: '780-555-0123' });
  check('with no Phone column the save refuses instead of reporting success',
    [bad.ok, /no Phone column/.test(String(bad.error))], [false, true]);
}

/* ---- the Contacts refusal has to name the right cause ----
   Both problems answer 403, and for a year the message told Paul to grant a
   permission that was already granted, while the People API sat switched off
   in the Cloud project. The message is the only thing that reaches him. */
{
  const c = buildContext();
  const peopleErr = (body) => {
    try {
      c.__fetchStub = { code: 403, body: body };
      c.peopleFetch_('get', 'contactGroups');
      return '';
    } catch (e) { return e.message; }
    finally { c.__fetchStub = null; }
  };
  if (typeof c.peopleFetch_ === 'function' && c.__canStubFetch) {
    const off = peopleErr(JSON.stringify({ error: { message:
      'People API has not been used in project 455461323167 before or it is disabled.' } }));
    check('a switched-off People API says so, with the project and the link',
      [/not enabled/.test(off), /455461323167/.test(off),
       /console\.developers\.google\.com/.test(off), /setupCustomerSync/.test(off)],
      [true, true, true, false]);
    const denied = peopleErr(JSON.stringify({ error: { message: 'Request had insufficient scopes.' } }));
    check('a missing permission still says to run setupCustomerSync',
      /setupCustomerSync/.test(denied), true);
  }
}


console.log('\na client with two numbers');
/* The sales sheet and Contacts always kept both answers. The app's own book
   held one to a cell, so the second was dropped here and the books drifted
   apart on paper. Evelyn and Robert Dennis had both numbers typed into the one
   cell as "867-445-5513 and 780-925-2231", which read as a single number that
   dialled nowhere and was reported as a disagreement on every sweep. */
{
  const c = buildContext();
  c.setup();
  const sh = c.sheet_(c.TABS.CUSTOMERS);
  const head = sh.getRange(1, 1, 1, c.HEADERS.CUSTOMERS.length).getValues()[0];
  check('the app book has somewhere to keep a second answer',
    [head.indexOf('Email 2') > -1, head.indexOf('Phone 2') > -1], [true, true]);

  check('two numbers written with "and" are two numbers',
    c.splitCell_('867-445-5513 and 780-925-2231'), ['867-445-5513', '780-925-2231']);
  check('and written with "&"',
    c.splitCell_('780-555-0100 & 780-555-0199'), ['780-555-0100', '780-555-0199']);
  check('a lone number is still one number',
    c.splitCell_('867-445-5513'), ['867-445-5513']);

  sh.appendRow(['Evelyn and Robert Dennis', '', '867-445-5513 and 780-925-2231', '',
                '', '', 0, 1, 0, 0, 0, 'Paul', '', '']);
  const out = c.syncCustomers_({ only: 'Evelyn and Robert Dennis' });
  const row = () => sh.getRange(2, 1, 1, c.HEADERS.CUSTOMERS.length).getValues()[0];
  const at = (h) => c.HEADERS.CUSTOMERS.indexOf(h);
  check('the pair is separated, first where it was and second beside it',
    [out.ok, row()[at('Phone')], row()[at('Phone 2')]],
    [true, '867-445-5513', '780-925-2231']);
  check('and it is reported as a second answer kept, not a blank filled',
    out.appSecond, 1);
}

/* A number typed in by hand is an answer too. Overwriting it would make the
   app the one book Paul cannot correct, and everything he enters has to stay
   editable afterwards. */
{
  const c = buildContext();
  c.setup();
  const sh = c.sheet_(c.TABS.CUSTOMERS);
  const at = (h) => c.HEADERS.CUSTOMERS.indexOf(h);
  const line = c.HEADERS.CUSTOMERS.map(() => '');
  line[at('Customer')] = 'Sheila Wegreen';
  line[at('Email')] = 'nwegreen@hotmail.com, sheila.wegreen@usask.ca';
  line[at('Email 2')] = 'typed.by.hand@example.com';
  sh.appendRow(line);

  c.syncCustomers_({ only: 'Sheila Wegreen' });
  const row = sh.getRange(2, 1, 1, c.HEADERS.CUSTOMERS.length).getValues()[0];
  check('a second answer entered by hand is left exactly alone',
    row[at('Email 2')], 'typed.by.hand@example.com');
  check('and the cell holding the pair is not taken apart around it',
    row[at('Email')], 'nwegreen@hotmail.com, sheila.wegreen@usask.ca');
}

/* With no column to put it in, the pair stays whole. Halving the cell and
   dropping the second number would be worse than leaving it ugly. */
{
  const c = buildContext();
  c.setup();
  const sh = c.sheet_(c.TABS.CUSTOMERS);
  const at = (h) => c.HEADERS.CUSTOMERS.indexOf(h);
  sh.appendRow(['Evelyn and Robert Dennis', '', '867-445-5513 and 780-925-2231', '',
                '', '', 0, 1, 0, 0, 0, 'Paul', '', '']);
  sh.getRange(1, at('Phone 2') + 1).setValue('');   // take the column away

  const out = c.syncCustomers_({ only: 'Evelyn and Robert Dennis' });
  check('with nowhere to keep it, the pair is left whole rather than halved',
    [out.ok, out.appSecond,
     sh.getRange(2, at('Phone') + 1, 1, 1).getValues()[0][0]],
    [true, 0, '867-445-5513 and 780-925-2231']);
}

/* A second answer typed into the app has to count as something the app says,
   or it would never reach the sales sheet or Contacts. */
{
  const c = buildContext();
  c.setup();
  const sh = c.sheet_(c.TABS.CUSTOMERS);
  const at = (h) => c.HEADERS.CUSTOMERS.indexOf(h);
  const line = c.HEADERS.CUSTOMERS.map(() => '');
  line[at('Customer')] = 'Jean and Val Sylvain';
  line[at('Email')] = 'jvalsyl@telus.net';
  line[at('Email 2')] = 'jvalsylv@gmail.com';
  sh.appendRow(line);

  const card = c.customerWhere_('Jean and Val Sylvain');
  check('both of the app’s emails are answers the card knows about',
    card.known.email.map(v => v.value).sort(),
    ['jvalsyl@telus.net', 'jvalsylv@gmail.com']);
}

/* ---- one person, one row ----
   A customer was filed under their email address if they had one, else
   under their name, and an order was looked up the same way. So an order
   that carried her email found her row and an order that carried only her
   phone did not, and made a second Katelyn Kelly. Then a third. */
{
  const c = buildContext();
  c.setup();
  const sh = c.sheet_(c.TABS.CUSTOMERS);
  const at = (h) => c.HEADERS.CUSTOMERS.indexOf(h);
  const line = c.HEADERS.CUSTOMERS.map(() => '');
  line[at('Customer')] = 'Katelyn Kelly';
  line[at('Email')] = 'katelynkelly4398@gmail.com';
  sh.appendRow(line);

  // One order with her address on it, one with only her phone.
  const token = c.PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  c.handle_({ parameter: {} }, { action: 'submit', token: token, ops: [
    { clientKey: 'kk1', type: 'ORDER_NEW', orderId: 'ORD-KK-1', customer: 'Katelyn Kelly',
      contact: 'katelynkelly4398@gmail.com', deliveryDate: '2026-10-22', method: 'Pickup',
      lines: [{ sku: 'RIBEYE-STEAK', packages: 1 }] },
    { clientKey: 'kk2', type: 'ORDER_NEW', orderId: 'ORD-KK-2', customer: 'Katelyn Kelly',
      contact: '17802197407', deliveryDate: '2026-10-22', method: 'Pickup',
      lines: [{ sku: 'RIBEYE-STEAK', packages: 1 }] }
  ]});
  check('both orders were taken', c.readOrders_().length, 2);
  c.rebuildCustomers_();

  const kk = c.readTable_(c.TABS.CUSTOMERS)
    .filter(r => String(r['Customer']).toLowerCase() === 'katelyn kelly');
  check('an order by email and an order by phone land on the one row',
    kk.length, 1);
  check('and both of them are counted on it',
    c.num_(kk[0] ? kk[0]['Orders'] : 0), 2);
}

/* ---- count it, do not count on it ----
   Tallow sells and liver sells, and neither belongs in the yield. Organs
   were missing from that list, so the June steer's 24 lb of liver read as
   meat and put the yield four points high. */
{
  const c = buildContext();
  const out = [['Beef Tallow', 'tallow'], ['Soup Bones', ''], ['Trim Scraps', ''],
               ['Beef Liver', ''], ['Organ Meats', ''], ['Bone Marrow', ''],
               ['Beef Heart', ''], ['Oxtail', '']];
  const inYield = [['Ribeye Steak', 'steak'], ['Ground Beef', ''], ['Chuck Roast', ''],
                   ['Brisket', ''], ['Maui Ribs (Flanken)', '']];
  check('fat, bones, scraps and organs are counted but not counted on',
    out.filter(x => c.countsInYield_('SKU', x[0], x[1])).map(x => x[0]), []);
  check('and the meat still is',
    inYield.filter(x => !c.countsInYield_('SKU', x[0], x[1])).map(x => x[0]), []);
}

/* ---- carcass weight, not hanging weight ----
   Paul keeps the two apart: the carcass weight is what the plant weighed
   the dressed animal at, and the hanging weight is what it weighed after
   it hung, which on most of these nobody took. The yield goes against the
   carcass. Every steer recorded before the split has one number under the
   old heading and it is a carcass weight, so a blank carcass weight falls
   back to it rather than reading those animals as unweighed. */
{
  const c = buildContext();
  check('a carcass weight is what the yield is worked out against',
    c.carcassOf_({ 'Carcass weight (lb)': 1290.8, 'Hanging weight (lb)': 1180 }), 1290.8);
  check('an older steer with only the old column still counts',
    c.carcassOf_({ 'Hanging weight (lb)': 1900 }), 1900);
  check('and one with neither is not read as nothing-at-all pounds',
    [c.carcassOf_({}), c.carcassOf_({ 'Carcass weight (lb)': '', 'Hanging weight (lb)': '' })],
    [0, 0]);
  check('the new column is on the end of the tab, where a missing one is added',
    c.HEADERS.STEERS[c.HEADERS.STEERS.length - 1], 'Carcass weight (lb)');
}

/* ---- two yields, and they are not the same measurement ----
   Meat over the carcass is what the butcher got out of a dressed animal.
   Meat over the live weight is what we got out of the animal we paid for.
   F2 was weighed on the hoof at 1,900 lb and never on the rail; the June
   steer was weighed on the rail at 1,290.8 and never on the hoof. Averaged
   together, a 41 and a 52 would read as one usual yield. */
{
  const c = buildContext();
  const june = c.yieldsOf_(530.8, 1290.8, 0);
  const f2 = c.yieldsOf_(996.9, 0, 1900);
  check('a steer weighed on the rail gets a cutting yield and no other',
    [june.cut, june.take], [41.12, null]);
  check('and one weighed on the hoof gets a take-home yield and no other',
    [f2.cut, f2.take], [null, 52.47]);
  check('an animal weighed both ways gets both',
    c.yieldsOf_(500, 1000, 1500), { cut: 50, take: 33.33 });
  check('and one weighed neither way gets neither',
    c.yieldsOf_(500, 0, 0), { cut: null, take: null });
}

/* ---- the rebuild does not erase what it cannot work out ----
   The June steer went out before the app existed, so no movement was ever
   booked against it and the tally the rebuild does came to nothing. It
   wrote that nothing over the saleable weight, and the Cattle performance
   tab had no figure for the animal ten minutes after one was typed. */
{
  const c = buildContext();
  c.setup();
  const sh = c.sheet_(c.TABS.STEERS);
  const H = c.HEADERS.STEERS;
  const line = H.map(() => '');
  line[H.indexOf('Steer ID')] = 'GONE-WHOLE';
  line[H.indexOf('Carcass weight (lb)')] = 1000;
  line[H.indexOf('Saleable weight (lb)')] = 640;   // typed by a person
  line[H.indexOf('Packages cut')] = 210;
  sh.appendRow(line);

  c.rebuildSteers_();
  const after = c.readTable_(c.TABS.STEERS)
    .filter(r => String(r['Steer ID']) === 'GONE-WHOLE')[0];
  check('a weight nobody can recompute survives the rebuild',
    c.num_(after['Saleable weight (lb)']), 640);
  check('and so does the package count',
    c.num_(after['Packages cut']), 210);
  check('and the yield is worked out from it',
    c.num_(after['Yield %']), 64);
}

console.log(failures ? '\n' + failures + ' FAILED\n' : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
