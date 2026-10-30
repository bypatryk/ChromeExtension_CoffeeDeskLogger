// Keeps a backup of the coffee log in chrome.storage.sync (your Chrome account).
//
// Sync layout: one entry per coffee ("c:<id>") plus deletion markers ("t:<id>" -> deletedAt),
// because sync storage allows at most 8 KB per entry and ~100 KB in total.
//
// Every run merges both sides: for each coffee the newer copy (by updatedAt) wins, and a
// deletion wins over any copy that wasn't edited after it. That gives us:
// - local storage wiped (extension reinstalled, data cleared) -> the log comes back from sync;
// - a coffee removed on purpose -> it stays removed, here and in the backup;
// - two computers on the same Chrome account -> their logs combine instead of overwriting.
importScripts('storage.js');
const S = globalThis.CoffeeStore;

const ITEM = 'c:';
const TOMB = 't:';
const STATUS = 'syncStatus';
const RUNNING = 'syncRunningSince'; // set while a backup runs, so the popup can show "Syncing…"
const ITEM_LIMIT = chrome.storage.sync.QUOTA_BYTES_PER_ITEM - 64; // a little headroom
const TOTAL_LIMIT = Math.floor(chrome.storage.sync.QUOTA_BYTES * 0.9);
const TOMB_TTL = 180 * 24 * 60 * 60 * 1000; // forget deletions after ~6 months

const enc = new TextEncoder();
const sizeOf = (key, value) => enc.encode(key).length + enc.encode(JSON.stringify(value)).length;

// JSON with sorted keys, so "same data, different key order" compares equal.
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function merge(local, localTombs, remote, remoteTombs, now) {
  const tombs = { ...localTombs };
  for (const [id, at] of Object.entries(remoteTombs)) tombs[id] = Math.max(tombs[id] || 0, at);

  const items = {};
  for (const id of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const a = local[id], b = remote[id];
    let it = !b ? a : !a ? b : (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a;
    // The backup may have been stored without images to save space; keep ours.
    if (it === b && a?.image && !b.image) it = { ...b, image: a.image };
    if (tombs[id] && tombs[id] >= (it.updatedAt || 0)) continue;
    items[id] = S.normalize({ ...it });
  }

  for (const [id, at] of Object.entries(tombs)) {
    if (items[id] || now - at > TOMB_TTL) delete tombs[id];
  }
  return { items, tombs };
}

// One coffee as stored in sync. "slim" drops the image URL (the biggest field);
// it comes back the next time you open that product page.
function syncValue(item, slim) {
  let v = slim ? { ...item, image: '' } : item;
  const key = ITEM + item.id;
  if (sizeOf(key, v) > ITEM_LIMIT) v = { ...v, image: '' };
  while (sizeOf(key, v) > ITEM_LIMIT && v.comment) {
    v = { ...v, comment: v.comment.slice(0, Math.floor(v.comment.length * 0.8)) };
  }
  return v;
}

function desiredSync(items, tombs, slim) {
  const out = {};
  for (const it of Object.values(items)) out[ITEM + it.id] = syncValue(it, slim);
  for (const [id, at] of Object.entries(tombs)) out[TOMB + id] = at;
  return out;
}

const totalSize = (entries) => Object.entries(entries).reduce((n, [k, v]) => n + sizeOf(k, v), 0);

async function reconcile() {
  const now = Date.now();
  const localData = await chrome.storage.local.get([S.KEY, S.TOMBS]);
  const localItems = localData[S.KEY] || {};
  const localTombs = localData[S.TOMBS] || {};
  const remoteAll = await chrome.storage.sync.get(null);

  const remoteItems = {}, remoteTombs = {};
  for (const [k, v] of Object.entries(remoteAll)) {
    if (k.startsWith(ITEM)) remoteItems[k.slice(ITEM.length)] = v;
    else if (k.startsWith(TOMB)) remoteTombs[k.slice(TOMB.length)] = v;
  }

  const { items, tombs } = merge(localItems, localTombs, remoteItems, remoteTombs, now);

  // 1. Local side: only write when something actually changed.
  const localPatch = {};
  if (stable(items) !== stable(localItems)) localPatch[S.KEY] = items;
  if (stable(tombs) !== stable(localTombs)) localPatch[S.TOMBS] = tombs;
  const restored = Object.keys(items).filter((id) => !localItems[id]).length;
  if (Object.keys(localPatch).length) await chrome.storage.local.set(localPatch);

  // 2. Sync side: full copy if it fits, otherwise without images.
  let slim = false;
  let desired = desiredSync(items, tombs, false);
  if (totalSize(desired) > TOTAL_LIMIT) { slim = true; desired = desiredSync(items, tombs, true); }
  const bytes = totalSize(desired);
  if (bytes > TOTAL_LIMIT) {
    await setStatus({ ok: false, error: 'Chrome sync is full', count: Object.keys(items).length, bytes });
    return;
  }

  const toSet = {};
  for (const [k, v] of Object.entries(desired)) if (stable(v) !== stable(remoteAll[k])) toSet[k] = v;
  const toRemove = Object.keys(remoteAll)
    .filter((k) => (k.startsWith(ITEM) || k.startsWith(TOMB)) && !(k in desired));
  // Remove first so freed space is available for the new entries.
  if (toRemove.length) await chrome.storage.sync.remove(toRemove);
  if (Object.keys(toSet).length) await chrome.storage.sync.set(toSet);

  await setStatus({ ok: true, count: Object.keys(items).length, bytes, slim, restored });
}

function setStatus(status) {
  return chrome.storage.local.set({ [STATUS]: { ...status, at: Date.now() } });
}

// Runs one reconcile at a time; bursts of changes (typing a note) collapse into one run.
let queue = Promise.resolve();
function runNow() {
  queue = queue
    .then(async () => {
      await chrome.storage.local.set({ [RUNNING]: Date.now() });
      try { await reconcile(); } finally { await chrome.storage.local.remove(RUNNING); }
    })
    .catch((e) => setStatus({ ok: false, error: String(e?.message || e) }));
  return queue;
}
let timer;
function runSoon(ms = 2000) {
  clearTimeout(timer);
  timer = setTimeout(runNow, ms);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('sync-backup', { periodInMinutes: 60 });
  runNow();
});
chrome.runtime.onStartup.addListener(runNow);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'sync-backup') runNow(); });
// "Sync now" in the popup.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'syncNow') return;
  clearTimeout(timer);
  runNow().then(() => sendResponse({ done: true }));
  return true; // reply asynchronously
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[S.KEY] || changes[S.TOMBS])) runSoon();
  if (area === 'sync') runSoon(); // edits arriving from another computer
});

// Exposed for tests.
globalThis.__coffeeSync = { merge, reconcile, syncValue, stable };
