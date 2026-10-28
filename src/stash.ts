// Keeps the open file, and the photos picked to go with it, across a page
// reload to sign in again when the Cloudflare Access session has run out.
// IndexedDB because a job and its photos are bigger than sessionStorage allows.

// Its own database, so it never needs a version bump of the FXL library store's.
const DB = 'openfieldview-stash';
const STORE = 'stash';
const ID = 'before-sign-in';

export interface Stash {
  /** What to carry on with once back. */
  then: 'upload';
  file?: { text?: string; blob?: Blob; name: string; origin?: unknown };
  extras?: { name: string; blob: Blob }[];
  note?: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function stash(s: Stash): Promise<void> {
  try {
    await run('readwrite', (st) => st.put({ ...s, at: Date.now() }, ID));
  } catch {
    // No IndexedDB (private mode on some browsers): the file has to be reopened.
  }
}

/** The stash left before sign-in, if any, and only within the last half hour. */
export async function takeStash(): Promise<Stash | undefined> {
  try {
    const s = await run<(Stash & { at: number }) | undefined>('readonly', (st) => st.get(ID));
    if (!s) return undefined;
    await run('readwrite', (st) => st.delete(ID));
    return Date.now() - s.at < 30 * 60_000 ? s : undefined;
  } catch {
    return undefined;
  }
}
