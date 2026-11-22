const assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
const DeviceProfile=require('../device_profile.js');
const Cloud=require('../cloud_sync.js');
class Storage {
  constructor(){this.values=new Map();}get length(){return this.values.size;}key(i){return [...this.values.keys()][i];}
  getItem(k){return this.values.get(k)??null;}setItem(k,v){this.values.set(k,String(v));}removeItem(k){this.values.delete(k);}
}
const consented=options=>{options.storage.setItem(Cloud.CONSENT_KEY,'allowed');return Cloud.create(options);};
async function main() {
  const records=new Map(),calls=[],statuses=[];
  let poison=null,conflict=false,conflicts=[];
  const fetch=async(url,options)=>{
    assert.equal(options.method,'POST');assert.equal(options.headers['Content-Type'],'text/plain');
    const q=JSON.parse(options.body);calls.push(q);let result={ok:true};
    const row=records.get(q.userId)||{profile:null,revision:0};
    if(q.action==='pull')result={...result,...row,profile:poison||row.profile};
    if(q.action==='confirm')result.confirmed=q.token==='a'.repeat(64);
    if(q.action==='push') {
      if(conflicts.length) {conflicts.shift()(row.profile);row.revision++;records.set(q.userId,row);}
      if(conflict){conflict=false;row.revision++;row.profile.read_ids.push('concurrent');records.set(q.userId,row);}
      if(q.revision!==row.revision)result={...result,...row,conflict:true};
      else {records.set(q.userId,{profile:q.profile,revision:row.revision+1});result.revision=row.revision+1;}
    }
    return {ok:true,text:async()=>JSON.stringify(result)};
  };
  const storage=new Storage(),profile=DeviceProfile.create(storage,webcrypto);
  const disabled=Cloud.create({profile,storage,fetch});
  assert.equal(disabled.enabled,false);
  await disabled.start({url:'https://example.test/',confirm:()=>true,replaceUrl:()=>{}});
  await assert.rejects(async()=>disabled.restore(profile.profile.device_id),/NOT_CONFIGURED/);
  assert.equal(calls.length,0);disabled.stop();
  let stripped='';
  await assert.rejects(disabled.start({url:'https://example.test/?restore='+profile.profile.device_id,confirm:()=>true,replaceUrl:url=>stripped=url}),/NOT_CONFIGURED/);
  assert.equal(stripped,'https://example.test/');
  const c=consented({profile,storage,endpoint:'https://sync.test/exec',fetch,onStatus:s=>statuses.push(s),delay:5});
  await c.sync();assert.equal(calls.filter(c=>c.action==='push').length,0);
  profile.activity(['local'],['saved']);
  await new Promise(resolve=>setTimeout(resolve,30));await c.sync();
  assert.ok(records.get(c.userId).profile.read_ids.includes('local'));
  assert.ok(!('device_id' in records.get(c.userId).profile));
  const otherStorage=new Storage(),otherProfile=DeviceProfile.create(otherStorage,webcrypto);
  otherProfile.activity(['other'],[]);
  const other=Cloud.create({profile:otherProfile,storage:otherStorage,endpoint:'https://sync.test/exec',fetch,onStatus:s=>statuses.push(s)});
  await other.restore(c.userId);
  assert.equal(other.userId,c.userId);assert.notEqual(otherProfile.profile.device_id,c.userId);
  assert.deepEqual(new Set(otherProfile.profile.read_ids),new Set(['local','other']));
  assert.ok(!otherProfile.exportJSON().includes(c.userId));
  conflict=true;await c.sync();assert.ok(profile.profile.read_ids.includes('concurrent'));
  assert.ok(profile.profile.read_ids.includes('other'));
  let replaced='',asked=0;
  await other.start({url:'https://example.test/?restore='+c.userId+'&keep=1',confirm:()=>{asked++;return true;},replaceUrl:u=>replaced=u});
  assert.equal(asked,1);assert.equal(replaced,'https://example.test/?keep=1');
  const previous=other.userId;
  const missing='00000000-0000-4000-8000-000000000000';
  const missingBefore={profile:otherProfile.exportJSON(),id:otherStorage.getItem(Cloud.ID_KEY),base:otherStorage.getItem('dlh_sync_baseline_v1'),pushes:calls.filter(q=>q.action==='push').length};
  await assert.rejects(other.restore(missing),/BACKUP_NOT_FOUND/);
  assert.equal(statuses.at(-1),'BACKUP_NOT_FOUND');
  assert.equal(other.userId,previous);assert.equal(otherProfile.exportJSON(),missingBefore.profile);
  assert.equal(otherStorage.getItem(Cloud.ID_KEY),missingBefore.id);
  assert.equal(otherStorage.getItem('dlh_sync_baseline_v1'),missingBefore.base);
  assert.equal(calls.filter(q=>q.action==='push').length,missingBefore.pushes);
  await assert.rejects(other.start({url:'https://example.test/?restore='+missing,confirm:()=>true,replaceUrl:u=>replaced=u}),/BACKUP_NOT_FOUND/);
  assert.equal(replaced,'https://example.test/');assert.equal(other.userId,previous);
  await other.start({url:'https://example.test/?restore='+profile.profile.device_id,confirm:()=>false,replaceUrl:u=>replaced=u});
  assert.equal(other.userId,previous);assert.ok(!replaced.includes('restore='));
  assert.throws(()=>other.restore('bad'),/INVALID_ID/);
  await assert.rejects(other.start({url:'https://example.test/?restore=bad',confirm:()=>{throw Error('must not confirm');},replaceUrl:u=>replaced=u}),/INVALID_ID/);
  assert.ok(!replaced.includes('restore='));
  const confirmCalls=calls.length;
  await other.start({url:'https://example.test/?email_confirm='+'a'.repeat(64)+'&restore='+c.userId,confirm:()=>assert.fail('Email confirmation must not adopt an ID'),replaceUrl:u=>replaced=u});
  assert.equal(statuses.at(-1),'EMAIL_CONFIRMED');
  assert.equal(calls.length,confirmCalls+1);assert.equal(calls.at(-1).action,'confirm');
  assert.equal(other.userId,previous);assert.equal(replaced,'https://example.test/');
  await other.start({url:'https://example.test/?email_confirm='+'b'.repeat(64),replaceUrl:u=>replaced=u});
  assert.equal(statuses.at(-1),'EMAIL_CONFIRM_INVALID');assert.equal(replaced,'https://example.test/');
  assert.deepEqual(await other.email('restore_request','unknown@example.com'),{ok:true});
  assert.deepEqual(await other.email('restore_request','known@example.com'),{ok:true});
  await other.email('backup','known@example.com','en');assert.equal(calls.at(-1).action,'backup');
  await assert.rejects(other.email('restore_request','bad\nemail'),/INVALID_EMAIL/);
  const before=otherProfile.exportJSON(),idBefore=other.userId;
  for(const bad of [{version:1}, {...JSON.parse(before),progress:{soaica_chat_sessions_v1:'{}'}}, {...JSON.parse(before),progress:{ebm_ui_lang:'é'.repeat(140000)}}]) {
    poison=bad;await assert.rejects(other.restore(c.userId));
    assert.equal(otherProfile.exportJSON(),before);assert.equal(other.userId,idBefore);
  }
  poison=null;
  profile.set('ebm_ui_lang','é'.repeat(140000));await assert.rejects(c.sync(),/TOO_LARGE/);
  c.stop();other.stop();
  {
    const localStorage=new Storage(),local=DeviceProfile.create(localStorage,webcrypto);
    local.rename('Before');local.activity(['read'],['remove','keep']);
    local.set('ebm_socratic_state_v1',JSON.stringify({1:{correct_count:1},2:{correct_count:2}}));
    local.set('ebm_theme','dark');
    let merged=0;
    let sync=consented({profile:local,storage:localStorage,endpoint:'https://sync.test/exec',fetch,delay:60000,onMerged:()=>merged++});
    await sync.sync();
    local.rename('Local rename');local.activity(['read'],['keep']);local.remove('ebm_theme');
    local.set('ebm_socratic_state_v1',JSON.stringify({1:{correct_count:5},2:{correct_count:2}}));
    await sync.sync();
    assert.equal(local.profile.display_name,'Local rename');assert.deepEqual(local.profile.bookmarked_ids,['keep']);
    assert.equal(local.get('ebm_theme'),null);
    assert.equal(JSON.parse(local.get('ebm_socratic_state_v1'))[1].correct_count,5);
    assert.equal(merged,0);
    const row=records.get(sync.userId);
    row.revision++;row.profile.read_ids.push('another device');row.profile.bookmarked_ids.push('remote saved');
    row.profile.display_name='Remote rename';
    row.profile.progress.ebm_socratic_state_v1=JSON.stringify({1:{correct_count:6},2:{correct_count:8}});
    local.rename('Latest local rename');
    local.set('ebm_socratic_state_v1',JSON.stringify({1:{correct_count:9},2:{correct_count:2}}));
    await sync.sync();
    assert.equal(local.profile.display_name,'Latest local rename');
    assert.deepEqual(local.profile.bookmarked_ids,['keep','remote saved']);
    assert.ok(local.profile.read_ids.includes('another device'));
    assert.deepEqual(JSON.parse(local.get('ebm_socratic_state_v1')),{1:{correct_count:9},2:{correct_count:8}});
    assert.equal(merged,1);await sync.sync();assert.equal(merged,1);
    local.set('ebm_theme','initial');await sync.sync();
    const latest=records.get(sync.userId);
    latest.revision++;latest.profile.progress.ebm_theme='first remote';latest.profile.bookmarked_ids.push('temporary remote bookmark');
    local.rename('Keep this local rename');
    conflicts=[
      remote=>{remote.progress.ebm_theme='second remote';remote.bookmarked_ids=remote.bookmarked_ids.filter(id=>id!=='temporary remote bookmark');},
      remote=>{remote.progress.ebm_theme='third remote';remote.read_ids.push('third remote read');}
    ];
    await sync.sync();
    assert.equal(local.get('ebm_theme'),'third remote');
    assert.equal(local.profile.display_name,'Keep this local rename');
    assert.ok(!local.profile.bookmarked_ids.includes('temporary remote bookmark'));
    assert.ok(local.profile.read_ids.includes('third remote read'));
    sync.stop();
    local.rename('After reload');local.activity(local.profile.read_ids,[]);
    sync=consented({profile:local,storage:localStorage,endpoint:'https://sync.test/exec',fetch});
    await sync.sync();
    assert.equal(local.profile.display_name,'After reload');assert.deepEqual(local.profile.bookmarked_ids,[]);
    sync.stop();
  }
  {
    const storage=new Storage(),profile=DeviceProfile.create(storage,webcrypto);
    profile.activity(['large test'],[]);
    const sync=consented({profile,storage,endpoint:'https://sync.test/exec',fetch,delay:5});
    await sync.sync();
    let notified=0;const unsubscribe=profile.subscribe(()=>notified++);
    profile.importJSON(profile.exportJSON());assert.equal(notified,0);
    const pulls=()=>calls.filter(q=>q.action==='pull'&&q.userId===sync.userId).length;
    const start=pulls();
    profile.set('ebm_ui_lang','é'.repeat(140000));
    await new Promise(r=>setTimeout(r,80));
    assert.equal(pulls(),start+1);
    sync.schedule();profile.importJSON(profile.exportJSON());
    await new Promise(r=>setTimeout(r,80));assert.equal(pulls(),start+1);
    profile.rename('Changed oversized profile');
    await new Promise(r=>setTimeout(r,80));assert.equal(pulls(),start+2);
    profile.remove('ebm_ui_lang');
    await new Promise(r=>setTimeout(r,80));assert.equal(pulls(),start+3);
    assert.equal(records.get(sync.userId).profile.display_name,'Changed oversized profile');
    unsubscribe();sync.stop();
  }
  {
    for(const initial of [null,'allowed','denied']) {
      const storage=new Storage(),profile=DeviceProfile.create(new Storage(),webcrypto);
      if(initial)storage.setItem(Cloud.CONSENT_KEY,initial);
      storage.setItem=()=>{throw Error('Storage blocked');};
      const sync=Cloud.create({profile,storage,endpoint:'https://sync.test/exec',fetch,delay:60000});
      profile.activity(['session-only read'],[]);
      assert.doesNotThrow(()=>sync.setConsent(false));
      assert.equal(sync.consent,'denied');
      const before=calls.length;await sync.sync();assert.equal(calls.length,before);
      assert.doesNotThrow(()=>sync.setConsent(true));assert.equal(sync.consent,'allowed');
      await sync.sync();assert.ok(records.get(sync.userId).profile.read_ids.includes('session-only read'));
      assert.doesNotThrow(()=>sync.setConsent(false));assert.equal(sync.consent,'denied');sync.stop();
    }
    const profile=DeviceProfile.create(new Storage(),webcrypto);
    const storage={getItem(){throw Error('Storage blocked');},setItem(){throw Error('Storage blocked');}};
    const sync=Cloud.create({profile,storage,endpoint:'https://sync.test/exec',fetch,delay:60000});
    assert.doesNotThrow(()=>sync.setConsent(true));assert.equal(sync.consent,'allowed');
    assert.doesNotThrow(()=>sync.setConsent(false));assert.equal(sync.consent,'denied');sync.stop();
  }
  {
    const storage=new Storage(),profile=DeviceProfile.create(storage,webcrypto);
    profile.activity(['shared tab read'],[]);
    const first=consented({profile,storage,endpoint:'https://sync.test/exec',fetch,delay:60000});
    let releasePull,entered;
    const pausedPull=new Promise(resolve=>releasePull=resolve),pulled=new Promise(resolve=>entered=resolve);
    const second=Cloud.create({profile,storage,endpoint:'https://sync.test/exec',delay:60000,fetch:async(url,options)=>{
      const response=await fetch(url,options);
      if(JSON.parse(options.body).action==='pull') {entered();await pausedPull;}
      return response;
    }});
    const before=calls.filter(q=>q.action==='push').length;
    const inFlight=second.sync();await pulled;
    first.setConsent(false);releasePull();
    await assert.rejects(inFlight,/CONSENT_REQUIRED/);
    assert.equal(second.consent,'denied');assert.equal(calls.filter(q=>q.action==='push').length,before);
    const stopped=calls.length;await second.sync();second.schedule();
    await new Promise(r=>setTimeout(r,30));assert.equal(calls.length,stopped);
    first.setConsent(true);await second.sync();
    assert.equal(second.consent,'allowed');assert.equal(calls.filter(q=>q.action==='push').length,before+1);
    first.stop();second.stop();
  }
  {
    for(const phase of ['idle','pull','push']) {
      const storage=new Storage(),profile=DeviceProfile.create(storage,webcrypto);
      profile.activity(['original read'],[]);
      const first=consented({profile,storage,endpoint:'https://sync.test/exec',fetch,delay:60000});
      await first.sync();
      const oldId=first.userId;
      let pause=null,release,entered;
      const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
      const secondProfile=DeviceProfile.create(storage,webcrypto);
      const second=Cloud.create({profile:secondProfile,storage,endpoint:'https://sync.test/exec',delay:5,fetch:async(url,options)=>{
        const response=await fetch(url,options);
        if(JSON.parse(options.body).action===pause) {pause=null;entered();await gate;}
        return response;
      }});
      await second.sync();
      const remote=DeviceProfile.create(new Storage(),webcrypto),newId=remote.profile.device_id;
      remote.activity(['restored read'],[]);
      records.set(newId,{profile:JSON.parse(remote.exportJSON()),revision:1});
      let pending;
      if(phase!=='idle') {
        if(phase==='pull') {const row=records.get(oldId);row.profile.read_ids.push('stale old response');row.revision++;}
        pause=phase;pending=second.sync();await started;
      }
      first.setConsent(false);
      const beforeRestore=calls.length;
      await first.restore(newId);
      release();if(pending)await pending;
      assert.equal(JSON.parse(storage.getItem('dlh_sync_baseline_v1')).userId,newId);
      assert.ok(!secondProfile.profile.read_ids.includes('stale old response'));
      second.schedule();await new Promise(r=>setTimeout(r,50));
      assert.equal(first.userId,newId);assert.equal(second.userId,newId);
      assert.ok(calls.slice(beforeRestore).filter(q=>q.action==='push').every(q=>q.userId===newId));
      assert.ok(calls.slice(beforeRestore).some(q=>q.action==='push'&&q.userId===newId));
      assert.equal(JSON.parse(storage.getItem('dlh_sync_baseline_v1')).userId,newId);
      assert.ok(records.get(newId).profile.read_ids.includes('restored read'));
      first.stop();second.stop();
    }
  }
  {
    for(const initial of [null,'denied','allowed']) {
      const storage=new Storage(),profile=DeviceProfile.create(storage,webcrypto);
      if(initial)storage.setItem(Cloud.CONSENT_KEY,initial);
      const sync=Cloud.create({profile,storage,endpoint:'https://sync.test/exec',fetch,delay:5});
      const start=calls.length;
      await sync.email('restore_request','test@example.test');
      assert.equal(sync.consent,initial);assert.equal(storage.getItem(Cloud.CONSENT_KEY),initial);
      assert.deepEqual(calls.slice(start).map(q=>q.action),['restore_request']);
      if(initial!=='allowed') {
        profile.activity(['still private'],[]);await sync.sync();
        await new Promise(r=>setTimeout(r,30));assert.equal(calls.length,start+1);
      }
      sync.stop();
    }
  }
  {
    for(const initial of [null,'denied','allowed']) {
      const storage=new Storage(),profile=DeviceProfile.create(storage,webcrypto);
      if(initial)storage.setItem(Cloud.CONSENT_KEY,initial);
      profile.activity(['restore local read'],[]);
      let rejectMerge=false,networkError=null;
      const sync=Cloud.create({profile,storage,endpoint:'https://sync.test/exec',delay:5,fetch:async(url,options)=>{
        if(JSON.parse(options.body).action===networkError)throw Error('restore network failure');
        if(rejectMerge)return {ok:true,text:async()=>JSON.stringify({ok:true,profile:{version:1},revision:1})};
        return fetch(url,options);
      }});
      const observer=Cloud.create({profile:DeviceProfile.create(storage,webcrypto),storage,endpoint:'https://sync.test/exec',fetch,delay:60000});
      const priorId=sync.userId;
      const storedId=storage.getItem(Cloud.ID_KEY);
      const start=calls.filter(q=>q.action==='push').length;
      for(const viaLink of [false,true]) {
        const missing='00000000-0000-4000-8000-000000000000';
        await assert.rejects(viaLink?sync.start({url:'https://example.test/?restore='+missing,confirm:()=>true,replaceUrl:()=>{}}):sync.restore(missing),/BACKUP_NOT_FOUND/);
        assert.equal(sync.consent,initial);assert.equal(storage.getItem(Cloud.CONSENT_KEY),initial);
        assert.equal(sync.userId,priorId);assert.equal(storage.getItem('dlh_sync_baseline_v1'),null);
        assert.equal(observer.userId,priorId);assert.equal(observer.consent,initial);
        assert.equal(storage.getItem(Cloud.ID_KEY),storedId);
      }
      assert.equal(calls.filter(q=>q.action==='push').length,start);
      rejectMerge=true;await assert.rejects(sync.restore(c.userId));assert.equal(sync.consent,initial);
      rejectMerge=false;
      for(const action of ['pull','push']) {
        networkError=action;
        const untouched=JSON.stringify([...storage.values]);
        await assert.rejects(sync.restore(c.userId),/restore network failure/);
        assert.equal(JSON.stringify([...storage.values]),untouched);
        assert.equal(sync.consent,initial);assert.equal(observer.consent,initial);
        assert.equal(sync.userId,priorId);assert.equal(observer.userId,priorId);
        assert.equal(storage.getItem(Cloud.CONSENT_KEY),initial);
        assert.equal(storage.getItem(Cloud.ID_KEY),storedId);
        assert.equal(storage.getItem('dlh_sync_baseline_v1'),null);
      }
      networkError=null;
      await sync.start({url:'https://example.test/?restore='+c.userId,confirm:()=>true,replaceUrl:()=>{}});
      assert.equal(sync.consent,'allowed');assert.equal(storage.getItem(Cloud.CONSENT_KEY),'allowed');
      assert.ok(profile.profile.read_ids.includes('local'));
      assert.equal(observer.userId,c.userId);assert.equal(observer.consent,'allowed');
      sync.stop();observer.stop();
    }
  }
  {
    const storage=new Storage(),profile=DeviceProfile.create(storage,webcrypto);
    const make=()=>Cloud.create({profile,storage,endpoint:'https://sync.test/exec',fetch,delay:5});
    let sync=make();const start=calls.length;
    profile.activity(['private read'],[]);
    await sync.start({url:'https://example.test/'});await sync.sync();
    await new Promise(r=>setTimeout(r,30));assert.equal(calls.length,start);
    assert.equal(sync.consent,null);
    sync.setConsent(false);assert.equal(sync.consent,'denied');sync.stop();
    sync=make();assert.equal(sync.consent,'denied');
    await sync.start({url:'https://example.test/'});assert.equal(calls.length,start);
    sync.setConsent(true);
    await new Promise(r=>setTimeout(r,30));
    assert.ok(records.get(sync.userId).profile.read_ids.includes('private read'));
    sync.setConsent(false);const paused=calls.length;
    profile.activity(['private read','off'],[]);await sync.sync();
    await new Promise(r=>setTimeout(r,30));assert.equal(calls.length,paused);
    await sync.restore(c.userId);assert.equal(sync.consent,'allowed');
    assert.equal(storage.getItem(Cloud.CONSENT_KEY),'allowed');sync.stop();
    sync=make();sync.setConsent(false);
    await sync.email('backup','test@example.test');assert.equal(sync.consent,'allowed');
    sync.setConsent(false);
    await sync.start({url:'https://example.test/?restore='+c.userId,confirm:()=>true,replaceUrl:()=>{}});
    assert.equal(sync.consent,'allowed');sync.stop();
  }
  {
    const storage=new Storage(),profile=DeviceProfile.create(storage,webcrypto);
    profile.rename('Original');profile.activity(['original'],['remove','keep']);
    const first=consented({profile,storage,endpoint:'https://sync.test/exec',fetch,delay:60000});
    await first.sync();
    const staleProfile=DeviceProfile.create(storage,webcrypto);
    const stale=Cloud.create({profile:staleProfile,storage,endpoint:'https://sync.test/exec',fetch,delay:60000});
    first.setConsent(false);
    const remote=DeviceProfile.create(new Storage(),webcrypto),target=remote.profile.device_id;
    remote.rename('Restored name');remote.activity(['restored'],['remove','keep']);
    records.set(target,{profile:JSON.parse(remote.exportJSON()),revision:1});
    await first.restore(target);
    const row=records.get(target);row.revision++;row.profile.display_name='Newest remote rename';row.profile.bookmarked_ids=['keep'];
    await stale.sync();
    assert.equal(staleProfile.profile.display_name,'Newest remote rename');
    assert.deepEqual(staleProfile.profile.bookmarked_ids,['keep']);
    assert.equal(records.get(target).profile.display_name,'Newest remote rename');
    assert.deepEqual(records.get(target).profile.bookmarked_ids,['keep']);
    first.stop();stale.stop();
  }
  {
    const storage=new Storage(),profile=DeviceProfile.create(storage,webcrypto);
    profile.rename('Unchanged local');profile.activity(['local'],['local bookmark']);
    storage.setItem(Cloud.CONSENT_KEY,'denied');
    const remote=DeviceProfile.create(new Storage(),webcrypto),target=remote.profile.device_id;
    remote.rename('Remote');remote.activity(['remote'],['remote bookmark']);
    records.set(target,{profile:JSON.parse(remote.exportJSON()),revision:1});
    let pushes=0,fail=true;
    const sync=Cloud.create({profile,storage,endpoint:'https://sync.test/exec',delay:60000,fetch:async(url,options)=>{
      if(JSON.parse(options.body).action==='push'&&++pushes===2&&fail)throw Error('failed staged restore');
      return fetch(url,options);
    }});
    const original=JSON.stringify([...storage.values]),portable=profile.exportJSON();
    conflicts=[data=>{data.display_name='Remote conflict update';data.read_ids.push('conflict read');}];
    await assert.rejects(sync.restore(target),/failed staged restore/);
    assert.equal(JSON.stringify([...storage.values]),original);assert.equal(profile.exportJSON(),portable);
    assert.equal(sync.consent,'denied');assert.notEqual(sync.userId,target);
    fail=false;await sync.restore(target);
    assert.ok(profile.profile.read_ids.includes('remote'));assert.ok(profile.profile.read_ids.includes('local'));
    assert.equal(sync.userId,target);sync.stop();
  }
  {
    for(const phase of ['pull','push']) for(const initial of [null,'denied','allowed']) {
      const storage=new Storage(),profile=DeviceProfile.create(storage,webcrypto);
      profile.activity(['pending restore'],[]);
      if(initial)storage.setItem(Cloud.CONSENT_KEY,initial);
      const remote=DeviceProfile.create(new Storage(),webcrypto),target=remote.profile.device_id;
      remote.activity(['remote read'],[]);records.set(target,{profile:JSON.parse(remote.exportJSON()),revision:1});
      let release,entered,pause=true;
      const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
      const sync=Cloud.create({profile,storage,endpoint:'https://sync.test/exec',delay:5,fetch:async(url,options)=>{
        const response=await fetch(url,options);
        if(pause&&JSON.parse(options.body).action===phase) {pause=false;entered();await gate;}
        return response;
      }});
      const other=Cloud.create({profile:DeviceProfile.create(storage,webcrypto),storage,endpoint:'https://sync.test/exec',fetch,delay:60000});
      const pending=sync.restore(target);await started;
      if(initial==='denied')other.setConsent(true);
      other.setConsent(false);const afterPause=calls.length;
      release();
      if(phase==='pull')await assert.rejects(pending,/CONSENT_REQUIRED/);else await pending;
      assert.equal(sync.consent,'denied');assert.equal(other.consent,'denied');
      assert.equal(storage.getItem(Cloud.CONSENT_KEY),'denied');
      assert.equal(sync.userId===target,phase==='push');
      await new Promise(r=>setTimeout(r,30));assert.equal(calls.length,afterPause);
      sync.stop();other.stop();
    }
  }
  {
    const storage=new Storage(),profile=DeviceProfile.create(storage,webcrypto);
    profile.rename('Before');profile.activity(['read'],['remove','keep']);
    const first=consented({profile,storage,endpoint:'https://sync.test/exec',fetch,delay:60000});await first.sync();
    let release,entered,pause=true,merged=0;
    const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
    const secondProfile=DeviceProfile.create(storage,webcrypto);
    const second=Cloud.create({profile:secondProfile,storage,endpoint:'https://sync.test/exec',delay:5,onMerged:()=>merged++,fetch:async(url,options)=>{
      const response=await fetch(url,options);
      if(pause&&JSON.parse(options.body).action==='pull') {pause=false;entered();await gate;}
      return response;
    }});
    const pending=second.sync();await started;
    profile.rename('Other tab latest');profile.activity(['read'],['keep']);await first.sync();
    release();await pending;await new Promise(r=>setTimeout(r,50));
    assert.equal(merged,0);
    assert.equal(secondProfile.profile.display_name,'Other tab latest');assert.deepEqual(secondProfile.profile.bookmarked_ids,['keep']);
    assert.equal(records.get(first.userId).profile.display_name,'Other tab latest');
    assert.deepEqual(records.get(first.userId).profile.bookmarked_ids,['keep']);first.stop();second.stop();
  }
  {
    for(const restoring of [false,true]) {
      const storage=new Storage(),profile=DeviceProfile.create(storage,webcrypto);
      profile.rename('Before push');profile.activity(['read'],['remove','keep']);
      const otherProfile=DeviceProfile.create(storage,webcrypto);
      let release,entered,pause=true;
      const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
      const sync=consented({profile,storage,endpoint:'https://sync.test/exec',delay:5,fetch:async(url,options)=>{
        const response=await fetch(url,options);
        if(pause&&JSON.parse(options.body).action==='push') {pause=false;entered();await gate;}
        return response;
      }});
      const remote=DeviceProfile.create(new Storage(),webcrypto),target=restoring?remote.profile.device_id:sync.userId;
      if(restoring)records.set(target,{profile:JSON.parse(remote.exportJSON()),revision:1});
      const pending=restoring?sync.restore(target):sync.sync();await started;
      otherProfile.rename('Edited during push');otherProfile.activity(['read','during push'],['keep']);
      release();await pending;await new Promise(r=>setTimeout(r,50));
      assert.equal(profile.snapshot().display_name,'Edited during push');assert.deepEqual(profile.profile.bookmarked_ids,['keep']);
      assert.equal(records.get(target).profile.display_name,'Edited during push');
      assert.deepEqual(records.get(target).profile.bookmarked_ids,['keep']);
      assert.ok(records.get(target).profile.read_ids.includes('during push'));sync.stop();
    }
  }
  {
    const html=require('node:fs').readFileSync(require.resolve('../index.html'),'utf8');
    const source=['saveOfflineActivityStore','recordBriefingRead','toggleBriefingBookmark'].map(name=>
      html.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n    \\}`))[0]).join('\n');
    const storage=new Storage(),a=DeviceProfile.create(storage,webcrypto),b=DeviceProfile.create(storage,webcrypto);
    const tab=profile=>require('node:vm').runInNewContext(`${source};({App,recordBriefingRead,toggleBriefingBookmark,saveOfflineActivityStore})`,{
      deviceStore:profile,App:{user:{read_ids:[],bookmarked_ids:[]},selected:null},
      renderUserWorkspace(){},updateBookmarkButtonUI(){},renderBriefingsList(){},showToast(){},tt:key=>key,syncDeviceActivity:async()=>{}
    });
    const first=tab(a),second=tab(b);
    const syncA=consented({profile:a,storage,endpoint:'https://sync.test/exec',fetch,delay:60000});
    const syncB=Cloud.create({profile:b,storage,endpoint:'https://sync.test/exec',fetch,delay:60000});
    first.App.selected={id:'A'};await first.toggleBriefingBookmark();await first.recordBriefingRead('A');await syncA.sync();
    assert.equal(syncB.consent,'allowed');
    assert.deepEqual(second.App.user.bookmarked_ids,[]);
    second.App.selected={id:'B'};await second.toggleBriefingBookmark();await second.recordBriefingRead('B');await syncB.sync();
    assert.deepEqual(new Set(b.profile.bookmarked_ids),new Set(['A','B']));
    assert.deepEqual(new Set(b.profile.read_ids),new Set(['A','B']));
    assert.deepEqual(new Set(second.App.user.bookmarked_ids),new Set(['A','B']));
    assert.deepEqual(new Set(records.get(syncB.userId).profile.bookmarked_ids),new Set(['A','B']));
    assert.equal(syncA.consent,'allowed');
    await first.toggleBriefingBookmark();first.saveOfflineActivityStore('read_ids','A',false);await syncA.sync();
    assert.deepEqual(a.profile.bookmarked_ids,['B']);assert.deepEqual(a.profile.read_ids,['B']);
    assert.deepEqual(Array.from(first.App.user.bookmarked_ids),['B']);
    assert.deepEqual(records.get(syncA.userId).profile.bookmarked_ids,['B']);syncA.stop();syncB.stop();
  }
  {
    for(const retry of [false,true]) {
      const storage=new Storage(),profile=DeviceProfile.create(storage,webcrypto);
      profile.activity(['local'],['re-added']);storage.setItem(Cloud.CONSENT_KEY,'denied');
      const other=DeviceProfile.create(storage,webcrypto),remote=DeviceProfile.create(new Storage(),webcrypto),target=remote.profile.device_id;
      remote.activity(['remote'],['re-added']);records.set(target,{profile:JSON.parse(remote.exportJSON()),revision:1});
      let releasePull,releasePush,pulled,pushed,pausePull=true,pausePush=true;
      const pullGate=new Promise(resolve=>releasePull=resolve),pushGate=new Promise(resolve=>releasePush=resolve);
      const pullStarted=new Promise(resolve=>pulled=resolve),pushStarted=new Promise(resolve=>pushed=resolve);
      const sync=Cloud.create({profile,storage,endpoint:'https://sync.test/exec',delay:5,fetch:async(url,options)=>{
        const response=await fetch(url,options),action=JSON.parse(options.body).action;
        if(pausePull&&action==='pull'){pausePull=false;pulled();await pullGate;}
        if(pausePush&&action==='push'){pausePush=false;pushed();await pushGate;}
        return response;
      }});
      if(retry)conflicts=[data=>data.read_ids.push('conflict')];
      const pending=sync.restore(target);await pullStarted;
      other.activity(other.snapshot().read_ids,[]);releasePull();await pushStarted;
      other.activity(other.snapshot().read_ids,['re-added']);releasePush();await pending;
      assert.ok(profile.snapshot().bookmarked_ids.includes('re-added'));
      await new Promise(r=>setTimeout(r,50));
      assert.ok(records.get(target).profile.bookmarked_ids.includes('re-added'));sync.stop();
    }
  }
  {
    const storage=new Storage();let profile=DeviceProfile.create(storage,webcrypto);
    storage.setItem('ebm_cloud_users_db',JSON.stringify({legacy:{display_name:'Legacy Doctor'}}));
    storage.setItem(DeviceProfile.KEY,JSON.stringify({...profile.profile,display_name:'Legacy Doctor'}));
    profile=DeviceProfile.create(storage,webcrypto);
    assert.equal(profile.profile.display_name,'Legacy Doctor');assert.equal(JSON.parse(profile.exportJSON()).display_name,'Bác sĩ');
    const remote=DeviceProfile.create(new Storage(),webcrypto),target=remote.profile.device_id;
    remote.rename('Restored name');remote.activity(['restored'],[]);
    records.set(target,{profile:JSON.parse(remote.exportJSON()),revision:1});
    const sync=Cloud.create({profile,storage,endpoint:'https://sync.test/exec',fetch,delay:5});
    await sync.restore(target);await new Promise(r=>setTimeout(r,50));
    assert.equal(profile.profile.display_name,'Restored name');assert.equal(JSON.parse(profile.exportJSON()).display_name,'Restored name');
    assert.equal(records.get(target).profile.display_name,'Restored name');
    assert.ok(!JSON.stringify(records.get(target)).includes('Legacy Doctor'));sync.stop();
  }
  const failed=Cloud.create({profile:otherProfile,storage:otherStorage,endpoint:'https://sync.test/exec',fetch:async()=>{throw Error('offline');},onStatus:s=>statuses.push(s)});
  await assert.rejects(failed.sync(),/offline/);assert.equal(statuses.at(-1),'SYNC_FAILED');failed.stop();
  const html=require('node:fs').readFileSync(require.resolve('../index.html'),'utf8');
  assert.ok(html.includes('id="cloudEmailSection" hidden'));
  for(const id of ['cloudConsentNotice','cloudConsentText','btnAllowCloudSync','btnDeclineCloudSync','cloudSyncEnabled'])assert.ok(html.includes(`id="${id}"`));
  assert.match(html,/No backup found for this ID/);assert.match(html,/Không tìm thấy bản sao lưu cho mã này/);
  assert.match(html,/\["EMAIL_CONFIRMED", "EMAIL_CONFIRM_INVALID", "NOT_CONFIGURED"\]\.includes\(code\)\) showToast/);
  console.log('Cloud sync mocked push/pull/merge, revision retry, debounced writes, restore ID/URL, email privacy, disabled state and invalid/oversized profiles: OK');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
