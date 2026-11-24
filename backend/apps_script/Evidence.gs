function installEvidenceTrigger() {
  const lock = LockService.getUserLock();
  lock.waitLock(5000);
  try {
    const handler = 'dispatchStaleHeartSnapshots_';
    if (!ScriptApp.getProjectTriggers().some(trigger => trigger.getHandlerFunction() === handler)) {
      ScriptApp.newTrigger(handler).timeBased().everyHours(1).create();
    }
  } finally {
    lock.releaseLock();
  }
}

function dispatchStaleHeartSnapshots_() {
  const now = new Date();
  if (now.getUTCHours() >= 6) return;
  const lock = LockService.getUserLock();
  if (!lock.tryLock(1000)) return;
  try {
    const token = PropertiesService.getScriptProperties().getProperty('GITHUB_DISPATCH_TOKEN');
    if (!token || !token.trim()) {
      console.warn('Evidence watchdog: GITHUB_DISPATCH_TOKEN is not configured.');
      return;
    }
    const repo = 'ledinhduy281/daily-learning-heart';
    const targets = [{
      workflow: 'evidence_pipeline.yml',
      url: 'https://ledinhduy281.github.io/daily-learning-heart/data/pipeline/briefing.json',
      field: 'date',
      date: now.toISOString().slice(0, 10)
    }, {
      workflow: 'daily_refresh.yml',
      url: 'https://raw.githubusercontent.com/' + repo + '/main/data/rotation_state.json',
      field: 'last_updated',
      date: Utilities.formatDate(now, 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd')
    }];
    for (const target of targets) {
      if (heartSnapshotIsCurrent_(target, now.getTime())) continue;
      try {
        const response = UrlFetchApp.fetch(
          'https://api.github.com/repos/' + repo + '/actions/workflows/' + target.workflow + '/dispatches',
          {
            method: 'post',
            contentType: 'application/json',
            headers: {
              Authorization: 'Bearer ' + token.trim(),
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28'
            },
            payload: JSON.stringify({ref: 'main'}),
            followRedirects: false,
            muteHttpExceptions: true
          }
        );
        const status = response.getResponseCode();
        if (status < 200 || status >= 300) {
          console.warn('Evidence watchdog: ' + target.workflow + ' dispatch returned HTTP ' + status + '.');
        } else {
          console.log('Evidence watchdog: requested ' + target.workflow + '.');
        }
      } catch (_) {
        console.warn('Evidence watchdog: could not dispatch ' + target.workflow + '.');
      }
    }
  } finally {
    lock.releaseLock();
  }
}

function heartSnapshotIsCurrent_(target, timestamp) {
  try {
    const response = UrlFetchApp.fetch(target.url + '?watchdog=' + timestamp, {muteHttpExceptions: true});
    if (response.getResponseCode() !== 200) return false;
    return JSON.parse(response.getContentText())[target.field] === target.date;
  } catch (_) {
    return false;
  }
}
