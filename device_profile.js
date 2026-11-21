/* Device-local learning data. Legacy keys remain untouched as a migration backup. */
const DeviceProfile = (() => {
  const KEY = 'ebm_device_profile_v1';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const owned = key => /^(ebm_|soaica_)/.test(key) && !/auth|cloud|password|token|secret|api.?key/i.test(key) && key !== KEY;
  const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  function validateTree(value, depth = 0) {
    if (depth > 40) throw new Error('Data is too deeply nested');
    if (value && typeof value === 'object') for (const key of Object.keys(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe property');
      validateTree(value[key], depth + 1);
    }
  }
  function merge(a, b) {
    if (Array.isArray(a) && Array.isArray(b)) return [...new Map([...a, ...b].map(x => [JSON.stringify(x), x])).values()];
    if (object(a) && object(b)) {
      const out = {...a};
      for (const key of Object.keys(b)) out[key] = key in a ? merge(a[key], b[key]) : b[key];
      return out;
    }
    return b;
  }
  function validate(p) {
    validateTree(p);
    if (!object(p) || p.version !== 1 || !uuid.test(p.device_id) ||
        typeof p.display_name !== 'string' || !p.display_name.trim() || p.display_name.length > 100 ||
        typeof p.created_at !== 'string' || !Number.isFinite(Date.parse(p.created_at)) || !object(p.progress)) throw new Error('Invalid profile');
    for (const key of ['read_ids', 'bookmarked_ids']) if (!Array.isArray(p[key]) || p[key].some(x => typeof x !== 'string' || x.length > 500)) throw new Error('Invalid activity');
    for (const [key, value] of Object.entries(p.progress)) {
      if (!owned(key) || typeof value !== 'string') throw new Error('Invalid progress');
      try { validateTree(JSON.parse(value)); } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
    }
    return p;
  }
  function create(storage, cryptoSource = globalThis.crypto, lang = 'vi') {
    const read = key => { try { return storage.getItem(key); } catch (_) { return null; } };
    let p;
    try { p = validate(JSON.parse(read(KEY))); } catch (_) {}
    const persist = () => { try { storage.setItem(KEY, JSON.stringify(p)); return true; } catch (_) { return false; } };
    if (!p) {
      const bytes = new Uint8Array(16);
      if (cryptoSource?.getRandomValues) cryptoSource.getRandomValues(bytes);
      else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
      bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
      const hex = [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
      const id = cryptoSource?.randomUUID ? cryptoSource.randomUUID() : `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
      p = {version: 1, device_id: id, display_name: lang === 'en' ? 'Doctor' : 'Bác sĩ', created_at: new Date().toISOString(), read_ids: [], bookmarked_ids: [], progress: {}};
      try {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (owned(key)) p.progress[key] = read(key);
        }
      } catch (_) {}
      const collect = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 20) return;
        for (const key of ['read_ids', 'bookmarked_ids']) if (Array.isArray(value[key])) p[key] = [...new Set([...p[key], ...value[key].filter(x => typeof x === 'string')])];
        for (const [key, child] of Object.entries(value)) if (!/password|token|secret|api.?key/i.test(key)) collect(child, depth + 1);
      };
      for (const value of Object.values(p.progress)) { try { collect(JSON.parse(value)); } catch (_) {} }
      try {
        const users = JSON.parse(read('ebm_cloud_users_db'));
        validateTree(users);
        collect(users);
        const active = users?.[read('ebm_cloud_current_user')];
        const name = active?.display_name || active?.full_name;
        if (typeof name === 'string' && name.trim()) p.display_name = name.trim().slice(0,100);
        const sanitized = JSON.parse(JSON.stringify(users, (key, value) => /password|token|secret|api.?key/i.test(key) ? undefined : value));
        p.progress.ebm_legacy_users_progress = JSON.stringify(sanitized);
      } catch (_) {}
      persist();
    }
    return {
      get profile() { return JSON.parse(JSON.stringify(p)); },
      get(key) { return p.progress[key] ?? null; },
      set(key, value) { if (!owned(key)) return; p.progress[key] = String(value); persist(); },
      remove(key) { delete p.progress[key]; persist(); },
      activity(readIds, savedIds) { p.read_ids = [...new Set(readIds)]; p.bookmarked_ids = [...new Set(savedIds)]; persist(); },
      rename(name) { name = String(name).trim(); if (!name || name.length > 100) throw new Error('Invalid name'); p.display_name = name; persist(); },
      exportJSON() { const {device_id, ...backup} = p; return JSON.stringify(backup, null, 2); },
      importJSON(text, mode = 'merge') {
        if (typeof text !== 'string' || text.length > 5 * 1024 * 1024 || !['merge','replace'].includes(mode)) throw new Error('Invalid import');
        const parsed = JSON.parse(text);
        if (parsed?.device_id !== undefined && !uuid.test(parsed.device_id)) throw new Error('Invalid legacy device ID');
        const incoming = validate({...parsed, device_id: p.device_id});
        const next = mode === 'merge' ? merge(p, incoming) : incoming;
        if (mode === 'merge') for (const key of Object.keys(incoming.progress)) {
          try {
            const a = JSON.parse(p.progress[key]), b = JSON.parse(incoming.progress[key]);
            if (object(a) && object(b) || Array.isArray(a) && Array.isArray(b)) next.progress[key] = JSON.stringify(merge(a,b));
          } catch (_) {}
        }
        p = {...next, device_id: p.device_id, created_at: p.created_at};
        persist();
      }
    };
  }
  return {create, KEY};
})();
if (typeof module !== 'undefined') module.exports = DeviceProfile;
