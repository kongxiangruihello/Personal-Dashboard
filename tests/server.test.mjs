import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
test('local server isolates secrets and requires same-origin CSRF; OAuth state is bound to browser',async()=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'dashboard-test-'));const port=18765,origin=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['server/index.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:String(port),DASHBOARD_DATA_DIR:dataDir},stdio:['ignore','pipe','pipe']});
 try{await Promise.race([once(child.stdout,'data'),new Promise((_,reject)=>setTimeout(()=>reject(Error('server failed to start')),5000).unref())]);
 let r=await fetch(origin+'/api/dashboard');assert.equal(r.status,401);
 r=await fetch(origin+'/.private/local.key');assert.equal(r.status,404);
 r=await fetch(origin+'/server/index.mjs');assert.equal(r.status,404);
 r=await fetch(origin+'/api/session',{headers:{Origin:'https://malicious.example'}});assert.equal(r.status,403);
 r=await fetch(origin+'/api/session');const cookie=r.headers.get('set-cookie').split(';')[0];const {csrf}=await r.json();
 const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf};
 r=await fetch(origin+'/api/config/google',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,403);
 r=await fetch(origin+'/api/config/google',{method:'POST',headers,body:JSON.stringify({clientId:'test-client',clientSecret:'test-secret'})});assert.equal(r.status,200);assert.ok(!(await r.text()).includes('test-secret'));
 r=await fetch(origin+'/api/connect/google',{method:'POST',headers,body:'{}'});const {url}=await r.json();const auth=new URL(url);assert.equal(auth.hostname,'accounts.google.com');assert.equal(auth.searchParams.get('code_challenge_method'),'S256');assert.equal(auth.searchParams.get('access_type'),'offline');assert.ok(auth.searchParams.get('scope').includes('gmail.readonly'));
 r=await fetch(origin+'/auth/google/callback?state='+auth.searchParams.get('state')+'&code=test',{redirect:'manual'});assert.equal(r.status,400);
 r=await fetch(origin+'/api/dashboard',{headers:{Cookie:cookie}});const dashboard=await r.json();assert.equal(dashboard.mail.status,'disconnected');assert.equal(dashboard.calendar.status,'disconnected');assert.ok(!JSON.stringify(dashboard).includes('test-secret'));
 r=await fetch(origin);assert.ok(r.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
 }finally{child.kill();await once(child,'exit');await rm(dataDir,{recursive:true,force:true})}
});
