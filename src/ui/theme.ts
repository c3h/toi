export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'toi:theme';
const media = (): MediaQueryList => matchMedia('(prefers-color-scheme: dark)');

/** Preferência visual desta máquina; `public/theme.js` aplica a mesma regra antes do paint. */
export const readTheme = (): ThemePref => {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
};

const applyTheme = (pref: ThemePref): void => {
  const dark = pref === 'dark' || (pref === 'system' && media().matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
};

export const saveTheme = (pref: ThemePref): void => {
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // Sem localStorage o tema só não sobrevive a reload.
  }
  applyTheme(pref);
};

/** Segue o sistema enquanto a preferência for `system`. */
export const followSystemTheme = (): (() => void) => {
  const query = media();
  const onChange = () => {
    if (readTheme() === 'system') applyTheme('system');
  };
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};
