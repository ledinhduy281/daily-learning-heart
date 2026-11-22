const assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
const DeviceProfile=require('../device_profile.js');
const Cloud=require('../cloud_sync.js');
class Storage {
  constructor(){this.values=new Map();}get length(){return this.values.size;}key(i){return [...this.values.keys()][i];}
  getItem(k){return this.values.get(k)??null;}setItem(k,v){this.values.set(k,String(v));}removeItem(k){this.values.delete(k);}
}
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
  const c=Cloud.create({profile,storage,endpoint:'https://sync.test/exec',fetch,onStatus:s=>statuses.push(s),delay:5});
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
    let sync=Cloud.create({profile:local,storage:localStorage,endpoint:'https://sync.test/exec',fetch,delay:60000,onMerged:()=>merged++});
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
    sync=Cloud.create({profile:local,storage:localStorage,endpoint:'https://sync.test/exec',fetch});
    await sync.sync();
    assert.equal(local.profile.display_name,'After reload');assert.deepEqual(local.profile.bookmarked_ids,[]);
    sync.stop();
  }
  const failed=Cloud.create({profile:otherProfile,storage:otherStorage,endpoint:'https://sync.test/exec',fetch:async()=>{throw Error('offline');},onStatus:s=>statuses.push(s)});
  await assert.rejects(failed.sync(),/offline/);assert.equal(statuses.at(-1),'SYNC_FAILED');failed.stop();
  const html=require('node:fs').readFileSync(require.resolve('../index.html'),'utf8');
  assert.ok(html.includes('id="cloudEmailSection" hidden'));
  assert.match(html,/\["EMAIL_CONFIRMED", "EMAIL_CONFIRM_INVALID", "NOT_CONFIGURED"\]\.includes\(code\)\) showToast/);
  console.log('Cloud sync mocked push/pull/merge, revision retry, debounced writes, restore ID/URL, email privacy, disabled state and invalid/oversized profiles: OK');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
