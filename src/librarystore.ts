// Feature libraries kept on this device, so a library is opened once and
// then used for every job. Libraries can be several megabytes, more than
// localStorage holds, so they go in IndexedDB.

export interface StoredLibrary {
  name: string;
  text: string;
  savedAt: string;
}

const DB = 'openfieldview';
const STORE = 'libraries';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).finally(() => db.close()) as Promise<T>;
}

/** Names of the stored libraries, A–Z. Empty if storage is unavailable. */
export async function listLibraries(): Promise<string[]> {
  try {
    const keys = await run('readonly', (s) => s.getAllKeys());
    return keys.map(String).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export async function getLibrary(name: string): Promise<StoredLibrary | undefined> {
  try {
    return await run<StoredLibrary | undefined>('readonly', (s) => s.get(name));
  } catch {
    return undefined;
  }
}

/** Store a library; false if this browser won't keep it (private mode, quota). */
export async function saveLibrary(name: string, text: string): Promise<boolean> {
  try {
    await run('readwrite', (s) => s.put({ name, text, savedAt: new Date().toISOString() } satisfies StoredLibrary));
    return true;
  } catch {
    return false;
  }
}

export async function deleteLibrary(name: string): Promise<void> {
  try {
    await run('readwrite', (s) => s.delete(name));
  } catch {
    // Nothing stored.
  }
}
