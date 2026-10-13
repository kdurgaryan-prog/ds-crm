import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { get, setUnauthenticatedHandler } from './api.js';

const Ctx = createContext(null);

const FONTS = {
  system: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  atkinson: "'Atkinson Hyperlegible', system-ui, sans-serif",
  inter: "'Inter', system-ui, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, Menlo, Consolas, monospace",
};
const DENSITY = { compact: 34, comfortable: 44, spacious: 56 };

/** Apply a person's look settings to the whole app (font, size, weight, colors, row height, theme). */
export function applyPrefs(p = {}) {
  const r = document.documentElement.style;
  r.setProperty('--font-body', FONTS[p.fontFamily] || FONTS.atkinson);
  r.setProperty('--fs', `${p.fontSize || 15}px`);
  r.setProperty('--fw', String(p.fontWeight || 400));
  r.setProperty('--row-h', `${DENSITY[p.density] || 44}px`);
  if (p.accent) r.setProperty('--accent', p.accent); else r.removeProperty('--accent');
  if (p.textColor) r.setProperty('--ink', p.textColor); else r.removeProperty('--ink');
  if (p.theme && p.theme !== 'auto') document.documentElement.dataset.theme = p.theme; else delete document.documentElement.dataset.theme;
}

export function SessionProvider({ children }) {
  const [me, setMe] = useState(undefined);
  const load = useCallback(async () => {
    try { const m = await get('/auth/me'); setMe(m); applyPrefs(m.prefs); } catch { setMe(null); }
  }, []);
  useEffect(() => { load(); setUnauthenticatedHandler(() => setMe(null)); }, [load]);
  const can = useCallback(p => !!me?.permissions?.includes(p), [me]);
  return <Ctx.Provider value={{ me, setMe, reload: load, can }}>{children}</Ctx.Provider>;
}
export const useSession = () => useContext(Ctx);
