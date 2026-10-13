// File-system directories are paths, never URL fragments or guessed filenames.
export function fileUrlOfPath(path) {
  const p = String(path || '').replace(/\\/g, '/');
  const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  if (p.startsWith('//')) {
    const [host, ...parts] = p.slice(2).split('/');
    return 'file://' + host + '/' + parts.map(encode).join('/');
  }
  const parts = p.split('/');
  if (/^[A-Za-z]:$/.test(parts[0])) return 'file:///' + parts[0] + '/' + parts.slice(1).map(encode).join('/');
  return 'file://' + (p.startsWith('/') ? '' : '/') + parts.map(encode).join('/');
}

export function resolveImageSource(src, directory) {
  const s = String(src == null ? '' : src);
  if (!s) return s;
  if (/^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s)) return fileUrlOfPath(s);
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(s) || !directory) return s;
  const dir = String(directory).replace(/\\/g, '/').replace(/\/?$/, '/');
  try { return new URL(s.replace(/\\/g, '/'), fileUrlOfPath(dir)).href; } catch { return s; }
}

export const hasImageCandidate = text => /!\[|<img\b/i.test(text);
