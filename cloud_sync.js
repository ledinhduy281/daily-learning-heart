/* Optional cloud transport; DeviceProfile remains the validation/merge authority. */
const CloudSync = (() => {
  const ID_KEY='dlh_sync_identity_v1',BASE_KEY='dlh_sync_baseline_v1',CONSENT_KEY='dlh_sync_consent_v1',MAX_BYTES=256*1024;
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const bytes=value=>new TextEncoder().encode(value).length;
  function validId(value) {
    if(typeof value!=='string'||!uuid.test(value.trim()))throw new Error('INVALID_ID');
    return value.trim().toLowerCase();
  }
  function create({profile,storage,endpoint='',fetch:fetcher=globalThis.fetch,onMerged=()=>{},onStatus=()=>{},delay=1000}) {
    const enabled=!!endpoint;
    if(enabled&&!/^https:\/\//.test(endpoint))throw new Error('INVALID_ENDPOINT');
    let stored;
    try {stored=storage.getItem(ID_KEY);}catch(_){}
    let id=uuid.test(stored||'')?validId(stored):validId(profile.profile.device_id),timer,queue=Promise.resolve(),lastSynced='';
    let baseline=null;
    let consent=null,storedConsent=null,sessionConsent=false,merging=false,blockedSnapshot=null;
    function readConsent() {
      try {
        const value=storage.getItem(CONSENT_KEY),saved=['allowed','denied'].includes(value)?value:null;
        if(!sessionConsent||saved!==storedConsent) {consent=saved;sessionConsent=false;}
        storedConsent=saved;
      } catch(_){}
      return consent;
    }
    readConsent();
    function rememberConsent(allow) {
      readConsent();
      consent=allow?'allowed':'denied';
      sessionConsent=true;
      try {storage.setItem(CONSENT_KEY,consent);storedConsent=consent;sessionConsent=false;}catch(_){}
      clearTimeout(timer);
    }
    function loadBaseline() {
      baseline=null;
      try {
        const cached=JSON.parse(storage.getItem(BASE_KEY));
        if(cached?.userId===id && cached.profile && bytes(JSON.stringify(cached.profile))<=MAX_BYTES)baseline=cached.profile;
      } catch(_) {}
    }
    loadBaseline();
    function readState() {
      readConsent();
      try {
        const saved=storage.getItem(ID_KEY);
        const next=uuid.test(saved||'')?validId(saved):validId(profile.profile.device_id);
        if(next!==id) {
          id=next;lastSynced='';blockedSnapshot=null;
          loadBaseline();
        }
      } catch(_) {}
    }
    function requireActive(expectedId) {
      readState();
      if(id!==expectedId)throw new Error('SYNC_SUPERSEDED');
    }
    const status=code=>onStatus(code);
    async function request(action,fields={},expectedId=null,restoring=false) {
      if(!enabled)throw new Error('NOT_CONFIGURED');
      if(expectedId!==null)requireActive(expectedId);
      if(action==='push'&&!restoring&&readConsent()!=='allowed')throw new Error('CONSENT_REQUIRED');
      const body=JSON.stringify({action,...fields});
      if(bytes(body)>MAX_BYTES+4096)throw new Error('TOO_LARGE');
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),30000);
      try {
        const res=await fetcher(endpoint,{method:'POST',headers:{'Content-Type':'text/plain'},body,redirect:'follow',signal:controller.signal});
        if(expectedId!==null)requireActive(expectedId);
        if(!res.ok)throw new Error('SYNC_FAILED');
        const text=await res.text();
        if(expectedId!==null)requireActive(expectedId);
        if(bytes(text)>MAX_BYTES+4096)throw new Error('TOO_LARGE');
        const result=JSON.parse(text);if(!result||result.ok!==true)throw new Error('SYNC_FAILED');
        return result;
      } catch(error) {
        if(expectedId!==null)requireActive(expectedId);
        throw error;
      } finally {clearTimeout(timeout);}
    }
    function merge(remote,base) {
      if(remote==null)return;
      const text=JSON.stringify(remote);
      if(bytes(text)>MAX_BYTES||typeof remote!=='object'||Array.isArray(remote)||'device_id' in remote)throw new Error('INVALID_PROFILE');
      const before=profile.exportJSON();
      merging=true;
      try {profile.importJSON(text,'merge',base);}finally{merging=false;}
      if(profile.exportJSON()!==before)onMerged();
    }
    const meaningful=p=>p.read_ids.length||p.bookmarked_ids.length||Object.keys(p.progress).length;
    function remember(target,data) {
      baseline=data;
      try {storage.setItem(BASE_KEY,JSON.stringify({userId:target,profile:data}));}catch(_){}
    }
    async function exchange(target,adopt=false,force=false) {
      if(!enabled)throw new Error('NOT_CONFIGURED');
      readState();
      if(!adopt&&readConsent()!=='allowed')return;
      if(!adopt)target=id;
      const initialId=id;
      let remote=await request('pull',{userId:target},initialId);
      if(adopt&&remote.profile==null)throw new Error('BACKUP_NOT_FOUND');
      let base=target===id?baseline:null;
      merge(remote.profile,base);
      requireActive(initialId);
      base=remote.profile;if(!adopt)remember(target,base);
      for(let attempt=0;attempt<4;attempt++) {
        const text=profile.exportJSON(),data=JSON.parse(text);
        if(bytes(text)>MAX_BYTES)throw new Error('TOO_LARGE');
        if(!meaningful(data)&&!adopt&&!force)return;
        const result=await request('push',{userId:target,profile:data,revision:remote.revision},adopt?initialId:target,adopt);
        if(!result.conflict) {
          if(adopt) {storage.setItem(ID_KEY,target);id=target;lastSynced='';blockedSnapshot=null;rememberConsent(true);}
          lastSynced=text;remember(target,data);
          status('SYNCED');return;
        }
        merge(result.profile,base);remote=result;
        base=remote.profile;if(!adopt)remember(target,base);
      }
      throw new Error('SYNC_CONFLICT');
    }
    function enqueue(work) {
      const result=queue.then(work);
      queue=result.catch(()=>{});
      return result.catch(error=>{
        if(error.message==='SYNC_SUPERSEDED')return;
        if(error.message==='TOO_LARGE')blockedSnapshot=profile.exportJSON();
        status(['NOT_CONFIGURED','BACKUP_NOT_FOUND','CONSENT_REQUIRED'].includes(error.message)?error.message:'SYNC_FAILED');throw error;
      });
    }
    function sync() {return enqueue(()=>exchange(id));}
    function schedule() {
      readState();
      if(!enabled||readConsent()!=='allowed'||merging)return;
      clearTimeout(timer);
      timer=setTimeout(()=>{
        readState();
        const text=profile.exportJSON();
        if(text!==lastSynced&&text!==blockedSnapshot)sync().catch(()=>{});
      },delay);
    }
    const unsubscribe=profile.subscribe?profile.subscribe(schedule):()=>{};
    return {
      enabled,get userId(){readState();return id;},get consent(){readState();return consent;},sync,schedule,
      setConsent(allow) {rememberConsent(allow);status(allow?'SYNC_ALLOWED':'CONSENT_REQUIRED');if(allow){lastSynced='';schedule();}},
      restore(value) {
        const target=validId(value);
        return enqueue(()=>exchange(target,true));
      },
      async start({url,confirm,replaceUrl}) {
        const parsed=new URL(url),restore=parsed.searchParams.get('restore');
        if(parsed.searchParams.has('email_confirm')) {
          try {
            const token=parsed.searchParams.get('email_confirm');
            if(!/^[a-f0-9]{64}$/.test(token))throw new Error('INVALID_CONFIRMATION');
            const result=await request('confirm',{token});
            status(result.confirmed===true?'EMAIL_CONFIRMED':'EMAIL_CONFIRM_INVALID');
          } finally {
            parsed.searchParams.delete('email_confirm');parsed.searchParams.delete('restore');replaceUrl(parsed.href);
          }
          return;
        }
        if(restore!==null) {
          try {validId(restore);if(await confirm(restore))await this.restore(restore);}
          finally {parsed.searchParams.delete('restore');replaceUrl(parsed.href);}
        } else if(enabled&&readConsent()==='allowed')await sync();
      },
      async email(action,email,lang='vi') {
        if(!['backup','restore_request'].includes(action)||typeof email!=='string'||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))throw new Error('INVALID_EMAIL');
        if(enabled&&action==='backup')rememberConsent(true);
        return enqueue(async()=>{
          if(action==='backup')await exchange(id,false,true);
          await request(action,{userId:id,email:email.trim(),lang});
          status('EMAIL_SENT');return {ok:true};
        });
      },
      stop(){clearTimeout(timer);unsubscribe();}
    };
  }
  return {create,validId,ID_KEY,CONSENT_KEY,MAX_BYTES};
})();
if(typeof module!=='undefined')module.exports=CloudSync;
