/* No external services: this script uses the owner's free Sheets and Mail quotas. */
var SYNC_LIMITS = {bytes: 256 * 1024, cooldown: 10 * 60 * 1000, daily: 70, records: 5000, pending: 200};
var SYNC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var SYNC_GENERIC = {ok: true, message: 'If a backup is available, a link will be emailed to that address.'};

function syncFingerprint(email, pepper, hmac) {
  if (!pepper) throw new Error('Set PEPPER before deploying');
  return hmac(String(email).trim().toLowerCase(), pepper);
}
function syncCanMail(now, emailTime, idTime, count, remaining) {
  return (!emailTime || now - emailTime >= SYNC_LIMITS.cooldown) &&
    (!idTime || now - idTime >= SYNC_LIMITS.cooldown) && count < SYNC_LIMITS.daily && remaining > 0;
}
function syncValidateProfile(p, byteLength) {
  if (!p || p.version !== 1 || typeof p.display_name !== 'string' || !p.display_name.trim() || p.display_name.length > 100 ||
      typeof p.created_at !== 'string' || !isFinite(Date.parse(p.created_at)) || !p.progress || Array.isArray(p.progress) || typeof p.progress !== 'object' ||
      ['read_ids', 'bookmarked_ids'].some(function(k) { return !Array.isArray(p[k]) || p[k].some(function(id) { return typeof id !== 'string' || id.length > 500; }); }) ||
      Object.keys(p.progress).some(function(k) { return typeof p.progress[k] !== 'string'; }) ||
      Object.keys(p).some(function(k) { return ['version','display_name','created_at','read_ids','bookmarked_ids','progress'].indexOf(k) < 0; }) ||
      byteLength(JSON.stringify(p)) > SYNC_LIMITS.bytes) throw new Error('Invalid or oversized profile');
  return p;
}
function syncHandle(request, env) {
  var a = request.action, now = env.now(), generic = Object.assign({}, SYNC_GENERIC);
  if (a === 'confirm') {
    if (typeof request.token !== 'string' || !/^[a-f0-9]{64}$/.test(request.token)) return {ok:true,confirmed:false};
    var tokenHash = env.hash(request.token), pendingKey = 'pending:' + tokenHash, pending = env.get(pendingKey);
    if (!pending) return {ok:true,confirmed:false};
    var pointerKey = 'pending:e:' + pending.fingerprint, pointer = env.get(pointerKey);
    if (pending.expiresAt <= now) {
      env.set(pendingKey,null);
      if (pointer && pointer.tokenHash === tokenHash) env.set(pointerKey,null);
      return {ok:true,confirmed:false};
    }
    if (pending.tokenHash !== tokenHash || !pointer || pointer.tokenHash !== tokenHash) return {ok:true,confirmed:false};
    env.set('e:' + pending.fingerprint, {userId:pending.userId,verified:true});
    env.set(pendingKey, null);
    env.set(pointerKey, null);
    return {ok:true,confirmed:true};
  }
  if (['push','pull','backup','restore_request'].indexOf(a) < 0) throw new Error('Invalid action');
  var id = String(request.userId || '').toLowerCase();
  if (a !== 'restore_request' && !SYNC_UUID.test(id)) throw new Error('Invalid user ID');
  var key = id ? 'p:' + env.hash(id) : '', record = key ? env.get(key) : null;
  if (a === 'pull') return {ok: true, profile: record ? record.profile : null, revision: record ? record.revision : 0};
  if (a === 'push') {
    syncValidateProfile(request.profile, env.bytes);
    var revision = record ? record.revision : 0;
    if (request.revision !== revision) return {ok: true, conflict: true, profile: record ? record.profile : null, revision: revision};
    env.set(key, {revision: revision + 1, profile: request.profile});
    return {ok: true, revision: revision + 1};
  }
  var email = String(request.email || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return generic;
  var fingerprint = syncFingerprint(email, env.pepper, env.hmac), emailKey = 'e:' + fingerprint;
  if (a === 'restore_request') {
    var active = env.get(emailKey);
    id = active && active.verified === true ? active.userId : null;
  }
  if (!id || !SYNC_UUID.test(id) || !env.get('p:' + env.hash(id))) return generic;
  var dayKey = 'day:' + new Date(now).toISOString().slice(0,10), emailRate = 'rate:e:' + fingerprint, idRate = 'rate:i:' + env.hash(id);
  if (!syncCanMail(now, env.get(emailRate), env.get(idRate), env.get(dayKey) || 0, env.remaining())) return generic;
  var parameter = 'restore=' + encodeURIComponent(id);
  if (a === 'backup') {
    var token = env.random(), hashed = env.hash(token);
    var oldPending = env.get('pending:e:' + fingerprint);
    if (oldPending && oldPending.tokenHash) env.set('pending:' + oldPending.tokenHash,null);
    env.set('pending:' + hashed, {fingerprint:fingerprint,userId:id,tokenHash:hashed,expiresAt:now + 24*60*60*1000});
    env.set('pending:e:' + fingerprint, {tokenHash:hashed,expiresAt:now + 24*60*60*1000});
    parameter = 'email_confirm=' + token;
  }
  env.set(emailRate, now); env.set(idRate, now); env.set(dayKey, (env.get(dayKey) || 0) + 1);
  var link = env.site + (env.site.indexOf('?') < 0 ? '?' : '&') + parameter;
  env.mail(email, request.lang === 'vi' ? 'Khôi phục tiến độ Xem Tim Mỗi Ngày' : 'Restore your Daily Learning Heart progress',
    (a === 'backup' ? 'Chỉ xác nhận nếu chính bạn yêu cầu liên kết email với mã này (hết hạn sau 24 giờ):\nOnly confirm if you requested linking your email to this ID (expires in 24 hours):\n' + id + '\n' : 'Khôi phục và hợp nhất tiến độ trên thiết bị này:\nRestore and merge your progress on this device:\n') + link +
    '\n\nAi có liên kết này đều có thể đọc và đồng bộ tiến độ của bạn. Chỉ mở trên thiết bị tin cậy. Nếu không yêu cầu, hãy bỏ qua email này.\nAnyone with this link can read and sync your progress. Open it only on a trusted device. If you did not request this, ignore this email.');
  return generic;
}
function syncSheetStore() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('SYNC_SHEET_ID'), sheet, cleaned = false;
  if (!id) {
    var book = SpreadsheetApp.create('Daily Learning Heart private sync');
    props.setProperty('SYNC_SHEET_ID', book.getId()); sheet = book.getSheets()[0];
    sheet.appendRow(['key','json chunks (private)']);
  } else sheet = SpreadsheetApp.openById(id).getSheets()[0];
  function row(key) {
    if (sheet.getLastRow() < 2) return null;
    var found = sheet.getRange(2,1,sheet.getLastRow()-1,1).createTextFinder(key).matchEntireCell(true).useRegularExpression(false).findNext();
    return found ? found.getRow() : null;
  }
  return {
    get: function(key) { var r = row(key); return r ? JSON.parse(Utilities.newBlob(Utilities.base64Decode(sheet.getRange(r,2,1,12).getValues()[0].join(''))).getDataAsString('UTF-8')) : null; },
    set: function(key,value) {
      if (!cleaned && sheet.getLastRow() > 1) {
        var count = sheet.getLastRow()-1, keys = sheet.getRange(2,1,count,1).getValues(), expiry = sheet.getRange(2,14,count,1).getValues();
        for (var j=count-1;j>=0;j--) if (String(keys[j][0]).indexOf('pending:') === 0 && (!Number(expiry[j][0]) || Number(expiry[j][0]) <= Date.now())) sheet.deleteRow(j+2);
      }
      cleaned = true;
      var existing = row(key);
      if (value === null) { if (existing) sheet.deleteRow(existing); return; }
      if (!existing && key.indexOf('pending:') === 0 && sheet.getLastRow() > 1) {
        var pendingCount = sheet.getRange(2,1,sheet.getLastRow()-1,1).getValues().filter(function(r) { return String(r[0]).indexOf('pending:') === 0; }).length;
        if (pendingCount >= SYNC_LIMITS.pending) throw new Error('Too many pending confirmations');
      }
      var r = row(key), text = Utilities.base64Encode(JSON.stringify(value), Utilities.Charset.UTF_8), chunks = [];
      if (!r && sheet.getLastRow() >= SYNC_LIMITS.records) throw new Error('Sync storage is full');
      for (var i=0;i<12;i++) chunks.push(text.slice(i*30000,(i+1)*30000));
      sheet.getRange(r || sheet.getLastRow()+1,1,1,14).setValues([[key].concat(chunks,[key.indexOf('pending:') === 0 ? value.expiresAt : ''])]);
    }
  };
}
function doPost(event) {
  var lock, result, request;
  try {
    var body = event.postData.contents;
    if (Utilities.newBlob(body).getBytes().length > SYNC_LIMITS.bytes + 4096) throw new Error('Request too large');
    request = JSON.parse(body);
    if (request && request.action === 'chat' && typeof chatHandle_ === 'function') return chatHandle_(request);
    lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) throw new Error('Busy');
    var props = PropertiesService.getScriptProperties(), pepper = props.getProperty('PEPPER');
    if (!pepper) throw new Error('Not configured');
    var store = syncSheetStore();
    function hex(bytes) { return bytes.map(function(b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join(''); }
    result = syncHandle(request, {
      get: store.get, set: store.set, pepper: pepper, now: Date.now,
      hash: function(value) { return hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)); },
      hmac: function(value,key) { return hex(Utilities.computeHmacSha256Signature(value,key,Utilities.Charset.UTF_8)); },
      bytes: function(value) { return Utilities.newBlob(value).getBytes().length; },
      random: function() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g,'').toLowerCase(); },
      remaining: function() { return MailApp.getRemainingDailyQuota(); },
      mail: function(to,subject,body) { MailApp.sendEmail({to:to,subject:subject,body:body}); },
      site: props.getProperty('SITE_URL') || 'https://ledinhduy281.github.io/daily-learning-heart/'
    });
  } catch (_) { result = request && ['backup','restore_request'].indexOf(request.action) >= 0 ? Object.assign({},SYNC_GENERIC) : {ok:false,error:'Sync unavailable. Try again later.'}; }
  finally { if (lock && lock.hasLock()) lock.releaseLock(); }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
