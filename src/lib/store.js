/**
 * Scan persistence — IndexedDB, not localStorage.
 * A full scan is ~15k jobs with 4KB descriptions (~50MB+), far past the ~5MB
 * localStorage quota. IndexedDB stores structured clones with no practical
 * limit for this size, so the whole scan survives a refresh and filtering
 * happens on the saved set without rescanning.
 *
 * Stored record (key "latest"):
 *   { jobs, scannedAt, errors, firstSeen, newIds }
 *   - firstSeen: { [jobId]: ISO string of the scan that first saw it }
 *   - newIds:    ids first seen in the most recent scan (drives "New" filter)
 */
const DB_NAME = "jobradar";
const DB_VERSION = 1;
const STORE = "scans";
const KEY = "latest";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveScan(record) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record, KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch (e) {
    console.warn("saveScan failed — scan not persisted:", e);
    return false;
  }
}

export async function loadScan() {
  try {
    const db = await openDb();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return record;
  } catch {
    return null; // private mode / blocked IDB — app works without persistence
  }
}

export async function clearScan() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* ignore */
  }
}
