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
  ['BATCHES','BOX RECIPES','CUSTOMERS','CUT WAITLIST','CUT YIELD MODEL','FOLLOW-UPS','FREEZERS','INVENTORY',
   'MOVEMENTS','ORDER ITEMS','ORDERS','PRODUCTS','SALES HISTORY','SCANS','SETTINGS',
   'STEER PERFORMANCE',
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
check('bad token refused', JSON.parse(ctx.handle_({ parameter: {} }, { action: 'ping', token: 'nope' })._text).ok, false);
check('good token ok', call('ping').ok, true);

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
  check('flagged once past the warning line', aged[0].level, 'warn');
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

  const q = go('quote', { sku: 'RIBEYE-STEAK', weight: 1.1 });
  check('quoted on real weight', q.price, 69.3);
  check('and shows the working', q.basis, '1.10 lb × $63.00/lb');
  const qm = go('quote', { sku: 'RIBEYE-STEAK', weight: 1.1, channel: 'market' });
  check('market price is different', qm.price, 62.7);
  const qkg = go('quote', { sku: 'RIBEYE-STEAK', weight: 0.5, kg: true });
  check('kilograms accepted', qkg.price, 69.45);
  const boxSku = Object.keys(c.indexProducts_()).filter(k => k.indexOf('BEST-OF-BOTH') === 0)[0];
  const qb = go('quote', { sku: boxSku });
  check('a box quotes at its set price', qb.price, 115);
  check('the floor comes off the steer', q.cost > 0, true);
  check('and the margin with it', q.margin !== '', true);

  go('addToList', { list: 'waitlist', entry: { customer: 'R. Dyck', phone: '780-555-0199',
    wants: 'Tenderloin', size: 'L', packages: 4 } });
  go('addToList', { list: 'wholesale', entry: { customer: 'Bergen family', email: 'b@example.com',
    wants: 'Half', wantedBy: '2026-11-01', deposit: 500 } });
  const L = go('lists');
  check('cut waitlist saved', L.waitlist[0].customer, 'R. Dyck');
  check('wholesale list saved', L.wholesale[0].wants, 'Half');

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
  check('an unpaid half steer is still active', jean.status, 'Active');
  check('its rail weight came across', jean.weight, 580);
  check('the price is the number at the end of the sum', jean.price, 4060);
  check('the final invoice came across', jean.invoice, 'PCW 041');
  check('the date survives a second column also called Date', jean.added, '2026-02-28');

  const jeff2 = L.wholesale.filter(r => r.customer === 'Jeff Cappis' && r.invoice === 'PCW 048')[0];
  check('a past quarter sits beside the same name on the waiting list', !!jeff2, true);
  check('and the price is net of the deposit', jeff2.price, 1649);
  check('with the deposit taken', jeff2.deposit, 500);

  const haecki = L.wholesale.filter(r => r.customer.indexOf('Matthias') === 0)[0];
  check('a paid whole animal reads as Done', haecki.status, 'Done');
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

console.log(failures ? '\n' + failures + ' FAILED\n' : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
