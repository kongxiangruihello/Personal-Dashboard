export const SCOPES={google:['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/calendar.readonly'],dida:['tasks:read']};
export function shanghaiWindow(now=new Date()) {
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const first=new Date(today+'T00:00:00+08:00');
  const day=n=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(first.getTime()+n*86400000));
  return {today,tomorrow:day(1),timeMin:today+'T00:00:00+08:00',timeMax:day(2)+'T00:00:00+08:00',timezone:'Asia/Shanghai'};
}
export function eventDays(e,window) {
  const start=e.start?.dateTime||e.start?.date, end=e.end?.dateTime||e.end?.date;
  if(!start||!end)return [];
  const ms=v=>Date.parse(v.length===10?v+'T00:00:00+08:00':v);
  return [window.today,window.tomorrow].filter(day=>{const d=ms(day);return ms(start)<d+86400000&&ms(end)>d});
}
export function normalizeEvent(e,calendar,window){return {id:e.id,title:e.summary||'（无标题）',start:e.start?.dateTime||e.start?.date,end:e.end?.dateTime||e.end?.date,allDay:!!e.start?.date,days:eventDays(e,window),location:e.location||'',url:e.htmlLink||'https://calendar.google.com/',calendar:calendar.summary||'Google 日历'};}
export function normalizeMail(m){const headers=m.payload?.headers||[];const get=n=>headers.find(h=>h.name.toLowerCase()===n.toLowerCase())?.value||'';return {id:m.id,threadId:m.threadId,title:get('Subject')||'（无主题）',from:get('From'),date:Number(m.internalDate)||0,snippet:m.snippet||'',url:`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(m.threadId||m.id)}`};}
export class ProviderError extends Error {constructor(message,status=502){super(message);this.status=status}}
export async function jsonRequest(url,options={}) {
  let response;
  try{response=await fetch(url,{...options,signal:AbortSignal.timeout(20000)})}catch{throw new ProviderError('连接超时或网络不可用，请稍后重试。')}
  if(!response.ok){const status=response.status;throw new ProviderError(status===401?'授权已失效，请重新连接账户。':status===403?'未获得读取权限，或尚未启用相应 API。':status===429?'请求过于频繁，请稍后再试。':'服务暂时不可用，请稍后重试。',status)}
  try{return await response.json()}catch{throw new ProviderError('服务返回了无法读取的数据。')}
}
export async function allPages(get,path,key='items',params={}){let items=[],token;let pages=0;do{const data=await get(path,{...params,...(token?{pageToken:token}:{})});if(!Array.isArray(data[key]||[]))throw new ProviderError('返回的数据格式无效');items.push(...(data[key]||[]));token=data.nextPageToken;if(++pages>100)throw new ProviderError('数据量较大，读取未完成，请缩小日历范围。')}while(token);return items;}
export async function readCalendar(get,now=new Date()){
  const window=shanghaiWindow(now);
  const calendars=await allPages(get,'calendar/v3/users/me/calendarList','items',{maxResults:250});
  const selected=calendars.filter(c=>(c.primary||c.selected)&&!c.hidden&&c.accessRole!=='freeBusyReader');
  const results=await Promise.allSettled(selected.map(async c=>{const events=await allPages(get,`calendar/v3/calendars/${encodeURIComponent(c.id)}/events`,'items',{timeMin:window.timeMin,timeMax:window.timeMax,timeZone:'Asia/Shanghai',singleEvents:true,orderBy:'startTime',maxResults:250});return events.filter(e=>e.status!=='cancelled').map(e=>normalizeEvent(e,c,window));}));
  const errors=results.flatMap((r,i)=>r.status==='rejected'?[`${selected[i].summary||'日历'}：${r.reason.message}`]:[]);
  if(selected.length&&errors.length===selected.length)throw new ProviderError('日历读取失败。'+errors.join('；'));
  return {...window,events:results.flatMap(r=>r.status==='fulfilled'?r.value:[]).sort((a,b)=>a.start.localeCompare(b.start)),calendars:selected.map(c=>c.summary),warnings:errors};
}
export async function readMail(get,pageToken=''){
  const data=await get('gmail/v1/users/me/messages',{q:'is:unread -in:spam -in:trash',maxResults:50,...(pageToken?{pageToken}:{})});
  const messages=data.messages||[];const output=[];
  for(let i=0;i<messages.length;i+=8){const values=await Promise.all(messages.slice(i,i+8).map(async m=>{try{const full=await get(`gmail/v1/users/me/messages/${encodeURIComponent(m.id)}`,{format:'metadata',metadataHeaders:['From','Subject','Date']});return full.labelIds?.includes('UNREAD')?normalizeMail(full):null}catch(e){if(e.status===404)return null;throw e}}));output.push(...values.filter(Boolean))}
  return {messages:output,nextPageToken:data.nextPageToken||null};
}
export async function readDida(get,followed=[]){
  const projects=await get('/project');if(!Array.isArray(projects))throw new ProviderError('滴答清单返回的数据格式无效。');
  const ids=[...new Set(['inbox',...projects.map(p=>p.id)])],tasks=[];
  for(let i=0;i<ids.length;i+=5){const data=await Promise.all(ids.slice(i,i+5).map(id=>get(`/project/${encodeURIComponent(id)}/data`)));for(let j=0;j<data.length;j++){const projectId=ids[i+j];for(const t of data[j].tasks||[]){if(t.status!==0)continue;tasks.push({id:t.id,projectId:t.projectId||projectId,title:t.title||'（无标题）',due:t.dueDate||'',project:projects.find(p=>p.id===projectId)?.name||'收集箱',url:'https://dida365.com/webapp/',followed:followed.includes(t.id)})}}}
  return {tasks:tasks.filter(t=>t.followed),available:tasks,pinSupported:false};
}
