# PCW Inventory — setup

Two pieces, same as the timesheet app: a Google Sheet with an Apps Script backend,
and a phone app (PWA) that talks to it. About 20 minutes, once.

---

## 1. The Sheet (5 min)

1. In the **admin@pcwagyu.com** Drive, make a new blank Google Sheet. Name it
   **PCW Inventory**.
2. **Extensions ▸ Apps Script**. Delete whatever is in `Code.gs`, paste in the
   whole `Code.gs` from this folder, and save.
3. In the function dropdown pick **setup** and hit ▶ Run. Approve the permissions
   when Google asks (it's your own script — click through "Advanced ▸ Go to…").
4. Back on the Sheet, reload the tab. You get fifteen tabs and a **PCW Inventory**
   menu. The popup shows your **API token** — copy it somewhere for step 3.
   (You can always get it back from **PCW Inventory ▸ Show API token**.)

## 2. Deploy the backend (3 min)

In Apps Script: **Deploy ▸ New deployment ▸** gear ▸ **Web app**

| Field | Set it to |
|---|---|
| Execute as | **Me** (admin@pcwagyu.com) |
| Who has access | **Anyone with the link** |

Copy the **Web app URL** — it ends in `/exec`. That plus the token is all the
phone app needs. Nobody can read or write anything without the token.

> Any time you change `Code.gs` later: **Deploy ▸ Manage deployments ▸** pencil ▸
> Version: **New version ▸ Deploy**. The URL stays the same.

## 3. Put the app on the phones (10 min)

Host `index.html`, `sw.js`, `manifest.json`, `icon-192.png` and `icon-512.png`
on GitHub Pages the same way as the timesheet app — a new repo (e.g.
`pcw-inventory`), files in the root, **Settings ▸ Pages ▸ Deploy from branch ▸
main / root**.

On each phone:

1. Open the Pages URL in **Chrome** (Android) or **Safari** (iPhone).
2. Add to home screen — Chrome: ⋮ ▸ *Add to Home screen*. Safari: Share ▸
   *Add to Home Screen*.
3. Open it from the home screen. It starts on **More ▸ Settings**: type the
   person's name, paste the **Web app URL** and the **API token**, tap
   **Save & connect**.

That's it — one token for everyone, so Hannah and Elijah get the same three
things pasted in. To cut someone off later, change the token: in Apps Script,
**Project Settings ▸ Script properties ▸** edit `API_TOKEN`, then re-issue it to
the people who should still have it.

---

## Setting up your products

Fastest way is straight in the Sheet's **PRODUCTS** tab — one row per thing you
sell:

| Column | What goes in it |
|---|---|
| SKU | Short code, e.g. `RIBEYE-12OZ`. Leave it and the app makes one. |
| Product | Ribeye Steak |
| Category | Steak / Roast / Ground / Value-added |
| Content | `2 × 12 oz` — what's in the pack |
| Sizes | `S, M, L` for a cut that comes in sizes; blank for one size |
| Avg weight (lb) | Used when someone doesn't weigh the batch |
| Default grade | Gold, Bronze, or blank |
| Price / pack | What the pack sells for |
| Price / lb | Per pound |
| Price / kg | Per kilogram |
| Reorder point | Tell me it's low at this many packs |
| Active | Yes / No |

**The three price columns fill each other in.** Type whichever one you actually
price by and leave the rest blank — on the next rebuild (5 minutes, or the menu
item) the others appear:

- per lb → per kg (× 2.2046)
- per kg → per lb
- pack price + average weight → both per-weight prices
- per lb + average weight → pack price

Anything you typed yourself is never overwritten, so if a pack price isn't just
weight × rate — box bundles, for instance — put your own number in and it stays.
The Stock screen shows both rates under each product, and the totals line at the
top values the freezers at the per-lb price.

**ORDERS** and **ORDER ITEMS** fill themselves from the app — an order header
(customer, delivery date, method, status) and one row per item. You can also type
an order straight into those two tabs if that's faster; it shows up on the phone
at the next sync.

**Sizes** are a property of the *stock*, not of the product. One **Sirloin Steak**
row in the app opens into its lots — S / M / L, each with its own grade, batch and
freezer. You don't make three products for three sizes; that's what the old system
did, and it is why the same cut appeared six times in a list.

**BATCHES** is one row per steer: `2026-09-STEER-01`, tag number, outfit
(PCW or DYN), butcher, kill and pack dates, BMS grade. **FREEZERS** starts with
MAIN / SHOP / TRUCK — rename or add your own.

You can also add products and batches from the phone (**+ New product** /
**+ New batch** on the Intake screen).

---

## Day to day

| Tab | What it's for |
|---|---|
| **Orders** (opens here) | What needs assembling, soonest first, late in red. Below it what's packed and waiting. An amber line at the top appears when stock has been in the freezer too long — tap it for the full list and what to do with each lot. |
| **Inventory** | Search, then **−** or **+** on the row. Tap the product name for its lots — size, grade, batch, freezer, age — and **⋯** on a lot to weigh it, recount it or move it. |
| **Price** | What a particular piece is worth. Pick the product, say website or farmers market, type the weight in lb or kg. Shows the price, the per-pound and per-kilo rate, what that piece cost off its steer, and the margin. Or photograph the label instead. |
| **Menu** | Wholesale · Cut waiting list · Meat coming in · Customers · Market day · Boxes · Sync & settings. |

### Inside Menu

**Wholesale** — who wants a whole, half or quarter, their contact, when they want it, deposit, and whether they're waiting or active.

**Cut waiting list** — who is waiting on which cut, in what size and grade. A line turns green the moment there's enough in the freezer to call them.

**Meat coming in** — a steer back from the butcher. Pick the steer (or add one), then enter cuts with size, grade, count and weight, or photograph the labels. The yield on STEER PERFORMANCE fills itself from what you enter here.

**Customers** — everyone who has ordered, newest first, with orders and spend. Built from the orders themselves.

**Market day** — a grid of everything in stock at market prices. Tap a tile each time one sells; the running total is at the top. Nothing leaves stock until you tap Record the day.

**Boxes** — what you can build right now from components, and box ideas worked out from what's actually in the freezer, each with the reason it's worth making. Take one and it becomes a real box.

### Voice

Fields you type often have a microphone beside them. It works in Chrome on Android. Safari on iPhone has no voice input a web app can use — the microphone on the iOS keyboard does the same job in any field.


### The order cycle

1. **New order** — customer, the date it's due, and the items. Nothing leaves stock yet.
2. It sits on **Home** under *Needs assembling* until the due date passes, then goes red.
3. **Mark packed** when you've pulled it — that's the moment stock comes off,
   oldest batch first, each movement tagged with the order number and customer.
   Packed less than ordered? It deducts what actually went in the box.
4. **Mark delivered** when it's gone. No second deduction.

### Orders hold the stock

The moment an order is saved, its packages are **committed** — still in the
freezer, but spoken for. Everywhere a number matters, the app shows both:

- **Stock** — the big number is what's physically there; underneath it, *21 free*
  is what's left after commitments.
- **New order** — "9 free to promise — 13 on hand, 4 already spoken for". Promise
  more than that and it asks first; it never blocks you, since you may well be
  bringing a steer back before the delivery date.
- **Low / out** — judged on what's *free*, not what's stacked. Ten ribeyes with
  nine promised reads as low, which is the truth.

Commitments are handed out **first promised, first served**, by delivery date.
If the freezer can't cover everything, the later order wears the **short** tag —
not the one that got in first — and the order screen says how many packages short
each line is. A commitment is released when the order is packed (the meat
actually leaves), cancelled, or delivered.

In the Sheet, **STOCK BY PRODUCT** carries it as three columns: **Packages** (on
hand), **Committed**, **Available**. Status reads OVERSOLD when you've promised
more than exists.

**Offline is fine.** Out at the shop with no signal, everything you enter — orders
included — is saved on the phone and sent the moment it's back on. It shows up
right away marked *not sent*, and the header pill reads "3 waiting" until it
clears. Nothing doubles up if it syncs twice.

---

## How the Sheet stays honest

**MOVEMENTS** is the only tab that gets written to — one signed row per thing
that happened (+12 in, −6 out), with who, when, which batch and which freezer.
**INVENTORY** and **STOCK BY PRODUCT** are rebuilt from it every 5 minutes and on
every app sync, so stock levels can never quietly drift away from the record.

That means: **don't type a new quantity into INVENTORY** — it'll be overwritten.
To correct a count, use **Adjust ▸ Freezer recount** on the phone, or add a row
to MOVEMENTS yourself.

Deleting a bad row in MOVEMENTS *is* the way to undo a mistake — then
**PCW Inventory ▸ Rebuild stock from ledger**.

### Asking me to change things

Because it's all in one Sheet I can work on it for you — "add Wagyu Bratwurst,
1 lb packs, tell me when it's under 12", or "Hannah miscounted, main freezer
ground beef is 28 not 31", or "how much ribeye is left from steer 812". I'll
write the product row or the adjustment movement and the app picks it up on its
next sync.

### Low-stock email

Put an address in **SETTINGS ▸ LOW_STOCK_EMAIL** and run **PCW Inventory ▸ Email
low-stock digest now** to test. To get it automatically, in Apps Script:
**Triggers ▸ Add trigger ▸** `sendLowStockDigest` ▸ Time-driven ▸ Week timer ▸
Monday 7am.

### Other settings

| Key | Does what |
|---|---|
| `BUSINESS` | Name in the app header |
| `ALLOW_NEGATIVE` | `WARN` lets a sale go through with a flag when the count is short; `BLOCK` refuses it |
| `DEFAULT_FREEZER` | Pre-selected on the Intake screen |

---

## If something goes wrong

**"The backend did not return data"** — the web app URL is wrong, or it's
deployed as *Only myself* instead of *Anyone with the link*.

**"Bad or missing token"** — token mismatch. Sheet menu ▸ Show API token, paste
it again.

**Phone shows old stock** — pull the app closed and reopen, or **More ▸ Refresh
stock**. It syncs on open, when it comes back online, and every minute while
anything is queued.

**Numbers look wrong** — **PCW Inventory ▸ Rebuild stock from ledger**, then read
down MOVEMENTS for that product. Every change has a name and a timestamp on it.

**Upgrading later** — paste a newer `Code.gs` over the old one and run `setup()`
again. It remaps existing rows by column name first, so adding a column never
scrambles what's already in the tabs.


---

## The rest of the tabs

| Tab | What it's for |
|---|---|
| **BOX RECIPES** | Boxes you already sell — one row per component: box SKU, component SKU, packages per box. This is what makes "how many Family Feast can I build?" answerable, and what puts the cuts back when a box is broken up. |
| **CUT YIELD MODEL** | What a rail should produce, held per 100 lb so it fits any animal — pounds, packages and price per cut. Backfilled from your *Steer potential vs actual yield* workbook. Set **Use?** to No for a cut you aren't taking: T-Bone conflicts with strip + tenderloin, and the rib styles are pick-one. |
| **STEER PERFORMANCE** | One row per steer. You type the animal's own numbers — live and hanging weight, purchase, butcher and other costs. The script fills the rest from the ledger: packages cut, saleable weight, yield %, cost per saleable pound, what's sold and what's still in the freezer. |
| **CUSTOMERS** | Rebuilt from orders. Name, contact, first and last order, how many orders, packages, spend. `In Google Contacts` goes to Yes once the contact is filed. |
| **WHOLESALE** | Whole / half / quarter: both the people still waiting and the animals already sold — status, priority, deposit, rail weight, price, invoice number and whether it's paid. |
| **SALES HISTORY** | Everything sold, given away or eaten for quality control **before** the app started, kept as a record only. The `Counted in stock?` column says *No — before the opening count* on every row, because deducting it now would take the same meat out of the freezer twice. |
| **CUT WAITLIST** | Who is waiting for a particular cut, what size and grade, how many. |
| **SCANS** | Photographed labels waiting to be read. |
| **FOLLOW-UPS** | Who is likely running low on beef. Rebuilt from the whole, half and quarter sales every time the sheet rebuilds, with the drafts and flags the weekly radar writes folded in. |

## Follow-ups: who is running low

A bulk buyer's freezer empties on a fairly predictable clock, so the first
screen is now **Orders and Follow-Up**: the orders to assemble at the top, and
underneath, the people whose freezer should be getting light.

Two things fill that list and they do different jobs.

**The script does the arithmetic.** From each whole, half or quarter sale it
counts forward and works out when that freezer is probably low:

| Share | Follow up after | Setting |
|---|---|---|
| Quarter, front or hind | 3 months | `QUARTER_MONTHS` |
| Half | 6 months | `HALF_MONTHS` |
| Whole | 10 months | `WHOLE_MONTHS` |

A follow-up reads **Due now** for `FOLLOWUP_WINDOW` days (30) past that date and
**Overdue** after. Where the share size was never written down it is read off the
rail weight and the row says so rather than stating it as fact. Somebody still on
the wholesale waiting list is never chased for a reorder, because the date on
their row is when they asked, not when their freezer filled. This runs every
rebuild, so the list is never stale or empty.

**The weekly radar does the judgement.** The Wagyu Reorder Radar scheduled task
reads the sales sheet and the wait lists on Monday mornings and writes the part
a script cannot: whose own stated timing overrides the clock, what to actually
say to them, and anything odd worth knowing before you hit send. It drops a file
called `pcw-followups.json` in Drive; the script picks it up on the next rebuild,
folds the drafts and flags into the tab, and renames the file so the same week
never lands twice. **PCW Inventory ▸ Pick up this week's reorder radar** does it
on demand. Change the file name in **SETTINGS ▸ RADAR_FILE** if you ever need to.

The two never argue: the script owns the dates and share sizes, the radar owns
the wording.

### Sending one

Tap somebody and the app shows what it knows about them, then the note. If the
radar wrote one it is served as-is and credited to it; if not, the app composes
one from the share they took, how long it has been, what they bought before and
anything they are on the cut waiting list for. Either way it is yours to edit
before it goes. **Write me another** asks for a fresh one from scratch.

Nothing is ever sent automatically. A person taps **Send it**, and only then does
it go, through the company Gmail.

**It goes out as sales@pcwagyu.com by default** (**SETTINGS ▸ FOLLOWUP_SEND_AS**),
with the name in **FOLLOWUP_FROM** beside it, and **FOLLOWUP_BCC** if you want a
copy of every one.

One Google rule to get past first: Gmail will only send from an address the
account holds as a **Send mail as** alias. So in the account the script is
installed under, open **Gmail ▸ Settings ▸ Accounts and Import ▸ Send mail as ▸
Add another email address**, add sales@pcwagyu.com, and confirm it. Until that is
done the app does not pretend: it sends from the owning account, points replies
at sales@pcwagyu.com so nothing lands in a personal inbox, and says so on the
screen before anybody taps send.

If sales@pcwagyu.com is a Google Group rather than a mailbox, add it as an alias
on the owning account anyway; a group can be verified the same way as long as
somebody on it can click the confirmation link.

The other two buttons are **Not now, ask me in a month**, which holds them off and
keeps the reason, and **I called them**, for when you picked up the phone instead.
Both are recorded, and both survive a rebuild.

House style, shared with the radar: no dashes used as punctuation.

## The three Google connections

**Website orders.** Squarespace emails every sale to admin@pcwagyu.com.
**PCW Inventory ▸ Fetch website orders now** reads them and creates orders; items
are matched to products by name, and anything it can't match is written into the
order's notes rather than guessed. To have it run by itself: Apps Script ▸
Triggers ▸ `sweepWebsiteOrders_` ▸ Time-driven ▸ every hour.

**Calendar.** Put the PCW calendar's ID in **SETTINGS ▸ CALENDAR_ID** (Google
Calendar ▸ settings for that calendar ▸ Integrate calendar ▸ Calendar ID). Every
open or packed order with a date becomes an all-day event with the pick list in
the description. Runs after each website sweep, or from the menu.

**Contacts.** **File customers in Google Contacts** adds anyone not yet filed,
under the label in **SETTINGS ▸ CONTACTS_LABEL** (default *PCW Customers*). This
one needs a scope the editor can't infer: Apps Script ▸ Project Settings ▸ tick
*Show appsscript.json*, then add to `oauthScopes`:

```
"https://www.googleapis.com/auth/contacts"
```

**Simpler:** the repo now ships `apps-script/appsscript.json` with every scope
this app needs, contacts and Gmail included. Tick *Show appsscript.json* and
paste that file over the one in the editor rather than adding scopes one at a
time.

**Follow-up email.** Sending from the app needs the Gmail scope, which is in that
file. The mail goes out as the account that owns the script, so install this in
admin@pcwagyu.com and replies come back to the right inbox.

## Ageing

**SETTINGS ▸ AGE_WARN_DAYS** (180) and **AGE_URGENT_DAYS** (300). A lot's age is
counted from the day it first went into the freezer, so a recount or a move
doesn't reset it. The app shows one line on the Orders screen; tapping it opens
the full list with what each lot is worth and where it could go.


## Box ideas

Separate from BOX RECIPES, which holds the boxes you already sell. **Box ideas**
builds new ones out of what is actually free in the freezer, oldest packs first,
aiming at the price points in **SETTINGS ▸ BOX_TARGETS** (89, 119, 159, 229 by
default) and landing on a price that ends in 5 or 9.

It only uses stock that is priced and not promised to an order, never proposes
more of something than you have, and says which ageing lines a box would clear.
Ask for a market-price version and it prices at the cash rate instead.

Each idea comes with the reason it is worth making — how many ageing packages it
moves, roughly what that stock is worth, how many cuts it spreads across, and how
far under the sum of its parts the price sits. Take one and it becomes a real box:
a product row, a recipe, buildable like any other.

The four ideas tend to be the same core plus more on top — that is deliberate,
since the oldest stock should lead every one of them. Take an idea, add it to
BOX RECIPES with a name, and it becomes a box you can build like any other.

## Steer yield fills itself

You do not enter cuts twice. Booking stock against a batch is what feeds the
steer sheet: any batch that gets an intake grows a **STEER PERFORMANCE** row by
itself, with packages cut and saleable weight already counted. The only typing
left is the animal's own numbers — live and hanging weight, purchase, butcher
and other costs — and yield %, cost per saleable pound and potential revenue
appear from there.



## Colours

Straight off the PCW brand board in Drive: forest `#17230E`, olive `#2D490B`,
sage `#7B9763`, stone `#7F8E7F`, bone `#E8EAE0`, with Open Sans as the text face.
Dark mode flips to forest backgrounds with sage as the action colour, and
anything sitting on sage turns dark so it stays readable.

Zenghief and Kautiva Pro — the display faces on the brand board — aren't web
fonts, so headings use Open Sans too. If you want the real wordmark in the app
header, drop a PNG of the logo in the repo and say so.

## Potential vs actual

Put a hanging weight on a steer and the model does the rest: **Model saleable lb**
and **Model revenue** are what a rail that size should give you at your prices,
and **Variance vs model** is the gap against what actually came in and sold.

A 660 lb rail models out at about 212 lb saleable and $16,200 at retail. When a
steer comes in well under that, the question is whether it was the animal, the
cutting, or a price that has drifted — and the per-cut rows tell you which.

## Reading the 2026 sales sheet

The wholesale waiting list, the product waiting list and the customer book all
live in **1. 2026 sales sheet**. Rather than copy them across, the script reads
that file directly.

Put its file ID in **SETTINGS ▸ SALES_SHEET_ID** — the long string in its URL
between `/d/` and `/edit` — then **PCW Inventory ▸ Import the lists from the 2026
sales sheet**. It reads six tabs:

| That sheet | Becomes | Notes |
|---|---|---|
| Wholesale Waiting List | WHOLESALE | *Awaiting Animal* becomes *Waiting*; priority, deposit, date booked and the contact notes come across |
| Product Waiting List | CUT WAITLIST | What they asked for is kept **in their words**. Where the wording plainly names a product it also points at that product, so the app can say when it's in stock; where it doesn't — "Cowhide", "Beef spleen", "Pichana" — it stays as written rather than being guessed at |
| Customers' info | CUSTOMERS | Name, phone, email, location, what they've bought before and how many orders, kept as **Orders before the app** so app orders count separately |
| Whole Steer Sales | WHOLESALE + SALES HISTORY | The nine whole, half and quarter sales, with rail weight, price, invoice number and what's owed to Dynastar in the notes. Paid ones read *Done*; the rest stay *Active* and show an **unpaid** tag in the app. As the sheet stands, **Paid is FALSE on all nine** — so all nine land as Active. Worth a look: PCW 038 through PCW 050 are invoiced and a couple are marked E-transfer |
| Sales | SALES HISTORY | Every retail sale with who sold it and how it was paid |
| Promotions | SALES HISTORY | Giveaways, photoshoot stock and quality-control tastings, split into *Promotion* and *Quality control* so they never count as revenue |

Matching is on name — and on name plus invoice for the whole-animal sales, and
date plus customer plus what was sold for the history — so running it again
updates rather than duplicates. Edit the sales sheet, run it again, nothing
doubles.

Amounts in that sheet are written as working notes rather than numbers: `295 -
Stripe fees = 286.14`, `$7/lb x 580 lbs = S4060`. The importer takes the **last**
number in the line, which is the one that matters — so the Stripe fee comes off
the sale, the deposit comes off `$7/lb x 307 lbs = $2149 - $500 = $1649`, and the
typo'd `S4060` still reads as 4060.

Dates are typed by hand in four different shapes — `Jan 9/26`, `January 15 2026`,
`Mar 26/2026`, `3/16/2026` — and all of them come out as proper dates. Anything
genuinely unreadable is kept as written rather than dropped.

Two things the importer leaves alone, because guessing would be worse:
**Reene Beaudoin** and **Renee Beaudoin** are spelled both ways across tabs and
come in as two people, and Jeff Cappis appears twice on purpose — a quarter he
already bought, and a half he is still waiting on.

What each customer spent before the app is added up from SALES HISTORY into
**Spend before the app**, and the app's customer list shows the two together as
one all-time figure. Promotions and quality control are left out of it — meat
given away isn't spend.

### Why the history isn't deducted from stock

All of it happened before the September 23 opening count, and that count already
reflects what was left after those sales. Bringing them in as movements would
subtract the same packages a second time and leave the freezer reading empty.

Going forward, promotional and quality-control meat comes out the normal way: the
**−** button on the inventory line, reason *Sample / giveaway*. That writes a
real movement and the stock drops.

Order counts in CUSTOMERS are rebuilt from the orders every time rather than
added up, so a rebuild can never inflate them — and the imported history sits in
its own column where nothing overwrites it.
