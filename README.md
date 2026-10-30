# Coffeedesk.pl Logger

A personal Chrome extension for remembering the coffees you've bought on [coffeedesk.pl](https://www.coffeedesk.pl) and what you thought of them.

Mark a coffee as bought, give it a thumbs up or down, note how you brewed it, and the extension shows that verdict wherever the coffee appears on the site: on its product page and as a badge in listings and search results. The toolbar popup keeps the whole log in one place, with the price per 100 g of each bag so you can compare value and decide what to buy again. The log is backed up to your Chrome account automatically.

## Install
1. Open `chrome://extensions` and switch on **Developer mode** (top right).
2. Click **Load unpacked** and pick the `coffeedesk-log` folder.
3. Pin the extension from the puzzle-piece menu so the icon is always visible.

The extension ID should be `kjnhaklghamaokgpomhogoidkdndefcd` (fixed by the `key` in `manifest.json`, see [Backup](#backup)).

## Use

### On a product page
A pill in the bottom-right corner shows the coffee's status; click it to open the panel.

- **Log as bought** adds the coffee to your log. Rating it, choosing a type or writing a note also adds it: everything in the log counts as bought.
- **Bought** date: today by default, used when you log the coffee; you can change it later.
- **Thumbs up / down** rates it (click again to clear). A **Rated** date (today by default) appears once it's rated.
- **Coffee / Decaf / Other** sets the type. It's detected when you first log a product: "Zawartość kofeiny: Bezkofeinowa" → Decaf, any "Typ produktu" other than Kawa (brewers, filters, machines) → Other.
- **Notes** for brew method, grind, tasting notes.
- **Remove from log** (click twice).

Everything saves as you go. Opening the page of a logged coffee also refreshes its price and weight.

### While browsing
Coffees in your log get a badge on their image in categories, search results and related products: green thumbs up for liked, red thumbs down for disliked (the image is also faded), brown ✓ for bought but not rated yet, with "Decaf" or "Other" added when it applies. Hover a badge to read your note.

### Toolbar popup
- **Tabs:** Unrated, Liked, Disliked. It opens on Unrated, or on Liked when everything is rated.
- **Type dropdown:** toggle Coffee, Decaf and Other. Other is off by default.
- **Search** matches name, roaster, notes and type.
- **Order by:** Bought (newest first, default), Rated (most recently rated first), Price / 100 g or Price (cheapest first).
- Each row shows the name (two lines, hover for the full name), roaster, **price per 100 g**, regular price and weight. The price is the regular one, not a sale price.
- Change the rating and type right in the row. Notes show when there is one; otherwise hover the image and click the pencil to add one.
- Click the name or image to open the product. Hover the image and click × twice to remove it from the log.
- **Sync now** in the footer runs the Chrome sync backup immediately; **Export / Import** save the log to a JSON file and load it back.

## Data
Everything is stored in `chrome.storage.local`: name, roaster, image URL, product URL, regular price, weight, type, rating, note, and when it was bought, rated and last changed.

### Backup
`background.js` keeps a copy in `chrome.storage.sync`, which Chrome stores in your Google account when you're signed in with sync on. The popup footer shows "Syncing…" while a backup runs and the time of the last one otherwise; **Sync now** runs one immediately.

- **When:** about 2 seconds after any change (bursts like typing a note are grouped), when Chrome starts, when the extension is installed or reloaded, and every hour.
- **Restore:** if the local log is ever wiped (extension removed and loaded again, site data cleared), it comes back from the backup on its own. Coffees you removed on purpose stay removed.
- **Several computers:** computers signed in to the same Chrome account share one log; when the same coffee is edited on both, the newer edit wins.
- **Size:** sync storage holds about 100 KB, roughly 150 coffees with images and about twice that without. When space gets tight, the backup leaves out image URLs; your local log keeps them.
- **Extension ID:** the backup belongs to the extension's ID, so `manifest.json` contains a fixed `key`. Don't remove or change it, or the extension gets a new ID and an empty log.

Without Chrome sync turned on, the "backup" stays on this computer only, so keep an occasional Export as well.

## Files
| File | What it does |
|---|---|
| `manifest.json` | Extension setup, permissions and fixed `key` |
| `storage.js` | Shared data layer: reading, saving, product matching, price per 100 g |
| `content.js`, `content.css` | Product-page panel and listing badges on coffeedesk.pl |
| `popup.html`, `popup.js`, `popup.css` | Toolbar popup |
| `background.js` | Chrome sync backup |
| `icons/` | Extension icons |

## If something stops matching
Everything is read from coffeedesk's pages, so a site redesign can break it. In `content.js`:
- **Name, roaster, image:** `extractProduct()` reads the page's structured data (JSON-LD/microdata), Open Graph tags and the `<h1>`. Products are matched by the URL slug after `/product/`.
- **Price:** `readPrice()` uses the crossed-out regular price (`.product-detail-list-price-wrapper .is-crossed`) or `.product-detail-price`.
- **Weight:** `readWeight()` uses `.price-unit-content` ("250 g", "1 kg"), falling back to the product name.
- **Type:** `readKind()` reads the details table (`tr.properties-row`).
- **Badges in listings:** `findCard()` finds the product card around each product link.
