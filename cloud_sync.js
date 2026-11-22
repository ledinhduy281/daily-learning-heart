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
    let consent=null,merging=false,blockedSnapshot=null;
    try {const saved=storage.getItem(CONSENT_KEY);if(['allowed','denied'].includes(saved))consent=saved;}catch(_){}
    function rememberConsent(allow) {
      consent=allow?'allowed':'denied';
      storage.setItem(CONSENT_KEY,consent);
      clearTimeout(timer);
    }
    try {
      const cached=JSON.parse(storage.getItem(BASE_KEY));
      if(cached?.userId===id && cached.profile && bytes(JSON.stringify(cached.profile))<=MAX_BYTES)baseline=cached.profile;
    } catch(_) {}
    const status=code=>onStatus(code);
    async function request(action,fields={}) {
      if(!enabled)throw new Error('NOT_CONFIGURED');
      if(action==='push'&&consent!=='allowed')throw new Error('CONSENT_REQUIRED');
      const body=JSON.stringify({action,...fields});
      if(bytes(body)>MAX_BYTES+4096)throw new Error('TOO_LARGE');
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),30000);
      try {
        const res=await fetcher(endpoint,{method:'POST',headers:{'Content-Type':'text/plain'},body,redirect:'follow',signal:controller.signal});
        if(!res.ok)throw new Error('SYNC_FAILED');
        const text=await res.text();if(bytes(text)>MAX_BYTES+4096)throw new Error('TOO_LARGE');
        const result=JSON.parse(text);if(!result||result.ok!==true)throw new Error('SYNC_FAILED');
        return result;
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
      if(consent!=='allowed')return;
      let remote=await request('pull',{userId:target});
      if(adopt&&remote.profile==null)throw new Error('BACKUP_NOT_FOUND');
      let base=target===id?baseline:null;
      merge(remote.profile,base);
      if(adopt) {storage.setItem(ID_KEY,target);id=target;lastSynced='';}
      base=remote.profile;remember(target,base);
      for(let attempt=0;attempt<4;attempt++) {
        const text=profile.exportJSON(),data=JSON.parse(text);
        if(bytes(text)>MAX_BYTES)throw new Error('TOO_LARGE');
        if(!meaningful(data)&&!adopt&&!force)return;
        const result=await request('push',{userId:target,profile:data,revision:remote.revision});
        if(!result.conflict) {
          lastSynced=text;remember(target,data);
          status('SYNCED');return;
        }
        merge(result.profile,base);remote=result;
        base=remote.profile;remember(target,base);
      }
      throw new Error('SYNC_CONFLICT');
    }
    function enqueue(work) {
      const result=queue.then(work);
      queue=result.catch(()=>{});
      return result.catch(error=>{
        if(error.message==='TOO_LARGE')blockedSnapshot=profile.exportJSON();
        status(['NOT_CONFIGURED','BACKUP_NOT_FOUND','CONSENT_REQUIRED'].includes(error.message)?error.message:'SYNC_FAILED');throw error;
      });
    }
    function sync() {return enqueue(()=>exchange(id));}
    function schedule() {
      if(!enabled||consent!=='allowed'||merging)return;
      clearTimeout(timer);
      timer=setTimeout(()=>{
        const text=profile.exportJSON();
        if(text!==lastSynced&&text!==blockedSnapshot)sync().catch(()=>{});
      },delay);
    }
    const unsubscribe=profile.subscribe?profile.subscribe(schedule):()=>{};
    return {
      enabled,get userId(){return id;},get consent(){return consent;},sync,schedule,
      setConsent(allow) {rememberConsent(allow);status(allow?'SYNC_ALLOWED':'CONSENT_REQUIRED');if(allow){lastSynced='';schedule();}},
      restore(value) {
        const target=validId(value);
        if(enabled)rememberConsent(true);
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
        } else if(enabled&&consent==='allowed')await sync();
      },
      async email(action,email,lang='vi') {
        if(!['backup','restore_request'].includes(action)||typeof email!=='string'||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))throw new Error('INVALID_EMAIL');
        if(enabled)rememberConsent(true);
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
