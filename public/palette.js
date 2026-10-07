// Applies the saved colour palette before the first paint, so a non-default theme never flashes the default
// colours. It is a plain script (not part of the bundle) because the Content-Security-Policy forbids inline ones.
// The key and the palette names are the ones in src/ui/theme.ts, which handles picking and saving.
try {
  var palette = localStorage.getItem('vgc-planner:palette');
  if (palette && /^[a-z-]+$/.test(palette)) document.documentElement.dataset.palette = palette;
} catch (e) { /* storage unavailable: default palette */ }
