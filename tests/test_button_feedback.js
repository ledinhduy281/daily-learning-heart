const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const DeviceProfile = require('../device_profile.js');

const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const cloudSource = fs.readFileSync(require.resolve('../cloud_sync.js'), 'utf8');
const inline = name => html.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n    \\}`))[0];
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(lang) {
  const timers = new Map(), values = new Map(), elements = new Map(), calls = [];
  let timerId = 0, failure = '', lastSignal;
  const storage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', handlers: {}, classList: {toggle() {}},
      setAttribute() {}, addEventListener(event, handler) {this.handlers[event] = handler;}
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    AbortController, TextEncoder, URL, localStorage: storage,
    deviceStore: DeviceProfile.create(storage, webcrypto),
    window: {EBM_SYNC_ENDPOINT: 'https://sync.test/exec', addEventListener() {}},
    document: {getElementById: element},
    Dom: {profileDeviceId: element('profileDeviceId')}, App: {currentLang: lang},
    location: {href: 'https://app.test/'}, refreshCloudProfile() {}, refreshDeviceActivity() {},
    setTimeout(fn, ms) {timers.set(++timerId, {fn, ms}); return timerId;},
    clearTimeout: id => timers.delete(id),
    fetch: async (_url, {body, signal}) => {
      const {action} = JSON.parse(body);
      calls.push(action);
      lastSignal = signal;
      const stall = () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true}));
      if (failure === 'network') throw new TypeError('offline');
      if (failure === 'pull' && action === 'pull') return stall();
      return {ok: true, text: () => failure === 'body' && action === 'restore_request' ? stall() :
        JSON.stringify({ok: true, profile: null, revision: 0})};
    }
  });
  vm.runInContext(cloudSource, context);
  vm.runInContext(`let cloudSync = null, cloudEmailAction = "backup", cloudEmailStatus = "", cloudStatus = "";
    ${['renderCloudSync', 'submitCloudEmail', 'initializeCloudSync'].map(inline).join('\n')};
    initializeCloudSync();`, context);
  const input = element('cloudEmail'), button = element('btnCloudEmail'), status = element('cloudEmailStatus');
  const submit = () => element('cloudEmailPanel').handlers.submit({preventDefault() {}});
  const restore = () => element('cloudRestoreTab').handlers.click();
  const expire = () => {
    const [id, {fn, ms}] = [...timers].at(-1);
    assert.equal(ms, 30000);
    timers.delete(id);
    fn();
  };
  return {context, input, button, status, submit, restore, expire, calls, timers,
    set failure(mode) {failure = mode;}, get signal() {return lastSignal;}};
}

async function checkEmail() {
  const vi = setup('vi');
  vi.input.value = 'test@example.test';
  vi.failure = 'pull';
  const pending = vi.submit();
  assert.equal(vi.button.disabled, true);
  assert.match(vi.button.textContent, /Đang gửi/);
  assert.match(vi.status.textContent, /Đang yêu cầu/);
  await vi.submit();
  await flush();
  assert.deepEqual(vi.calls, ['pull']);
  vi.expire();
  await pending;
  assert.equal(vi.signal.aborted, true);
  assert.equal(vi.button.disabled, false);
  assert.match(vi.status.textContent, /kiểm tra hộp thư/);
  assert.equal(vi.input.value, 'test@example.test');
  vi.failure = '';
  await vi.submit();
  assert.deepEqual(vi.calls, ['pull', 'pull', 'push', 'backup']);
  assert.match(vi.status.textContent, /Nếu có thể/);
  assert.equal(vi.button.disabled, false);
  assert.equal(vi.input.value, '');
  assert.equal(vi.timers.size, 0);

  const en = setup('en');
  en.restore();
  en.input.value = 'test@example.test';
  en.failure = 'network';
  await en.submit();
  assert.match(en.status.textContent, /Could not request/);
  assert.equal(en.button.disabled, false);
  assert.match(en.button.textContent, /restore link/);
  en.failure = 'body';
  const reading = en.submit();
  await flush();
  assert.match(en.status.textContent, /Requesting an email link/);
  en.expire();
  await reading;
  assert.equal(en.signal.aborted, true);
  assert.equal(en.button.disabled, false);
  assert.match(en.status.textContent, /Check your inbox/);
  en.input.value = 'test@example';
  await en.submit();
  assert.match(en.status.textContent, /valid email address/);
  assert.deepEqual(en.calls, ['restore_request', 'restore_request']);
}

async function checkQueuedEmail() {
  const app = setup('en');
  app.failure = 'pull';
  app.input.value = 'test@example.test';
  const backup = vm.runInContext('cloudSync.email("backup", "other@example.test").catch(() => {})', app.context);
  await flush();
  app.restore();
  const waiting = app.submit();
  app.expire();
  await waiting;
  assert.equal(app.button.disabled, false);
  assert.match(app.status.textContent, /took too long/);
  assert.equal(app.signal.aborted, false);
  app.expire();
  await backup;
  await flush();
  assert.deepEqual(app.calls, ['pull']);
}

async function checkRefresh() {
  for (const mode of ['static', 'stream']) {
    const Dom = {btnRefreshToday: {}, iconRefreshToday: {classList: {add() {}, remove() {}}}, labelRefreshToday: {}};
    const toasts = [];
    let finish;
    const gate = new Promise(resolve => {finish = resolve;});
    const refresh = vm.runInNewContext(`(${inline('refreshTodayData')})`, {
      Dom, App: {currentLang: 'en', serverAvailable: mode === 'stream'}, window: {ReadableStream: true},
      document: {getElementById: () => null}, isFileOrigin: () => false,
      t: key => key, tt: key => key, showToast: message => toasts.push(message), setTimeout() {},
      reloadSeedBriefingsScript: () => gate, getScheduledCycleDate() {}, computeRotationPillarsFromDate() {},
      renderDailyRotationBanner() {}, renderPillarHistory() {}, getTodaySingleBriefing() {},
      consumeApiEvents: async (_url, onMessage) => {await gate; await onMessage({data: 'malformed stream event'});}
    });
    const pending = refresh();
    assert.equal(Dom.btnRefreshToday.disabled, true);
    assert.match(Dom.labelRefreshToday.textContent, /updatingLabel/);
    finish(false);
    await pending;
    assert.equal(Dom.btnRefreshToday.disabled, false);
    assert.equal(Dom.labelRefreshToday.textContent, 'refreshBtn');
    assert.deepEqual(toasts, [mode === 'stream' ? 'toastStreamLost' : 'toastUpdateError']);
  }
}

(async () => {
  await checkEmail();
  await checkQueuedEmail();
  await checkRefresh();
  console.log('Button feedback: bilingual email progress, network/body/queue timeout, retry, and refresh failure recovery: OK');
})().catch(error => {console.error(error); process.exitCode = 1;});
