// Appearance: Auto (follows the Mac / iPhone setting), Light or Dark. Loaded in <head> so the page never
// flashes the wrong colors; the choice is remembered per browser (the Mac app, the drop zone and the site
// share it on the same address). Any [data-theme-toggle] button cycles it.
(() => {
  const ORDER = ['auto', 'light', 'dark'];
  const LABEL = { auto: 'Appearance: Auto', light: 'Appearance: Light', dark: 'Appearance: Dark' };
  const read = () => { try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; } };
  const apply = (theme) => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = theme;
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => (b.textContent = LABEL[theme]));
  };
  apply(read());
  addEventListener('storage', (e) => e.key === 'theme' && apply(read()));
  addEventListener('DOMContentLoaded', () => {
    apply(read());
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => b.addEventListener('click', () => {
      const next = ORDER[(ORDER.indexOf(read()) + 1) % ORDER.length];
      try { localStorage.setItem('theme', next); } catch {}
      apply(next);
    }));
  });
})();
