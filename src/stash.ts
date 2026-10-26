// Keeps the open file across the trip to GitHub's sign-in page, which
// reloads the app. IndexedDB because a job can be bigger than sessionStorage
// allows.

const DB = 'openfieldview';
const STORE = 'stash';
const ID = 'before-sign-in';

export interface Stash {
  /** What to carry on with once back. */
  then: 'upload' | 'jobs';
  file?: { text: string; name: string; origin?: { repo: string; path: string; version?: string } };
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
