// Aplica o tema antes do primeiro paint; script externo porque a CSP não aceita inline.
(() => {
  let pref = 'system';
  try {
    const stored = localStorage.getItem('toi:theme');
    if (stored === 'light' || stored === 'dark') pref = stored;
  } catch {}
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
