(() => {
  const S = globalThis.CoffeeStore;
  if (!S || window.__coffeeLogLoaded) return;
  window.__coffeeLogLoaded = true;

  const LABELS = { love: 'Loved', like: 'Liked', dislike: 'Disliked', bought: 'Bought' };
  const THUMB_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>';
  // Status icons as HTML: thumbs for ratings, a check for plain bought.
  const HEART_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>';
  const GLYPHS = {
    love: HEART_SVG,
    like: THUMB_SVG,
    dislike: THUMB_SVG.replace('<svg ', '<svg style="transform:rotate(180deg)" '),
    bought: '✓'
  };
  const STATUS_CLASSES = ['cdl-card', 'cdl-card--love', 'cdl-card--like', 'cdl-card--dislike', 'cdl-card--bought'];

  let items = {};
  let aliasMap = new Map();
  let pageProduct = null;
  let panel = null;

  function rebuildMap() {
    aliasMap = new Map();
    for (const it of Object.values(items)) {
      for (const k of [it.id, ...(it.aliases || [])]) if (k) aliasMap.set(k, it);
    }
  }
  const lookup = (key) => (key ? aliasMap.get(key) : undefined);

  // ---------------------------------------------------------------- product page

  const meta = (p) =>
    (document.querySelector(`meta[property="${p}"], meta[name="${p}"]`)?.content || '').trim();

  function firstImage(img) {
    if (!img) return '';
    if (typeof img === 'string') return img;
    if (Array.isArray(img)) return firstImage(img[0]);
    return img.url || img.contentUrl || '';
  }

  function readJsonLdProduct() {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try { data = JSON.parse(s.textContent); } catch { continue; }
      const stack = [data];
      while (stack.length) {
        const n = stack.pop();
        if (!n || typeof n !== 'object') continue;
        if (Array.isArray(n)) { stack.push(...n); continue; }
        const t = n['@type'];
        if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) return n;
        if (n['@graph']) stack.push(n['@graph']);
      }
    }
    return null;
  }

  function readMicrodata() {
    const scope = document.querySelector('[itemtype*="schema.org/Product"]');
    if (!scope) return null;
    const val = (el) => el ? (el.getAttribute('content') || el.getAttribute('src') || el.textContent || '').trim() : '';
    const brandEl = scope.querySelector('[itemprop="brand"]');
    return {
      name: val(scope.querySelector('[itemprop="name"]')),
      brand: brandEl ? (val(brandEl.querySelector('[itemprop="name"]')) || val(brandEl)) : '',
      image: val(scope.querySelector('[itemprop="image"]'))
    };
  }

  // "1 234,50 zł" -> 1234.5
  function parsePrice(text) {
    const m = (text || '').replace(/[\s\u00a0]/g, '').match(/\d+(?:[.,]\d{1,2})?/);
    return m ? parseFloat(m[0].replace(',', '.')) : null;
  }

  // The regular price: the crossed-out "Cena regularna" when discounted, else the current price.
  function readPrice(ld) {
    const regular = document.querySelector('.product-detail-list-price-wrapper .is-crossed');
    if (regular) return parsePrice(regular.textContent);
    const current = parsePrice(document.querySelector('.product-detail-price')?.textContent);
    if (current) return current;
    const offer = Array.isArray(ld?.offers) ? ld.offers[0] : ld?.offers;
    const p = parseFloat(offer?.price);
    return p > 0 ? p : null;
  }

  // Net weight in grams, from "Zawartość: 250 g" or failing that the product name ("... 1 kg").
  function readWeight(name) {
    const sources = [document.querySelector('.price-unit-content')?.textContent, name];
    for (const s of sources) {
      const m = (s || '').match(/(\d+(?:[.,]\d+)?)\s*(kg|g)\b/i);
      if (m) {
        const n = parseFloat(m[1].replace(',', '.'));
        return Math.round(m[2].toLowerCase() === 'kg' ? n * 1000 : n);
      }
    }
    return null;
  }

  // Product details table: { "Typ produktu": "Kawa", "Zawartość kofeiny": "Bezkofeinowa", ... }
  function readProperties() {
    const props = {};
    for (const row of document.querySelectorAll('tr.properties-row')) {
      const k = row.querySelector('.properties-label')?.textContent.trim().replace(/:$/, '');
      const v = row.querySelector('.properties-value')?.textContent.replace(/\s+/g, ' ').trim();
      if (k && v && !(k in props)) props[k] = v;
    }
    return props;
  }

  // Suggested type for a newly logged product; the user can still change it.
  function readKind(name) {
    const props = readProperties();
    const type = props['Typ produktu'];
    if (type && !/^kawa$/i.test(type)) return 'other';
    if (/bezkofein/i.test(props['Zawartość kofeiny'] || '') || /\bdecaf\b|bezkofein/i.test(name)) return 'decaf';
    return type ? 'coffee' : null;
  }

  function extractProduct() {
    const ld = readJsonLdProduct();
    const md = readMicrodata();
    const onProductPath = /^\/(product|detail)\//i.test(location.pathname);
    if (!ld && !md && !onProductPath && meta('og:type') !== 'product') return null;

    const h1 = (document.querySelector('h1')?.textContent || '').replace(/\s+/g, ' ').trim();
    const ogTitle = meta('og:title').replace(/\s*[-|]\s*Coffeedesk.*$/i, '');
    const name = (ld?.name || md?.name || h1 || ogTitle).trim();
    if (!name) return null;

    let brand = typeof ld?.brand === 'string' ? ld.brand : (ld?.brand?.name || '');
    if (!brand) brand = md?.brand || '';
    if (!brand) {
      const logo = document.querySelector('.product-detail-manufacturer-link, .product-detail-manufacturer-logo');
      brand = (logo?.getAttribute('title') || logo?.getAttribute('alt') || '').trim();
    }
    if (!brand && name.includes(' - ')) brand = name.split(' - ')[0].trim();

    const image = firstImage(ld?.image) || md?.image || meta('og:image') ||
      document.querySelector('.gallery-slider-image, .product-detail-media img')?.src || '';

    const canonical = document.querySelector('link[rel="canonical"]')?.href || ld?.url || location.href;
    const url = canonical.split('#')[0].split('?')[0];
    const keys = [...new Set([S.keyFromUrl(url), S.keyFromUrl(location.href)].filter(Boolean))];
    if (!keys.length) return null;

    return { id: keys[0], aliases: keys, name, brand, image, url, price: readPrice(ld), weight: readWeight(name), kind: readKind(name) };
  }

  function currentItem() {
    if (!pageProduct) return null;
    for (const k of pageProduct.aliases) { const it = lookup(k); if (it) return it; }
    return null;
  }

  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel {
      --paper: #F5F6F3; --surface: #FFFFFF; --ink: #1E2629; --muted: #66706F; --line: #DCE0DB;
      --bean: #6B4F2A; --love: #B8336A; --like: #2F7D5B; --dislike: #A33A33;
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: var(--ink);
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
    }
    @media (prefers-color-scheme: dark) {
      .panel {
        --paper: #171B1C; --surface: #1F2426; --ink: #E8EBE7; --muted: #9AA3A1; --line: #333B3D;
        --bean: #C79A5B; --love: #F07AA6; --like: #5DBB8F; --dislike: #E0736A;
      }
    }
    button { font: inherit; cursor: pointer; }
    button:focus-visible, textarea:focus-visible, input:focus-visible { outline: 2px solid var(--bean); outline-offset: 2px; }

    .tab-label { display: inline-flex; align-items: center; gap: 5px; }
    .tab {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 9px 14px 9px 11px; border-radius: 999px; border: 1px solid var(--line);
      background: var(--surface); color: var(--ink); font-weight: 600;
      box-shadow: 0 6px 20px rgba(20, 25, 27, .16);
    }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--line); flex: none; }
    .panel[data-status="love"] .dot { background: var(--love); }
    .panel[data-status="like"] .dot { background: var(--like); }
    .panel[data-status="dislike"] .dot { background: var(--dislike); }
    .panel[data-status="bought"] .dot { background: var(--bean); }

    .body {
      display: none; width: 290px; padding: 14px; border-radius: 14px;
      background: var(--surface); border: 1px solid var(--line);
      box-shadow: 0 12px 32px rgba(20, 25, 27, .2);
    }
    .panel[data-open="true"] .body { display: block; }
    header { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; margin-bottom: 12px; }
    .name { font: 600 15px/1.25 "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; }
    .brand { grid-column: 1; color: var(--muted); font-size: 12px; }
    .close { grid-row: 1 / span 2; grid-column: 2; align-self: start; border: 0; background: none; color: var(--muted); font-size: 18px; line-height: 1; padding: 2px 4px; }

    .add {
      width: 100%; margin-bottom: 10px; padding: 8px; border-radius: 8px;
      border: 1px solid var(--bean); background: var(--bean); color: #fff; font-weight: 600;
    }
    .add[hidden] { display: none; }

    .dates { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-bottom: 10px; color: var(--muted); font-size: 12px; }
    .dates label { display: inline-flex; align-items: center; gap: 6px; }
    .dates label[hidden] { display: none; }
    .dates input {
      padding: 3px 6px; border: 1px solid var(--line); border-radius: 6px;
      background: var(--paper); color: var(--ink); font: inherit; font-size: 12px;
    }

    .controls { display: flex; gap: 8px; margin-bottom: 10px; }
    .seg { display: flex; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; }
    .seg.kind { flex: 1; }
    .seg button {
      flex: 1; display: inline-flex; align-items: center; justify-content: center;
      padding: 6px 7px; border: 0; background: var(--paper); color: var(--muted); font-size: 12px; font-weight: 600;
    }
    .seg.rate button { padding: 6px 9px; }
    .seg button + button { border-left: 1px solid var(--line); }
    .seg button:hover { color: var(--ink); }
    .seg button[aria-pressed="true"] { background: var(--ink); color: var(--surface); }
    .seg .love[aria-pressed="true"] { background: var(--love); color: #fff; }
    .seg .love[aria-pressed="true"] svg { fill: currentColor; }
    .panel[data-status="love"] .tab-label svg { fill: var(--love); color: var(--love); }
    .seg .like[aria-pressed="true"] { background: var(--like); color: #fff; }
    .seg .dislike[aria-pressed="true"] { background: var(--dislike); color: #fff; }
    .seg svg { display: block; }
    .dislike svg { transform: rotate(180deg); }

    textarea {
      width: 100%; min-height: 70px; resize: vertical; padding: 8px 10px; border-radius: 8px;
      border: 1px solid var(--line); background: var(--paper); color: var(--ink);
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    footer { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; min-height: 22px; }
    .saved { color: var(--muted); font-size: 12px; }
    .remove { border: 0; background: none; color: var(--dislike); font-size: 12px; padding: 2px 0; }
    .remove[hidden] { display: none; }
  `;

  // <input type="date"> uses local "YYYY-MM-DD".
  function toDateValue(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  // Today keeps the current time (so ordering within a day stays natural); other days use local noon.
  function fromDateValue(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
    if (!m) return null;
    if (v === toDateValue(Date.now())) return Date.now();
    return new Date(+m[1], m[2] - 1, +m[3], 12).getTime();
  }

  function mountPanel() {
    const host = document.createElement('div');
    host.id = 'cdl-panel-host';
    host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483646;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${PANEL_CSS}</style>
      <section class="panel" data-open="false" data-status="none">
        <div class="body" role="group" aria-label="Coffeedesk.pl Logger">
          <header>
            <div class="name"></div>
            <div class="brand"></div>
            <button class="close" type="button" aria-label="Close panel">×</button>
          </header>
          <div class="dates">
            <label>Bought <input type="date" class="bought-date" aria-label="Date bought"></label>
            <label class="rated-wrap" hidden>Rated <input type="date" class="rated-date" aria-label="Date rated"></label>
          </div>
          <button type="button" class="add">✓ Log as bought</button>
          <div class="controls">
            <div class="seg rate" role="group" aria-label="Rating">
              <button type="button" class="love" aria-pressed="false" title="Loved" aria-label="Loved">${HEART_SVG}</button>
              <button type="button" class="like" aria-pressed="false" title="Liked" aria-label="Liked">${THUMB_SVG}</button>
              <button type="button" class="dislike" aria-pressed="false" title="Disliked" aria-label="Disliked">${THUMB_SVG}</button>
            </div>
            <div class="seg kind" role="group" aria-label="Product type">
              <button type="button" data-kind="coffee" aria-pressed="true">Coffee</button>
              <button type="button" data-kind="decaf" aria-pressed="false">Decaf</button>
              <button type="button" data-kind="other" aria-pressed="false">Other</button>
            </div>
          </div>
          <textarea placeholder="Notes: brew method, grind, what you tasted…"></textarea>
          <footer>
            <span class="saved" aria-live="polite"></span>
            <button type="button" class="remove" hidden>Remove from log</button>
          </footer>
        </div>
        <button class="tab" type="button" aria-expanded="false"><span class="dot"></span><span class="tab-label"></span></button>
      </section>`;
    document.documentElement.appendChild(host);

    const $ = (s) => root.querySelector(s);
    const el = {
      panel: $('.panel'), tab: $('.tab'), tabLabel: $('.tab-label'), close: $('.close'),
      name: $('.name'), brand: $('.brand'), add: $('.add'),
      kinds: root.querySelectorAll('.kind button'),
      love: $('.love'), like: $('.like'), dislike: $('.dislike'), note: $('textarea'),
      saved: $('.saved'), remove: $('.remove'),
      boughtDate: $('.bought-date'), ratedDate: $('.rated-date'), ratedWrap: $('.rated-wrap')
    };
    el.boughtDate.value = el.boughtDate.max = el.ratedDate.max = toDateValue(Date.now());
    el.name.textContent = pageProduct.name;
    el.brand.textContent = pageProduct.brand || '';

    function setOpen(open) {
      el.panel.dataset.open = String(open);
      el.tab.setAttribute('aria-expanded', String(open));
      chrome.storage.local.set({ cdlPanelOpen: open });
    }
    el.tab.addEventListener('click', () => setOpen(el.panel.dataset.open !== 'true'));
    el.close.addEventListener('click', () => setOpen(false));
    chrome.storage.local.get('cdlPanelOpen').then((r) => {
      el.panel.dataset.open = String(!!r.cdlPanelOpen);
      el.tab.setAttribute('aria-expanded', String(!!r.cdlPanelOpen));
    });

    let savedTimer;
    function flashSaved(text = 'Saved') {
      el.saved.textContent = text;
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => (el.saved.textContent = ''), 1600);
    }
    async function save(patch) {
      // A coffee logged for the first time takes the date picked in "Bought".
      if (!currentItem()) {
        const boughtAt = fromDateValue(el.boughtDate.value);
        if (boughtAt) patch = { boughtAt, ...patch };
      }
      await S.upsert(pageProduct, patch);
      flashSaved();
    }

    el.add.addEventListener('click', () => save({}));
    el.boughtDate.addEventListener('change', () => {
      const boughtAt = fromDateValue(el.boughtDate.value);
      if (boughtAt && currentItem()) save({ boughtAt });
    });
    el.ratedDate.addEventListener('change', () => {
      const ratedAt = fromDateValue(el.ratedDate.value);
      if (ratedAt && currentItem()?.rating) save({ ratedAt });
    });

    for (const b of el.kinds) b.addEventListener('click', () => save({ kind: b.dataset.kind }));
    el.love.addEventListener('click', () => {
      save({ rating: currentItem()?.rating === 'love' ? null : 'love' });
    });
    el.like.addEventListener('click', () => {
      save({ rating: currentItem()?.rating === 'like' ? null : 'like' });
    });
    el.dislike.addEventListener('click', () => {
      save({ rating: currentItem()?.rating === 'dislike' ? null : 'dislike' });
    });

    let noteTimer;
    el.note.addEventListener('input', () => {
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => save({ comment: el.note.value }), 400);
    });

    let removeArmed = false, removeTimer;
    el.remove.addEventListener('click', async () => {
      if (!removeArmed) {
        removeArmed = true;
        el.remove.textContent = 'Click again to remove';
        removeTimer = setTimeout(() => { removeArmed = false; el.remove.textContent = 'Remove from log'; }, 3000);
        return;
      }
      clearTimeout(removeTimer);
      removeArmed = false;
      el.remove.textContent = 'Remove from log';
      const it = currentItem();
      if (it) { await S.remove(it.id); flashSaved('Removed'); }
    });

    function sync() {
      const it = currentItem();
      const status = it ? S.statusOf(it) : 'none';
      el.panel.dataset.status = status;
      el.tabLabel.innerHTML = it ? `${GLYPHS[status]} ${LABELS[status]}` : 'Add to coffee log';
      el.add.hidden = !!it;
      const kind = it ? S.kindOf(it) : (pageProduct.kind || 'coffee');
      for (const b of el.kinds) b.setAttribute('aria-pressed', String(b.dataset.kind === kind));
      el.love.setAttribute('aria-pressed', String(it?.rating === 'love'));
      el.like.setAttribute('aria-pressed', String(it?.rating === 'like'));
      el.dislike.setAttribute('aria-pressed', String(it?.rating === 'dislike'));
      if (root.activeElement !== el.note) el.note.value = it?.comment || '';
      el.remove.hidden = !it;
      // Before logging, "Bought" keeps whatever date you picked (today by default).
      if (it && root.activeElement !== el.boughtDate) el.boughtDate.value = toDateValue(it.boughtAt);
      el.ratedWrap.hidden = !it?.rating;
      if (it?.rating && root.activeElement !== el.ratedDate) el.ratedDate.value = toDateValue(it.ratedAt);
    }

    return { sync };
  }

  // ---------------------------------------------------------------- badges on cards

  const linkKeys = new WeakMap();
  function keyOfLink(a) {
    const href = a.getAttribute('href');
    if (!href) return null;
    const cached = linkKeys.get(a);
    if (cached && cached.href === href) return cached.key;
    const key = S.keyFromUrl(href);
    linkKeys.set(a, { href, key });
    return key;
  }

  // Walk up from a product link until the parent would include a different product.
  // The last element reached is that product's card.
  function findCard(a, key) {
    let el = a;
    for (let i = 0; i < 8; i++) {
      const p = el.parentElement;
      if (!p || p === document.body || p === document.documentElement) break;
      let foreign = false;
      for (const l of p.querySelectorAll('a[href]')) {
        const k = keyOfLink(l);
        if (k !== key && S.isProductKey(k)) { foreign = true; break; }
      }
      if (foreign) break;
      el = p;
    }
    return el;
  }

  function badgeHost(card) {
    let host = card.querySelector('img')?.parentElement || card;
    if (host.tagName === 'PICTURE') host = host.parentElement || card;
    if (!card.contains(host)) host = card;
    return host;
  }

  function clearDecorations() {
    document.querySelectorAll('.cdl-badge').forEach((b) => b.remove());
    document.querySelectorAll('[data-cdl-status]').forEach((el) => {
      el.classList.remove(...STATUS_CLASSES);
      delete el.dataset.cdlStatus;
      delete el.dataset.cdlId;
    });
    document.querySelectorAll('[data-cdl-pos]').forEach((el) => {
      el.style.position = '';
      delete el.dataset.cdlPos;
    });
  }

  function applyBadge(card, item, status) {
    card.querySelectorAll('.cdl-badge').forEach((b) => b.remove());
    card.classList.remove(...STATUS_CLASSES);
    card.classList.add('cdl-card', `cdl-card--${status}`);
    card.dataset.cdlStatus = status;
    card.dataset.cdlId = item.id;

    const host = badgeHost(card);
    if (getComputedStyle(host).position === 'static') {
      host.style.position = 'relative';
      host.dataset.cdlPos = '1';
    }
    const b = document.createElement('span');
    b.className = `cdl-badge cdl-badge--${status}`;
    const kind = S.kindOf(item);
    b.innerHTML = `${GLYPHS[status]} ${LABELS[status]}` + (kind === 'coffee' ? '' : ` · ${S.KINDS[kind]}`);
    b.title = item.comment ? item.comment : 'In your coffee log';
    host.appendChild(b);
  }

  function decorate() {
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const key = keyOfLink(a);
      if (!S.isProductKey(key)) continue;
      if (pageProduct && pageProduct.aliases.includes(key)) continue; // skip links to the page we're on
      const item = lookup(key);
      if (!item) continue;
      const card = findCard(a, key);
      if (seen.has(card)) continue;
      seen.add(card);
      const status = S.statusOf(item);
      const existing = card.querySelector('.cdl-badge');
      if (card.dataset.cdlStatus === status && card.dataset.cdlId === item.id && existing) {
        existing.title = item.comment || 'In your coffee log';
        continue;
      }
      applyBadge(card, item, status);
    }
  }

  let scanTimer;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(decorate, 250);
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && !n.classList.contains('cdl-badge') && n.id !== 'cdl-panel-host') {
          scheduleScan();
          return;
        }
      }
    }
  });

  // ---------------------------------------------------------------- boot

  async function init() {
    items = await S.getAll();
    rebuildMap();

    pageProduct = extractProduct();
    if (pageProduct) {
      panel = mountPanel();
      panel.sync();
      S.refreshDetails(pageProduct);
    }

    decorate();
    observer.observe(document.body, { childList: true, subtree: true });

    S.onChange((next) => {
      items = next;
      rebuildMap();
      panel?.sync();
      clearDecorations();
      decorate();
    });
  }

  init();
})();
