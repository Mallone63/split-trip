/** UI preferences persisted in localStorage (shared across tabs). */

const MINE_ONLY_KEY = 'tripsplit:mineOnly';

/** "Только мои" filter — shared by the balances and expenses tabs. */
export function readMineOnlyPref(): boolean {
  try {
    return localStorage.getItem(MINE_ONLY_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeMineOnlyPref(value: boolean): void {
  try {
    localStorage.setItem(MINE_ONLY_KEY, value ? '1' : '0');
  } catch {
    /* private mode — the pref just won't persist */
  }
}