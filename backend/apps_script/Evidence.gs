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
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const properties = PropertiesService.getScriptProperties();
    const token = properties.getProperty('GITHUB_DISPATCH_TOKEN');
    if (!token || !token.trim()) {
      console.warn('Evidence watchdog: GITHUB_DISPATCH_TOKEN is not configured.');
      return;
    }
    const repo = 'ledinhduy281/daily-learning-heart';
    const headers = {
      Authorization: 'Bearer ' + token.trim(),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
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
      const daily = target.workflow === 'daily_refresh.yml';
      const snapshot = heartSnapshot_(target.url, now.getTime());
      if (snapshot && snapshot[target.field] === target.date &&
          (!daily || !heartQuizSetsMissing_(snapshot, target.date, now.getTime()))) continue;
      const workflowUrl = 'https://api.github.com/repos/' + repo + '/actions/workflows/' + target.workflow;
      try {
        if (daily && !reserveHeartQuizDispatch_(workflowUrl, headers, target.date, properties)) continue;
        const response = UrlFetchApp.fetch(
          workflowUrl + '/dispatches',
          {
            method: 'post',
            contentType: 'application/json',
            headers: headers,
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

function heartSnapshot_(url, timestamp) {
  try {
    const response = UrlFetchApp.fetch(url + '?watchdog=' + timestamp, {muteHttpExceptions: true});
    return response.getResponseCode() === 200 ? JSON.parse(response.getContentText()) : null;
  } catch (_) {
    return null;
  }
}

function heartQuizSetsMissing_(rotation, date, timestamp) {
  if (!Number.isInteger(rotation.today_pillar_id) || rotation.today_pillar_id < 1) return false;
  const lessonId = 'ebm-' + date + '-p' + rotation.today_pillar_id + '-focused';
  try {
    const response = UrlFetchApp.fetch(
      'https://ledinhduy281.github.io/daily-learning-heart/data/quiz_sets.js?watchdog=' + timestamp,
      {muteHttpExceptions: true}
    );
    if (response.getResponseCode() !== 200) return false;
    const assignment = response.getContentText().match(/^\s*(?:\/\*[\s\S]*?\*\/\s*)?window\.EBM_QUIZ_SETS\s*=\s*({[\s\S]*});\s*$/);
    const sets = assignment && JSON.parse(assignment[1]).sets;
    if (!sets || typeof sets !== 'object' || Array.isArray(sets)) return false;
    const packs = sets[lessonId];
    return packs === undefined || (Array.isArray(packs) && packs.length < 3);
  } catch (_) {
    return false;
  }
}

function reserveHeartQuizDispatch_(workflowUrl, headers, date, properties) {
  const property = 'HEART_QUIZ_DISPATCH_ATTEMPTS';
  const [lastDate, count] = (properties.getProperty(property) || '').split(':');
  const attempts = lastDate === date ? Number(count) || 0 : 0;
  if (attempts >= 3) return false;
  const response = UrlFetchApp.fetch(workflowUrl + '/runs?branch=main&per_page=100', {
    headers: headers,
    followRedirects: false,
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    console.warn('Evidence watchdog: daily_refresh.yml run status returned HTTP ' + response.getResponseCode() + '.');
    return false;
  }
  const runs = JSON.parse(response.getContentText()).workflow_runs;
  if (!Array.isArray(runs) || runs.some(run => run.status !== 'completed')) return false;
  properties.setProperty(property, date + ':' + (attempts + 1));
  return true;
}
