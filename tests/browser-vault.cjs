'use strict';
/* OPENVITA browser integration: synthetic records, real Web Crypto and browser storage. Harness adapted from Studio Niko NikoAssist (GPL-3.0-or-later); this test retains that license. */
// SPDX-License-Identifier: GPL-3.0-or-later
const assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const port=19487,base='http://127.0.0.1:'+port;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function poll(fn,label,timeout=20000){
 const start=Date.now();let error;
 while(Date.now()-start<timeout){
  try{const result=await fn();if(result)return result;}catch(e){error=e;}
  await sleep(120);
 }
 throw new Error('Timeout '+label+(error?': '+error.message:''));
}
function chromeBinary(){
 if(process.env.CHROME_BIN)return process.env.CHROME_BIN;
 for(const candidate of ['google-chrome','google-chrome-stable','chromium','chromium-browser']){
  try{return execFileSync('which',[candidate],{encoding:'utf8'}).trim();}catch{}
 }
 throw Error('Chromium non disponible sur ce runner.');
}
async function main(){
 let server,chrome,ws;const pending=new Map(),browserErrors=[],httpPosts=[];
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'openvita-browser-'));
 let seq=0,diagnostics='';
 try{
  server=spawn('python3',['-m','http.server',String(port),'--bind','127.0.0.1','--directory','.'],{
   cwd:root,stdio:['ignore','ignore','pipe']
  });
  server.stderr.on('data',chunk=>diagnostics+=String(chunk).slice(-1000));
  await poll(async()=>{const r=await fetch(base+'/');return r.status===200},'local web server');
  chrome=spawn(chromeBinary(),['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
   '--no-first-run','--no-default-browser-check','--disable-background-networking',
   '--remote-debugging-port=0','--remote-allow-origins=*',
   '--user-data-dir='+path.join(tmp,'chrome'),'about:blank'],{stdio:['ignore','ignore','pipe']});
  chrome.stderr.on('data',chunk=>diagnostics+=String(chunk).slice(-1000));
  const debuggerPort=await poll(async()=>{
   const raw=await fs.readFile(path.join(tmp,'chrome','DevToolsActivePort'),'utf8');
   return Number(raw.split('\n')[0]);
  },'Chrome DevTools');
  const tabs=await(await fetch('http://127.0.0.1:'+debuggerPort+'/json/list')).json();
  const tab=tabs.find(x=>x.type==='page');
  assert.ok(tab?.webSocketDebuggerUrl,'Chrome debugger page missing');
  ws=new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{
   ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});
  });
  ws.addEventListener('message',event=>{
   const msg=JSON.parse(event.data);
   if(msg.method==='Runtime.exceptionThrown')browserErrors.push(msg.params?.exceptionDetails?.exception?.description||'Browser exception');
   if(msg.method==='Network.requestWillBeSent'&&msg.params?.request?.method==='POST')httpPosts.push(msg.params.request.url);
   if(!msg.id||!pending.has(msg.id))return;
   const p=pending.get(msg.id);pending.delete(msg.id);
   msg.error?p.reject(Error(JSON.stringify(msg.error))):p.resolve(msg.result);
  });
  function call(method,params={}){
   const id=++seq;
   return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('DevTools timeout '+method));},12000);
    pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
    ws.send(JSON.stringify({id,method,params}));
   });
  }
  async function evaluate(expression){
   const out=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
   if(out.exceptionDetails)throw Error('Browser JS: '+(out.exceptionDetails.exception?.description||out.exceptionDetails.text));
   return out.result?.value;
  }
  const wait=(expression,label)=>poll(()=>evaluate(expression),label,15000);
  await call('Page.enable');await call('Runtime.enable');await call('Network.enable');
  await call('Page.navigate',{url:base+'/'});
  const pass='test-vault-only-2026', other='other-test-vault-2026', store='studio-niko-openvita-v1';
  const expr=(fn,...args)=>'('+fn.toString()+')('+args.map(x=>JSON.stringify(x)).join(',')+')';
  const perform=(fn,...args)=>evaluate(expr(fn,...args));
  const ready=()=>wait('document.readyState==="complete"&&!!document.querySelector("#unlock")','journal initialized');
  const idle=()=>wait('!document.querySelector("#unlock").disabled','operation finished');
  const submit=async(p,confirmation=p)=>{await perform((p,q)=>{document.querySelector('#pass').value=p;document.querySelector('#confirm-pass').value=q;document.querySelector('#unlock-form').requestSubmit()},p,confirmation);await idle()};
  const raw=()=>perform(k=>localStorage.getItem(k),store);
  const add=async(value,note)=>{await perform((v,n)=>{document.querySelector('#value').value=v;document.querySelector('#note').value=n;document.querySelector('#entry-form').requestSubmit()},value,note);await idle()};
  const count=()=>evaluate('document.querySelectorAll("#history li").length');
  const restore=async(data,p)=>{await perform((data,p)=>{const dt=new DataTransfer();dt.items.add(new File([data],'fixture.json',{type:'application/json'}));document.querySelector('#restore-file').files=dt.files;document.querySelector('#restore-pass').value=p;document.querySelector('#restore').click()},data,p);await idle()};
  await ready();
  assert.equal(await evaluate('isSecureContext&&!!crypto.subtle'),true);
  await submit(pass);
  assert.equal(await evaluate('!document.querySelector("#workspace").hidden'),true);
  await add('123','SYNTHETIC_QA_NOTE_ONLY');
  assert.equal(await count(),1);
  const saved=await raw(), envelope=JSON.parse(saved);
  assert.equal(envelope.format,'openvita-vault-v1');
  assert.equal(Buffer.from(envelope.salt,'base64').length,16);
  assert.equal(Buffer.from(envelope.iv,'base64').length,12);
  assert.ok(!saved.includes('SYNTHETIC_QA_NOTE_ONLY')&&!saved.includes(pass));
  await perform(()=>{const orig=URL.createObjectURL.bind(URL);URL.createObjectURL=b=>{window.__qaBlob=b;return orig(b)};document.querySelector('#backup').click()});
  await idle();
  const backup=await evaluate('window.__qaBlob.text()');
  assert.equal(backup,saved,'Actual export blob equals encrypted vault');
  await perform(()=>document.querySelector('#lock').click());
  assert.equal(await count(),0);
  await submit(other);
  assert.equal(await evaluate('document.querySelector("#workspace").hidden'),true);
  assert.equal(await raw(),saved,'Wrong password leaves ciphertext unchanged');
  await submit(pass);
  assert.equal(await count(),1);
  await call('Page.navigate',{url:base+'/?reload=1'});await ready();
  assert.equal(await evaluate('document.querySelector("#workspace").hidden'),true);
  await submit(pass);
  assert.equal(await count(),1);
  await perform(()=>{document.querySelector('#history button').click();document.querySelector('#value').value='124';document.querySelector('#entry-form').requestSubmit()});
  await idle();
  assert.ok((await evaluate('document.querySelector("#history").textContent')).includes('124 mg/dL'));
  const edited=await raw();
  assert.notEqual(JSON.parse(edited).iv,envelope.iv,'Fresh IV after edit');
  await perform(()=>{window.confirm=()=>true;document.querySelector('#history button:last-child').click()});
  await idle();assert.equal(await count(),0);
  // Alter one ciphertext byte, preserving valid base64.
  const corrupted=JSON.parse(backup), bytes=Buffer.from(corrupted.ciphertext,'base64');bytes[0]^=1;corrupted.ciphertext=bytes.toString('base64');
  const empty=await raw();
  await restore(JSON.stringify(corrupted),'');
  assert.equal(await raw(),empty,'Tampered backup rejected atomically');
  await restore(backup,'');
  assert.equal(await count(),1);
  assert.ok((await evaluate('document.querySelector("#history").textContent')).includes('123 mg/dL'));
  // Isolated test browser only: emulate a fresh vault with a different key/salt.
  await perform(k=>{document.querySelector('#lock').click();localStorage.removeItem(k)},store);
  await call('Page.navigate',{url:base+'/?fresh=1'});await ready();await submit(other);
  const newSalt=JSON.parse(await raw()).salt;
  await perform(()=>{window.confirm=()=>true});
  await restore(backup,pass);
  assert.equal(await count(),1);
  assert.equal(JSON.parse(await raw()).salt,newSalt,'Portable restore re-encrypts under destination key');
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:3,mobile:true});
  assert.equal(await evaluate('(()=>{const b=document.querySelector("#save").getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&b.height>=40})()'),true);
  assert.deepEqual(browserErrors,[],'Uncaught JS errors');
  assert.deepEqual(httpPosts,[],'Journal must not POST data');
  console.log('OPENVITA CHROMIUM PASS: real Web Crypto, encrypted export, wrong password, reload, edit/delete, tampered backup, portable restore, mobile viewport, no POST');
 }catch(error){
  throw Error(error.message+(diagnostics?'\nBrowser diagnostics: '+diagnostics.slice(-1000):''));
 }finally{
  try{ws?.close();}catch{}
  try{chrome?.kill('SIGKILL');}catch{}
  try{server?.kill('SIGTERM');}catch{}
  await sleep(300);
  await fs.rm(tmp,{recursive:true,force:true,maxRetries:6,retryDelay:200}).catch(()=>{});
 }
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
