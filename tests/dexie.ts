import { ToiDatabase } from '../src/adapters/storage/db';

let dbCount = 0;

export const openDb = (): ToiDatabase => new ToiDatabase(`toi-test-${(dbCount += 1)}`);

export const dropDb = async (db: ToiDatabase): Promise<void> => {
  db.close();
  await db.delete();
};

export const withDb = async (task: (db: ToiDatabase) => Promise<void>): Promise<void> => {
  const db = openDb();
  try {
    await task(db);
  } finally {
    await dropDb(db);
  }
};
