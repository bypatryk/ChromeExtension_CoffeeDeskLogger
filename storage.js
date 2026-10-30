// Shared storage layer for the content script, the popup and the background worker.
// All data lives in chrome.storage.local under one key: { [id]: coffee }.
// Deletions are remembered under TOMBS ({ [id]: deletedAt }) so the Chrome sync
// backup (background.js) can tell "removed on purpose" apart from "storage was wiped".
(() => {
  const KEY = 'coffees';
  const TOMBS = 'coffeeTombstones';
  const HOST_RE = /(^|\.)coffeedesk\.pl$/i;

  // Turns any coffeedesk URL into a stable product key.
  // /product/Slug and /product/123/Slug both become "product:slug".
  function keyFromUrl(href) {
    let u;
    try { u = new URL(href, 'https://www.coffeedesk.pl/'); } catch { return null; }
    if (!HOST_RE.test(u.hostname)) return null;
    let path = u.pathname;
    try { path = decodeURIComponent(path); } catch { /* keep raw */ }
    path = path.toLowerCase().replace(/\/+$/, '');
    const segs = path.split('/').filter(Boolean);
    if (segs[0] === 'product' && segs.length > 1) return 'product:' + segs[segs.length - 1];
    if (segs[0] === 'detail' && segs[1]) return 'detail:' + segs[1];
    return path ? 'path:' + path : null;
  }

  const isProductKey = (k) => !!k && (k.startsWith('product:') || k.startsWith('detail:'));

  // Every coffee in the log counts as bought; a rating refines that.
  function statusOf(item) {
    if (item.rating === 'love') return 'love';
    if (item.rating === 'like') return 'like';
    if (item.rating === 'dislike') return 'dislike';
    return 'bought';
  }

  // What the product is: regular coffee (default), decaf, or something else (filters, gear…).
  const KINDS = { coffee: 'Coffee', decaf: 'Decaf', other: 'Other' };
  const kindOf = (item) => (item && KINDS[item.kind] ? item.kind : 'coffee');

  async function getAll() {
    const r = await chrome.storage.local.get(KEY);
    const all = r[KEY] || {};
    for (const it of Object.values(all)) normalize(it); // upgrades older entries in memory
    return all;
  }

  async function saveAll(all) {
    await chrome.storage.local.set({ [KEY]: all });
  }

  function findByKey(all, key) {
    if (!key) return null;
    if (all[key]) return all[key];
    for (const it of Object.values(all)) {
      if (it.aliases && it.aliases.includes(key)) return it;
    }
    return null;
  }

  function normalize(item) {
    // Anything in the log is a coffee you bought.
    item.bought = true;
    if (!item.kind && item.tags?.includes('decaf')) item.kind = 'decaf'; // from the old tags field
    item.kind = kindOf(item);
    delete item.tags;
    // boughtAt: when it entered the log. ratedAt: when the current rating was set.
    // Older entries didn't track these, so they fall back to the closest timestamp we have.
    if (!item.boughtAt) item.boughtAt = item.addedAt || item.updatedAt || null;
    if (!item.rating) item.ratedAt = null;
    else if (!item.ratedAt) item.ratedAt = item.updatedAt || item.addedAt || null;
    return item;
  }

  // Sets ratedAt when a patch changes the rating (unless the patch picks a date itself).
  function stampRating(prev, patch, now) {
    if (!('rating' in patch) || (patch.rating || null) === (prev.rating || null)) return patch;
    return { ...patch, ratedAt: patch.rating ? (patch.ratedAt ?? now) : null };
  }

  // Create or update an entry from product page metadata.
  async function upsert(meta, patch = {}) {
    const all = await getAll();
    const keys = [meta.id, ...(meta.aliases || [])].filter(Boolean);
    let existing = null;
    for (const k of keys) { existing = findByKey(all, k); if (existing) break; }
    const now = Date.now();
    const base = existing || {
      id: meta.id, bought: true, rating: null, comment: '', kind: meta.kind || 'coffee', addedAt: now, boughtAt: now, aliases: []
    };
    const item = normalize({
      ...base,
      name: meta.name || base.name || '',
      brand: meta.brand || base.brand || '',
      image: meta.image || base.image || '',
      url: meta.url || base.url || '',
      price: meta.price ?? base.price ?? null,
      weight: meta.weight ?? base.weight ?? null,
      aliases: [...new Set([...(base.aliases || []), ...keys])],
      ...stampRating(base, patch, now),
      updatedAt: now
    });
    all[item.id] = item;
    await saveAll(all);
    return item;
  }

  // Keeps price and weight current when you revisit a logged product, without
  // bumping updatedAt (so the popup order doesn't change just from browsing).
  async function refreshDetails(meta) {
    const all = await getAll();
    let it = null;
    for (const k of [meta.id, ...(meta.aliases || [])]) { it = findByKey(all, k); if (it) break; }
    if (!it) return;
    const next = { price: meta.price ?? it.price ?? null, weight: meta.weight ?? it.weight ?? null };
    if (next.price === (it.price ?? null) && next.weight === (it.weight ?? null)) return;
    Object.assign(it, next);
    await saveAll(all);
  }

  // Price per 100 g in PLN, or null when price or weight is unknown.
  const pricePer100g = (item) =>
    item && item.price > 0 && item.weight > 0 ? (item.price / item.weight) * 100 : null;

  async function update(id, patch) {
    const all = await getAll();
    if (!all[id]) return null;
    const now = Date.now();
    all[id] = normalize({ ...all[id], ...stampRating(all[id], patch, now), updatedAt: now });
    await saveAll(all);
    return all[id];
  }

  async function remove(id) {
    const all = await getAll();
    delete all[id];
    const tombs = (await chrome.storage.local.get(TOMBS))[TOMBS] || {};
    await chrome.storage.local.set({ [KEY]: all, [TOMBS]: { ...tombs, [id]: Date.now() } });
  }

  function onChange(cb) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[KEY]) return;
      const all = changes[KEY].newValue || {};
      for (const it of Object.values(all)) normalize(it);
      cb(all);
    });
  }

  globalThis.CoffeeStore = {
    KEY, TOMBS, keyFromUrl, isProductKey, statusOf, KINDS, kindOf, normalize,
    getAll, saveAll, findByKey, upsert, refreshDetails, pricePer100g, update, remove, onChange
  };
})();
