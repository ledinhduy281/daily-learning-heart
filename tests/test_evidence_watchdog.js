const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../backend/apps_script/Evidence.gs'), 'utf8');

const evidenceDate = '2026-11-24';
const calls = [];
const warnings = [];
const triggers = [];
let hour = 2;
let token = 'test-dispatch-token';
let lockAvailable = true;
let locks = 0;
let sourceDates = {};
let dispatchResults = {};
const context = vm.createContext({
  Date: class extends Date {
    constructor() { super(Date.UTC(2026, 10, 24, hour)); }
  },
  Utilities: {
    formatDate(date, zone, format) {
      assert.equal(zone, 'Asia/Ho_Chi_Minh');
      assert.equal(format, 'yyyy-MM-dd');
      return new Date(date.getTime() + 7 * 3600000).toISOString().slice(0, 10);
    }
  },
  LockService: {
    getUserLock: () => ({
      tryLock: () => lockAvailable && ++locks,
      waitLock: () => ++locks,
      releaseLock: () => --locks
    })
  },
  ScriptApp: {
    getProjectTriggers: () => triggers,
    newTrigger: handler => ({timeBased: () => ({everyHours: interval => {
      assert.equal(interval, 1);
      return {create: () => triggers.push({getHandlerFunction: () => handler})};
    }})})
  },
  PropertiesService: {getScriptProperties: () => ({getProperty: name => {
    assert.equal(name, 'GITHUB_DISPATCH_TOKEN');
    return token;
  }})},
  console: {warn: warning => warnings.push(warning), log: () => {}},
  UrlFetchApp: {fetch(url, options) {
    calls.push({url, options});
    let result;
    if (options.method === 'post') {
      const workflow = url.split('/').at(-2);
      result = dispatchResults[workflow] ?? 204;
      if (result instanceof Error) throw result;
    } else {
      assert.match(url, /\?watchdog=\d+$/);
      assert.equal(options.headers, undefined, 'credentials never go to public freshness URLs');
      const evidence = url.includes('briefing.json');
      const date = sourceDates[evidence ? 'evidence' : 'pillar'];
      if (date instanceof Error) throw date;
      if (typeof date === 'number') return {getResponseCode: () => date};
      return {getResponseCode: () => 200, getContentText: () => date === null ? '<invalid' :
        JSON.stringify({[evidence ? 'date' : 'last_updated']: date})};
    }
    return {getResponseCode: () => result};
  }}
});
vm.runInContext(source, context);

function check({expected = [], gets = 2} = {}) {
  calls.length = 0;
  warnings.length = 0;
  context.dispatchStaleHeartSnapshots_();
  const posts = calls.filter(entry => entry.options.method === 'post');
  assert.equal(calls.length - posts.length, gets);
  assert.deepEqual(posts.map(entry => entry.url.split('/').at(-2)), expected);
  for (const {url, options} of posts) {
    assert.match(url, /^https:\/\/api\.github\.com\/repos\/ledinhduy281\/daily-learning-heart\/actions\/workflows\//);
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    assert.deepEqual(JSON.parse(options.payload), {ref: 'main'});
    assert.equal(options.followRedirects, false);
  }
  assert.equal(locks, 0);
}

context.installEvidenceTrigger();
context.installEvidenceTrigger();
assert.equal(triggers.length, 1);
assert.equal(triggers[0].getHandlerFunction(), 'dispatchStaleHeartSnapshots_');
sourceDates = {evidence: evidenceDate, pillar: evidenceDate};
check();
hour = 6;
check({gets: 0});
hour = 23;
check({gets: 0});
hour = 0;
sourceDates.evidence = '2026-11-23';
check({expected: ['evidence_pipeline.yml']});
sourceDates = {evidence: evidenceDate, pillar: '2026-11-23'};
check({expected: ['daily_refresh.yml']});
sourceDates = {evidence: null, pillar: new Error('network unavailable')};
dispatchResults = {'evidence_pipeline.yml': new Error('secret value should never be logged'), 'daily_refresh.yml': 403};
check({expected: ['evidence_pipeline.yml', 'daily_refresh.yml']});
assert.match(warnings.join(' '), /could not dispatch evidence_pipeline\.yml.*HTTP 403/);
assert.doesNotMatch(warnings.join(' '), /secret value|test-dispatch-token/);
sourceDates = {evidence: 404, pillar: evidenceDate};
check({expected: ['evidence_pipeline.yml']});
token = '';
check({gets: 0});
assert.match(warnings[0], /not configured/);
lockAvailable = false;
check({gets: 0});
console.log('Apps Script watchdog window, installation, freshness, independent dispatch, and safe errors: OK');
