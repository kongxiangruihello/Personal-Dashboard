import http from 'node:http';
import {readFile,writeFile,mkdir,chmod,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomBytes,createCipheriv,createDecipheriv,createHash,timingSafeEqual} from 'node:crypto';
import {SCOPES,jsonRequest,readCalendar,readMail,readDida,shanghaiWindow} from './providers.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.PORT||8765);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid port');
const origin=`http://127.0.0.1:${port}`,privateDir=process.env.DASHBOARD_DATA_DIR||path.join(root,'.private');
await mkdir(privateDir,{recursive:true,mode:0o700});await chmod(privateDir,0o700);
const keyFile=path.join(privateDir,'local.key');let key;
try{key=await readFile(keyFile)}catch(e){if(e.code!=='ENOENT')throw e;key=randomBytes(32);await writeFile(keyFile,key,{mode:0o600,flag:'wx'})}
await chmod(keyFile,0o600);if(key.length!==32)throw Error('Invalid local key');
const vaultFile=path.join(privateDir,'vault.enc');let vault={configs:{},tokens:{},followed:[]};
try{const payload=JSON.parse(await readFile(vaultFile,'utf8'));const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(payload.iv,'base64'));decipher.setAuthTag(Buffer.from(payload.tag,'base64'));vault=JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data,'base64')),decipher.final()]).toString())}catch(e){if(e.code!=='ENOENT')throw Error('Cannot read local authorization store; preserve .private and restore its matching key.')}
let writeQueue=Promise.resolve();
function saveVault(){const snapshot=JSON.stringify(vault);writeQueue=writeQueue.catch(()=>{}).then(async()=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(snapshot),cipher.final()]);const temp=vaultFile+'.tmp';await writeFile(temp,JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}),{mode:0o600});await chmod(temp,0o600);await rename(temp,vaultFile)});return writeQueue}
const sessions=new Map(),pending=new Map(),refreshLocks=new Map(),dataCache={};
const endpoints={google:{auth:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token'},dida:{auth:'https://dida365.com/oauth/authorize',token:'https://dida365.com/oauth/token'}};
const safeEq=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function send(res,status,data,headers={}){res.writeHead(status,{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Type':'application/json; charset=utf-8',...headers});res.end(typeof data==='string'?data:JSON.stringify(data))}
const jsonBody=async req=>{let body='';for await(const chunk of req){body+=chunk;if(body.length>64000)throw Error('请求过大')}return JSON.parse(body||'{}')};
function currentSession(req){const id=(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('pd_session='))?.slice(11);const s=sessions.get(id);if(!s||s.expires<Date.now()){sessions.delete(id);return null}return {id,...s}}
function status(){return Object.fromEntries(['google','dida'].map(p=>[p,{configured:!!(vault.configs[p]?.clientId&&vault.configs[p]?.clientSecret),connected:!!vault.tokens[p]?.access_token,redirectUri:`${origin}/auth/${p}/callback` }]))}
async function token(provider){const t=vault.tokens[provider];if(!t?.access_token)throw Error('请先连接账户。');if(!t.expiresAt||t.expiresAt>Date.now()+60000)return t.access_token;if(provider!=='google'||!t.refresh_token)throw Error('授权已过期，请重新连接账户。');if(!refreshLocks.has(provider)){refreshLocks.set(provider,(async()=>{const config=vault.configs[provider];const next=await jsonRequest(endpoints[provider].token,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,grant_type:'refresh_token',refresh_token:t.refresh_token})});vault.tokens[provider]={...t,...next,expiresAt:Date.now()+Number(next.expires_in||3600)*1000};await saveVault();return next.access_token})().finally(()=>refreshLocks.delete(provider)))}return refreshLocks.get(provider)}
async function googleGet(route,params={}){const url=new URL('https://www.googleapis.com/'+route);for(const [k,v] of Object.entries(params))for(const val of Array.isArray(v)?v:[v])url.searchParams.append(k,String(val));return jsonRequest(url,{headers:{Authorization:`Bearer ${await token('google')}`}})}
async function didaGet(route){return jsonRequest('https://api.dida365.com/open/v1'+route,{headers:{Authorization:`Bearer ${await token('dida')}`}})}
async function cached(name,load){const entry=dataCache[name];if(entry&&Date.now()-entry.at<55000)return entry.value;const value=await load();dataCache[name]={at:Date.now(),value};return value}
async function resource(name,provider,load){if(!vault.tokens[provider])return {status:'disconnected',error:'请在个人中心连接账户。'};try{const data=await cached(name,load);return {status:'ok',data,updatedAt:new Date(dataCache[name].at).toISOString()}}catch(e){const old=dataCache[name];return {status:'error',error:e.message,...(old?{data:old.value,updatedAt:new Date(old.at).toISOString()}: {})}}}
let syncLock;
async function sync(){if(syncLock)return syncLock;syncLock=(async()=>{const day=shanghaiWindow().today;const [calendar,mail,dida]=await Promise.all([resource('calendar-'+day,'google',()=>readCalendar(googleGet)),resource('mail','google',()=>readMail(googleGet)),resource('dida','dida',()=>readDida(didaGet,vault.followed||[]))]);return {calendar,mail,dida,connections:status(),timezone:'Asia/Shanghai'}})().finally(()=>syncLock=null);return syncLock}
const server=http.createServer(async(req,res)=>{try{
  if(req.headers.host!==`127.0.0.1:${port}`)return send(res,403,{error:`请使用 ${origin}`});
  if(req.headers.origin&&req.headers.origin!==origin)return send(res,403,{error:'不允许跨站请求'});
  if(req.headers['sec-fetch-site']==='cross-site'&&!req.url.startsWith('/auth/'))return send(res,403,{error:'不允许跨站请求'});
  const url=new URL(req.url,origin),pathname=url.pathname;
  if(pathname==='/api/session'&&req.method==='GET'){
    let s=currentSession(req);if(!s){if(sessions.size>1000)sessions.clear();const id=randomBytes(32).toString('hex');s={id,csrf:randomBytes(32).toString('hex'),expires:Date.now()+86400000};sessions.set(id,s);res.setHeader('Set-Cookie',`pd_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`)}
    return send(res,200,{csrf:s.csrf,connections:status()});
  }
  const callback=pathname.match(/^\/auth\/(google|dida)\/callback$/);
  if(callback&&req.method==='GET'){
    const provider=callback[1],s=currentSession(req),state=url.searchParams.get('state'),request=pending.get(state);pending.delete(state);
    if(!s||!request||request.sessionId!==s.id||request.provider!==provider||request.expires<Date.now())return send(res,400,'授权请求无效或已过期，请返回 App 重新连接。',{'Content-Type':'text/plain; charset=utf-8'});
    if(url.searchParams.has('error'))return send(res,302,'',{'Location':'/?connection=cancelled'});
    const code=url.searchParams.get('code');if(!code)return send(res,400,{error:'缺少授权码'});
    const config=vault.configs[provider],body=new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:`${origin}/auth/${provider}/callback`});
    const headers={'Content-Type':'application/x-www-form-urlencoded'};
    if(provider==='google'){body.set('client_id',config.clientId);body.set('client_secret',config.clientSecret);body.set('code_verifier',request.verifier)}else{headers.Authorization='Basic '+Buffer.from(config.clientId+':'+config.clientSecret).toString('base64');body.set('scope','tasks:read')}
    const response=await jsonRequest(endpoints[provider].token,{method:'POST',headers,body});
    if(!response.access_token)throw Error('未收到访问凭据');
    if(provider==='google'&&(!response.scope||SCOPES.google.some(scope=>!response.scope.split(' ').includes(scope))))return send(res,400,'需要同时允许 Gmail 和 Google 日历的只读权限，请返回 App 重新连接。',{'Content-Type':'text/plain; charset=utf-8'});
    // Never combine a newly authorized account with another account's old refresh token.
    vault.tokens[provider]={...response,expiresAt:response.expires_in?Date.now()+Number(response.expires_in)*1000:0};await saveVault();for(const k of Object.keys(dataCache))delete dataCache[k];
    return send(res,302,'',{'Location':'/?connection=success'});
  }
  if(pathname.startsWith('/api/')){
    const s=currentSession(req);if(!s)return send(res,401,{error:'本机会话已过期，请刷新页面。'});
    if(req.method==='POST'&&(req.headers.origin!==origin||!safeEq(req.headers['x-csrf-token'],s.csrf)))return send(res,403,{error:'请求验证失败，请刷新页面。'});
    if(pathname==='/api/dashboard'&&req.method==='GET')return send(res,200,await sync());
    if(pathname==='/api/mail'&&req.method==='GET'){const pageToken=url.searchParams.get('pageToken');if(!pageToken||pageToken.length>4096)return send(res,400,{error:'无效的分页参数'});return send(res,200,await readMail(googleGet,pageToken))}
    const configure=pathname.match(/^\/api\/config\/(google|dida)$/);
    if(configure&&req.method==='POST'){const provider=configure[1],body=await jsonBody(req);const clientId=body.clientId?.trim(),clientSecret=body.clientSecret?.trim();if(!clientId||!clientSecret||clientId.length>1000||clientSecret.length>1000)return send(res,400,{error:'请填写有效的应用 ID 和密钥。'});vault.configs[provider]={clientId,clientSecret};delete vault.tokens[provider];await saveVault();for(const k of Object.keys(dataCache))delete dataCache[k];return send(res,200,{ok:true,connections:status()})}
    const connect=pathname.match(/^\/api\/connect\/(google|dida)$/);
    if(connect&&req.method==='POST'){const provider=connect[1],config=vault.configs[provider];if(!config)return send(res,400,{error:'请先配置应用授权信息。'});for(const [k,v] of pending)if(v.expires<Date.now())pending.delete(k);const state=randomBytes(32).toString('hex'),verifier=randomBytes(48).toString('base64url');pending.set(state,{provider,verifier,sessionId:s.id,expires:Date.now()+600000});const redirect=new URL(endpoints[provider].auth);Object.entries({client_id:config.clientId,redirect_uri:`${origin}/auth/${provider}/callback`,response_type:'code',scope:SCOPES[provider].join(' '),state,...(provider==='google'?{access_type:'offline',prompt:'consent',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}:{})}).forEach(([k,v])=>redirect.searchParams.set(k,v));return send(res,200,{url:redirect.href})}
    const disconnect=pathname.match(/^\/api\/disconnect\/(google|dida)$/);
    if(disconnect&&req.method==='POST'){delete vault.tokens[disconnect[1]];await saveVault();for(const k of Object.keys(dataCache))delete dataCache[k];return send(res,200,{ok:true})}
    if(pathname==='/api/dida/followed'&&req.method==='POST'){const {ids}=await jsonBody(req);if(!Array.isArray(ids)||ids.length>500||ids.some(i=>typeof i!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(i)))return send(res,400,{error:'无效任务列表'});vault.followed=[...new Set(ids)];await saveVault();delete dataCache.dida;return send(res,200,{ok:true})}
    return send(res,404,{error:'接口不存在'});
  }
  if(req.method!=='GET'&&req.method!=='HEAD')return send(res,405,{error:'不支持此操作'});
  const staticFiles={'/':'index.html','/index.html':'index.html','/style.css':'style.css','/app.js':'app.js','/integrations.js':'integrations.js'};
  const file=staticFiles[pathname];if(!file)return send(res,404,{error:'页面不存在'});
  const content=await readFile(path.join(root,'dist',file));
  res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});res.end(req.method==='HEAD'?undefined:content);
}catch(e){send(res,500,{error:e instanceof SyntaxError?'请求格式无效。':e.message||'操作失败，请重试。'})}});
server.listen(port,'127.0.0.1',()=>console.log(`Personal Dashboard: ${origin}`));
