import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const integrations=fs.readFileSync(new URL('../dist/integrations.js',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../dist/app.js',import.meta.url),'utf8');
function context(){const element={innerHTML:'',style:{}};const ctx=vm.createContext({console,URL,Date,crypto:globalThis.crypto,structuredClone,setTimeout,clearTimeout,setInterval:()=>0,clearInterval(){},localStorage:{getItem:()=>null,setItem(){}},document:{body:{classList:{toggle(){}}},getElementById:()=>element,querySelectorAll:()=>[],addEventListener(){}},fetch:async()=>{throw Error('No network in unit tests')}});vm.runInContext(integrations,ctx);vm.runInContext(app.replace('startConnections();',''),ctx);return ctx}
test('navigation renames and mail rendering escape remote fields',()=>{const ctx=context();const html=vm.runInContext(`integration.mail={status:'ok',data:{messages:[{id:'x',from:'<b>Sender</b>',title:'<img src=x>',snippet:'<script>bad()</script>',url:'javascript:alert(1)',date:0}]}};mailPage()`,ctx);assert.ok(html.includes('我的邮件'));assert.ok(html.includes('&lt;img src=x&gt;'));assert.ok(!html.includes('href="javascript:'));assert.ok(!html.includes('<script>bad'))});
test('disconnected is not represented as an empty inbox',()=>{const ctx=context();const html=vm.runInContext('mailPage()',ctx);assert.ok(html.includes('前往连接账户'));assert.ok(!html.includes('没有未读邮件'))});
test('old backups and goals are retained while nav changes',()=>{const ctx=context();assert.ok(vm.runInContext('valid(fresh())',ctx));assert.ok(app.includes("['plan','我的日程']"));assert.ok(app.includes("['mail','我的邮件']"));assert.ok(!app.includes("['goals','我的目标']"));});
