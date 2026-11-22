const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
const context=vm.createContext({});
vm.runInContext(fs.readFileSync(require.resolve('../backend/apps_script/Code.gs'),'utf8'),context);
const {syncHandle:handle,syncFingerprint:fingerprint,syncCanMail:canMail}=context;
const hmac=(value,key)=>crypto.createHmac('sha256',key).update(value).digest('hex');
const id='12345678-1234-4123-8123-123456789abc';
const profile={version:1,display_name:'Doctor',created_at:'2026-11-22T00:00:00Z',read_ids:['one'],bookmarked_ids:[],progress:{}};
const records=new Map(),mails=[];let now=Date.now(),remaining=100;
const env={get:k=>records.get(k),set:(k,v)=>records.set(k,v),pepper:'test-pepper',now:()=>now,
 hash:s=>crypto.createHash('sha256').update(s).digest('hex'),hmac,bytes:s=>Buffer.byteLength(s),remaining:()=>remaining,
 mail:(...args)=>mails.push(args),site:'https://example.test/app/'};
assert.equal(fingerprint('  A@Example.com ','test-pepper',hmac),hmac('a@example.com','test-pepper'));
assert.notEqual(fingerprint('a@example.com','other',hmac),fingerprint('a@example.com','test-pepper',hmac));
assert.throws(()=>fingerprint('a@example.com','',hmac));
assert.equal(canMail(now,now-599999,0,0,100),false);
assert.equal(canMail(now,0,now-599999,0,100),false);
assert.equal(canMail(now,0,0,70,100),false);
assert.equal(canMail(now,0,0,0,0),false);
assert.equal(canMail(now,now-600000,now-600000,69,1),true);
assert.equal(handle({action:'pull',userId:id},env).profile,null);
assert.equal(handle({action:'push',userId:id,profile,revision:0},env).revision,1);
assert.equal(handle({action:'push',userId:id,profile,revision:0},env).conflict,true);
assert.deepEqual(handle({action:'pull',userId:id},env).profile,profile);
assert.throws(()=>handle({action:'push',userId:'bad',profile},env));
assert.throws(()=>handle({action:'push',userId:id,profile:{...profile,device_id:id}},env));
assert.throws(()=>handle({action:'push',userId:id,profile:{...profile,progress:{x:'é'.repeat(140000)}}},env));
assert.throws(()=>handle({action:'push',userId:id,profile:{...profile,read_ids:'bad'}},env));
const unknown=handle({action:'restore_request',email:'missing@example.com'},env);
assert.deepEqual(handle({action:'backup',userId:id,email:'A@Example.com',lang:'en'},env),unknown);
assert.equal(mails.length,1);assert.equal(mails[0][0],'a@example.com');
assert.ok(mails[0][2].includes('?restore='+id));assert.ok(mails[0][2].includes('Khôi phục'));assert.ok(mails[0][2].includes('Restore'));
assert.equal(JSON.stringify([...records]).includes('@'),false);
assert.equal(JSON.stringify([...records]).includes('p:'+id),false);
assert.deepEqual(handle({action:'restore_request',email:'a@example.com'},env),unknown);assert.equal(mails.length,1);
now+=600000;
assert.deepEqual(handle({action:'restore_request',email:'a@example.com'},env),unknown);assert.equal(mails.length,2);
remaining=0;now+=600000;handle({action:'restore_request',email:'a@example.com'},env);assert.equal(mails.length,2);
assert.deepEqual(handle({action:'restore_request',email:'bad\nemail'},env),unknown);
{
  let parses=0,locks=0,received;
  const shim=vm.createContext({
    JSON:{parse:value=>{parses++;return JSON.parse(value);},stringify:JSON.stringify},
    Utilities:{newBlob:value=>({getBytes:()=>Buffer.from(value)})},
    LockService:{getScriptLock:()=>{locks++;return {tryLock:()=>false,hasLock:()=>false};}},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:value=>({value,setMimeType(){return this;}})}
  });
  vm.runInContext(fs.readFileSync(require.resolve('../backend/apps_script/Code.gs'),'utf8'),shim);
  const output={chat:true};
  shim.chatHandle_=request=>{received=request;return output;};
  const post=contents=>shim.doPost({postData:{contents}});
  assert.equal(post('{"action":"chat","message":"hello"}'),output);
  assert.deepEqual(received,{action:'chat',message:'hello'});
  assert.equal(parses,1);assert.equal(locks,0);
  delete shim.chatHandle_;
  assert.equal(JSON.parse(post('{"action":"chat"}').value).ok,false);
  assert.equal(parses,2);assert.equal(locks,1);
  shim.chatHandle_=()=>assert.fail('Oversized or malformed chat must not dispatch');
  assert.equal(JSON.parse(post(JSON.stringify({action:'chat',message:'x'.repeat(270000)})).value).ok,false);
  assert.equal(parses,2);assert.equal(locks,1);
  assert.equal(JSON.parse(post('{').value).ok,false);
  assert.equal(parses,3);assert.equal(locks,1);
}
console.log('Apps Script fingerprints, UUID/profile validation, revision conflicts, generic email responses, cooldowns, free quota caps and optional chat dispatch: OK');
