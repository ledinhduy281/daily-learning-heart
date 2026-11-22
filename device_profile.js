/* Device-local learning data. Legacy keys remain untouched as a migration backup. */
const DeviceProfile = (() => {
  const KEY = 'ebm_device_profile_v1';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const owned = key => /^(ebm_|soaica_)/.test(key) && !/auth|cloud|password|token|secret|api.?key/i.test(key) && key !== KEY;
  const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const legacyKeys = /legacy_users|progress_by_user/i;
  const privateField = /email|username|full.?name|display.?name|password|token|secret|api.?key|^name$|@/i;
  const learningKeys = new Set(['ebm_offline_user_activity', 'ebm_socratic_state_v1', 'ebm_ui_lang', 'ebm_font_scale', 'ebm_theme', 'ebm_streak', 'ebm_quiz_progress', 'ebm_ui_prefs']);
  const localHistoryKeys = ['soaica_chat_sessions_v1', 'soaica_chat_verbosity_v1', 'soaica_daily_quota_v1', 'ebm_offline_feedback'];
  const syncKeys = ['ebm_device_server_synced', 'ebm_legacy_server_migrated'];
  function learningData(value) {
    if (Array.isArray(value)) return value.map(learningData);
    if (object(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !privateField.test(key)).map(([key, child]) => [key, learningData(child)]));
    return value;
  }
  function portableProgress(progress) {
    const result = {};
    for (const [key, raw] of Object.entries(progress)) {
      if (legacyKeys.test(key) || privateField.test(key) || syncKeys.includes(key)) continue;
      try { result[key] = JSON.stringify(learningData(JSON.parse(raw))); }
      catch (_) { result[key] = raw; }
    }
    return result;
  }
  function validateTree(value, depth = 0) {
    if (depth > 40) throw new Error('Data is too deeply nested');
    if (value && typeof value === 'object') for (const key of Object.keys(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe property');
      validateTree(value[key], depth + 1);
    }
  }
  function merge(a, b) {
    if (Array.isArray(a) && Array.isArray(b)) {
      const items = new Map();
      for (const item of [...a, ...b]) {
        const key = object(item) && typeof item.id === 'string' ? `id:${item.id}` : `value:${JSON.stringify(item)}`;
        const previous = items.get(key);
        if (!previous || !object(item) || newerRecord(previous, item) === item) items.set(key, item);
      }
      return [...items.values()];
    }
    if (object(a) && object(b)) {
      const out = {...a};
      for (const key of Object.keys(b)) out[key] = key in a ? merge(a[key], b[key]) : b[key];
      return out;
    }
    return b;
  }
  function newerRecord(a, b) {
    const timestamp = x => Date.parse(x.updatedAt || x.updated_at || x.created_at || '') || 0;
    if (timestamp(a) !== timestamp(b)) return timestamp(a) > timestamp(b) ? a : b;
    const size = x => (Array.isArray(x.messages) ? x.messages.length : 0);
    if (size(a) !== size(b)) return size(a) > size(b) ? a : b;
    return JSON.stringify(a).length > JSON.stringify(b).length ? a : b;
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
  function validateProgress(progress) {
    const require = condition => { if (!condition) throw new Error('Invalid progress data'); };
    const fields = (record, schema) => {
      require(object(record));
      for (const [key, type] of Object.entries(schema)) if (key in record) require(typeof record[key] === type);
    };
    const messages = value => {
      require(Array.isArray(value));
      for (const message of value) {
        if (typeof message === 'string') continue;
        fields(message, {id: 'string', role: 'string', text: 'string', markdownText: 'string', engineLabel: 'string'});
        if ('sources' in message) {
          require(Array.isArray(message.sources));
          for (const source of message.sources) {
            fields(source, {url: 'string', doi: 'string', title: 'string', pubdate: 'string'});
            if ('pmid' in source) require(typeof source.pmid === 'string' || typeof source.pmid === 'number');
          }
        }
      }
    };
    for (const [key, raw] of Object.entries(progress)) {
      if (key === 'soaica_chat_verbosity_v1') {
        require(['short', 'medium', 'detailed'].includes(raw.trim().toLowerCase()));
        continue;
      }
      if (!['ebm_socratic_state_v1', 'soaica_chat_sessions_v1', 'soaica_daily_quota_v1', 'ebm_offline_user_activity', 'ebm_offline_feedback', 'ebm_ui_prefs', 'ebm_quiz_progress'].includes(key)) continue;
      const value = JSON.parse(raw);
      validateTree(value);
      if (key === 'soaica_chat_sessions_v1') {
        require(Array.isArray(value));
        for (const session of value) {
          fields(session, {id: 'string', title: 'string', updatedAt: 'string'});
          require(typeof session.id === 'string');
          messages(session.messages);
        }
      } else if (key === 'ebm_socratic_state_v1') {
        require(object(value));
        for (const record of Object.values(value)) {
          fields(record, {started: 'boolean', phase: 'string', last_question: 'string', correct_key: 'string', explanation: 'string', answered_count: 'number', correct_count: 'number', streak: 'number'});
          if ('messages' in record) messages(record.messages);
          if ('subskills' in record) {
            require(Array.isArray(record.subskills));
            for (const skill of record.subskills) fields(skill, {id: 'string', label: 'string', level: 'number', checks: 'number', answered: 'number', correct: 'number'});
          }
          if ('current_options' in record) {
            require(Array.isArray(record.current_options));
            for (const option of record.current_options) if (typeof option !== 'string') fields(option, {key: 'string', text: 'string'});
          }
        }
      } else {
        require(object(value));
        if (key === 'ebm_offline_user_activity') for (const field of ['read_ids', 'bookmarked_ids']) if (field in value) require(Array.isArray(value[field]) && value[field].every(id => typeof id === 'string'));
        if (key === 'soaica_daily_quota_v1') fields(value, {date: 'string', used: 'number', limit: 'number', exhausted: 'boolean', stop_reason: 'string'});
        if (key === 'ebm_offline_feedback') for (const entry of Object.values(value)) {
          fields(entry, {like: 'number', dislike: 'number', report: 'number', likes: 'number', dislikes: 'number', reports: 'number', user_reported: 'boolean'});
          if ('user_vote' in entry) require([null, 'like', 'dislike'].includes(entry.user_vote));
          if ('user_reaction' in entry) require([null, 'like', 'dislike'].includes(entry.user_reaction));
        }
      }
    }
  }
  function mergeProgress(a, b, key, base) {
    try {
      const left = JSON.parse(a), right = JSON.parse(b);
      if (key === 'ebm_socratic_state_v1' && object(left) && object(right)) {
        let previous;
        try { previous = JSON.parse(base); } catch (_) {}
        const pillars = {...left};
        for (const [id, record] of Object.entries(right)) {
          if (!previous || JSON.stringify(record) !== JSON.stringify(previous[id])) pillars[id] = record;
        }
        return JSON.stringify(pillars);
      }
      if (object(left) && object(right) || Array.isArray(left) && Array.isArray(right)) return JSON.stringify(merge(left, right));
    } catch (_) {}
    return b;
  }
  function reconcile(base, local, latest) {
    const next = {...latest, progress: {...latest.progress}};
    if (local.display_name !== base.display_name) next.display_name = local.display_name;
    const unread = new Set(base.read_ids.filter(id => !local.read_ids.includes(id)));
    next.read_ids = [...new Set([...latest.read_ids.filter(id => !unread.has(id)), ...local.read_ids.filter(id => !base.read_ids.includes(id))])];
    const removed = new Set(base.bookmarked_ids.filter(id => !local.bookmarked_ids.includes(id)));
    const added = local.bookmarked_ids.filter(id => !base.bookmarked_ids.includes(id));
    next.bookmarked_ids = [...new Set([...latest.bookmarked_ids.filter(id => !removed.has(id)), ...added])];
    for (const key of new Set([...Object.keys(base.progress), ...Object.keys(local.progress)])) {
      if (local.progress[key] === base.progress[key]) continue;
      if (!(key in local.progress)) delete next.progress[key];
      else next.progress[key] = latest.progress[key] === base.progress[key] ? local.progress[key] : mergeProgress(latest.progress[key], local.progress[key], key, base.progress[key]);
    }
    return next;
  }
  function create(storage, cryptoSource = globalThis.crypto, lang = 'vi') {
    const read = key => { try { return storage.getItem(key); } catch (_) { return null; } };
    let p;
    try { p = validate(JSON.parse(read(KEY))); } catch (_) {}
    let baseline = p && JSON.parse(JSON.stringify(p));
    const persist = (replace = false, importing = false) => {
      try {
        let latest;
        try { latest = validate(JSON.parse(read(KEY))); } catch (_) {}
        const next = !replace && baseline && latest?.device_id === p.device_id ? reconcile(baseline, p, latest) : p;
        if (importing) {
          next.progress.ebm_legacy_server_migrated = '1';
          if (latest?.device_id === p.device_id && latest.progress.ebm_device_server_synced === '1') {
            next.progress.ebm_device_server_synced = '1';
          }
        }
        storage.setItem(KEY, JSON.stringify(next));
        p = next; baseline = JSON.parse(JSON.stringify(p));
        return true;
      } catch (_) { return false; }
    };
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
          if (learningKeys.has(key)) p.progress[key] = read(key);
        }
      } catch (_) {}
      for (const key of localHistoryKeys) {
        const raw = read(key);
        if (raw === null) continue;
        try {
          validateProgress({[key]: raw});
          p.progress[key] = raw;
        } catch (_) {}
      }
      const collect = value => {
        if (!object(value)) return;
        for (const key of ['read_ids', 'bookmarked_ids']) if (Array.isArray(value[key])) p[key] = [...new Set([...p[key], ...value[key].filter(x => typeof x === 'string')])];
      };
      let active;
      try {
        const users = JSON.parse(read('ebm_cloud_users_db'));
        validateTree(users);
        active = users?.[read('ebm_cloud_current_user')];
      } catch (_) {}
      if (object(active)) {
        delete p.progress.ebm_offline_user_activity;
        collect(active);
        const fields = {streak: 'ebm_streak', quiz: 'ebm_quiz_progress', language: 'ebm_ui_lang', ui_prefs: 'ebm_ui_prefs'};
        for (const [field, key] of Object.entries(fields)) if (active[field] !== undefined) {
          p.progress[key] = typeof active[field] === 'string' ? active[field] : JSON.stringify(learningData(active[field]));
        }
        if (object(active.progress)) for (const [key, value] of Object.entries(active.progress)) if (learningKeys.has(key)) {
          p.progress[key] = typeof value === 'string' ? value : JSON.stringify(learningData(value));
        }
        try { collect(JSON.parse(read('ebm_progress_by_user'))?.[read('ebm_cloud_current_user')]); } catch (_) {}
      } else {
        try { collect(JSON.parse(p.progress.ebm_offline_user_activity)); } catch (_) {}
      }
      p.progress = portableProgress(p.progress);
      persist();
    }
    const snapshot = (adopt = false) => {
      let current = p;
      try {
        const latest = validate(JSON.parse(read(KEY)));
        if (baseline && latest.device_id === p.device_id) {
          current = reconcile(baseline, p, latest);
          if (adopt) {
            p = current;
            baseline = JSON.parse(JSON.stringify(latest));
          }
        }
      } catch (_) {}
      return JSON.parse(JSON.stringify(current));
    };
    return {
      get profile() { return JSON.parse(JSON.stringify(p)); },
      snapshot() { return snapshot(true); },
      get(key) { return p.progress[key] ?? null; },
      set(key, value) { if (!owned(key)) return; p.progress[key] = String(value); persist(); },
      remove(key) { delete p.progress[key]; persist(); },
      activity(readIds, savedIds) { p.read_ids = [...new Set(readIds)]; p.bookmarked_ids = [...new Set(savedIds)]; persist(); },
      rename(name) { name = String(name).trim(); if (!name || name.length > 100) throw new Error('Invalid name'); p.display_name = name; p.progress.ebm_display_name_chosen = '1'; persist(); },
      exportJSON() {
        const {version, created_at, read_ids, bookmarked_ids, progress} = snapshot();
        let {display_name} = snapshot();
        if (progress.ebm_display_name_chosen !== '1') {
          for (const raw of [read('ebm_cloud_users_db'), progress.ebm_legacy_users_progress]) {
            try {
              const users = JSON.parse(raw);
              if (object(users) && Object.values(users).some(user => object(user) && [user.display_name, user.full_name].includes(display_name))) {
                display_name = progress.ebm_ui_lang === 'en' ? 'Doctor' : 'Bác sĩ';
              }
            } catch (_) {}
          }
        }
        return JSON.stringify({version, display_name, created_at, read_ids, bookmarked_ids, progress: portableProgress(progress)}, null, 2);
      },
      importJSON(text, mode = 'merge') {
        if (typeof text !== 'string' || text.length > 5 * 1024 * 1024 || !['merge','replace'].includes(mode)) throw new Error('Invalid import');
        const parsed = JSON.parse(text);
        if (parsed?.device_id !== undefined && !uuid.test(parsed.device_id)) throw new Error('Invalid legacy device ID');
        const incoming = validate({...parsed, device_id: p.device_id});
        for (const key of syncKeys) delete incoming.progress[key];
        validateProgress(incoming.progress);
        const next = mode === 'merge' ? merge(p, incoming) : incoming;
        if (mode === 'merge') for (const key of Object.keys(incoming.progress)) next.progress[key] = mergeProgress(p.progress[key], incoming.progress[key], key);
        const previous = p;
        p = {...next, device_id: p.device_id, created_at: p.created_at};
        if (!persist(mode === 'replace', true)) {
          p = previous;
          const error = new Error('Progress could not be saved to browser storage');
          error.code = 'STORAGE_WRITE_FAILED';
          throw error;
        }
        try { storage.removeItem('ebm_auth_token'); } catch (_) {}
      }
    };
  }
  return {create, KEY};
})();
if (typeof module !== 'undefined') module.exports = DeviceProfile;
