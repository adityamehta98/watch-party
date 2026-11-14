// Loaded in <head> so the theme is set before first paint. A saved choice wins; otherwise follow the device.
window.wpTheme = theme => {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#f8f9fb' : '#0a0b0e';
};
{
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('wp.theme')); } catch { /* private mode */ }
  wpTheme(saved === 'light' || saved === 'dark' ? saved : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
}
