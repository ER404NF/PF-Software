// Run from the repository root: node docs/reviews/batch03-probes.mjs
// All writes use a unique OS temporary directory; no device/provider/network calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { FileSessionStore } from '../../system/server/src/fileSessionStore.js';
import * as lease from '../../system/server/src/deviceLease.js';
import { createTaskQueue } from '../../system/server/src/taskQueue.js';
import { executeSkillAction } from '../../system/server/src/platformSkill.js';
import { createInstagramSkill } from '../../system/server/src/platformSkills/instagramSkill.js';
import { findAccessibleElement, normalizedCenter } from '../../system/server/src/platformSkills/accessibilityTree.js';
import { createResearchTaskRunner } from '../../system/server/src/researchTaskRunner.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-batch03-'));
const skill = createInstagramSkill({appVersion:'fixture'});
const decision = action => ({action,target:null,confidence:1,screen_state:'feed',goal_progress:'working',reason:'fixture'});
const tree = {name:'Instagram home',x:0,y:0,width:100,height:200,children:[]};
const obs = {source:'ui_tree',ui_tree:tree};
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7ZkAAAAASUVORK5CYII=';
const call = (store, method, ...args) => new Promise((resolve,reject) => store[method](...args,(err,value)=>err?reject(err):resolve(value)));
const results = [];

// 1. A response finishing its touch after logout resurrects authentication.
const store = new FileSessionStore(path.join(root,'sessions'));
const session = {operator:{username:'fixture'},cookie:{expires:new Date(Date.now()+60000)}};
await call(store,'set','fixture',session);
let releaseRename, renameReached;
const reached = new Promise(resolve=>renameReached=resolve);
const realRename = store._renameWithRetry.bind(store);
store._renameWithRetry = (...args)=>{releaseRename=()=>realRename(...args);renameReached();};
const touching = call(store,'touch','fixture',session);
await reached;
await call(store,'destroy','fixture');
releaseRename(); await touching;
assert.equal((await call(store,'get','fixture')).operator.username,'fixture');
results.push('1 logout: destroyed session restored by delayed touch');

// 2. Read-only navigation chooses a publishing control.
const publishTree = {...tree,children:[{label:'Post comment',x:10,y:10,width:20,height:20},{label:'View comments',x:60,y:80,width:20,height:20}]};
let tapped;
const execution = await skill.execute(decision('open_comments'),{state:'comments',observation:{ui_tree:publishTree},device:{tap:async(x,y)=>{tapped={x,y};}}});
assert.match(execution.targetText,/post comment/);
results.push(`2 open_comments target: ${execution.targetText}, tap=${JSON.stringify(tapped)}`);

// 3. Scroll content larger than the viewport distorts all coordinates.
const target={label:'Profile',x:40,y:90,width:20,height:20};
const longTree={...tree,children:[target,{label:'Scroll content',x:0,y:0,width:100,height:2000}]};
const point=normalizedCenter(longTree,findAccessibleElement(longTree,['profile']));
assert.equal(point.y,.05);
results.push(`3 viewport: expected y=0.5, actual y=${point.y}`);

// 4. JSON visibility/enable flags are ignored, unlike XML.
const hiddenTree={...tree,children:[{label:'Profile',visible:false,enabled:false,x:0,y:0,width:20,height:20},{label:'Profile',visible:true,enabled:true,x:70,y:160,width:20,height:20}]};
assert.equal(findAccessibleElement(hiddenTree,['profile']).raw.visible,false);
results.push('4 JSON selector chose invisible, disabled target ahead of visible target');

// 5. A newly encountered challenge invokes Home recovery.
let homeCalls=0;
const challenged=await executeSkillAction({skill,decision:decision('scroll_next'),observation:obs,policyResult:{outcome:'ALLOWED',action:'scroll_next'},canExecute:()=>true,context:{device:{swipe:async()=>{},pressHome:async()=>{homeCalls++;}}},observeAfter:async()=>({ui_tree:{...tree,name:'Security code'}})});
assert.equal(homeCalls,1);assert.equal(challenged.outcome,'FAILED_VERIFICATION');
results.push('5 challenge after navigation: FAILED_VERIFICATION, Home pressed once');

// 6. Revocation during capture still writes evidence and reads again.
let authorized=true,saved=0,afterReads=0;
const capture=await executeSkillAction({skill,decision:decision('capture_screenshot'),observation:obs,policyResult:{outcome:'ALLOWED',action:'capture_screenshot'},canExecute:()=>authorized,context:{device:{render:async()=>{authorized=false;return {kind:'image',mime:'image/png',data:png};}},saveScreenshot:()=>{saved++;return {ref:'fixture',bytes:Buffer.from(png,'base64').length};}},observeAfter:async()=>{afterReads++;return obs;}});
assert.equal(saved,1);assert.equal(afterReads,1);assert.equal(capture.outcome,'VERIFIED');
results.push('6 revoked during render: evidence write=1, subsequent observation=1, VERIFIED');

// 7. Ordinary cancellation between steps never finalizes an existing run.
lease.reset();
const device={id:'runner',status:'idle',getUiTree:async()=>tree,render:async()=>({kind:'image',mime:'image/png',data:png})};
const devices=new Map([[device.id,device]]);
const q=createTaskQueue({devices,deviceLease:lease,storePath:path.join(root,'runner.json')});
let finalized=0,created=0,task;
const runner=createResearchTaskRunner({taskQueue:q,devices,deviceLease:lease,accountWorkspaces:new Map([['a','w']]),accountPolicies:new Map([['a',{observe:'ALLOW_AUTONOMOUS'}]]),providerForTask:()=>({observeAndPlan:async()=>({...decision('observe'),candidate:{platform_content_id:'post1'}})}),skillForPlatform:()=>skill,operatorForUsername:()=>({username:'fixture',allowedDevices:null}),workspaceForOperatorAccount:()=> 'w',createRunRecord:()=>{created++;return {id:'run1'};},appendCandidateRecord:()=>({id:'c1'}),finalizeRunRecord:()=>{finalized++;return {id:'run1'};},saveEvidenceRecord:()=>({ref:'fixture',bytes:5}),sleep:async()=>{q.cancelTask(task.id);}});
task=q.addTask({kind:'research',goal:'fixture',createdBy:'fixture',accountSelector:{platform:'instagram',accountId:'a'}});
const runResult=await runner.runTask({task,deviceId:device.id});
assert.equal(runResult.outcome,'CANCELLED');assert.equal(created,1);assert.equal(finalized,0);
results.push('7 cancelled between steps: created runs=1, finalized runs=0');

// 8. Persist failure makes stop unrecoverable through stopDevice alone.
lease.reset();
const storePath=path.join(root,'queue.json');
const queue=createTaskQueue({devices:new Map([['d',{id:'d',status:'idle'}]]),deviceLease:lease,storePath});
const active=queue.addTask({goal:'fixture'});
const write=fs.writeFileSync;
fs.writeFileSync=(file,...args)=>{if(String(file).startsWith(storePath+'.'))throw Object.assign(new Error('fixture disk full'),{code:'ENOSPC'});return write(file,...args);};
try {assert.throws(()=>queue.stopDevice('d'),/disk full/);} finally {fs.writeFileSync=write;}
assert.equal(active.state,'CANCELLED');assert.equal(lease.getMode('d'),'AI_RUNNING');
results.push('8 failed stop snapshot: task=CANCELLED, lease=AI_RUNNING, on-disk task=RUNNING');

// 9. Execute the actual server error funnel and client deselect function.
const serverSource=fs.readFileSync(new URL('../../system/server/src/index.js',import.meta.url),'utf8');
const clientSource=fs.readFileSync(new URL('../../system/client/app.js',import.meta.url),'utf8');
const serverContext={selected:{id:'d',status:'in-use'},ws:{send:()=>{}},recordFailure:()=>1,OFFLINE_AFTER_FAILURES:3,broadcastDeviceList:()=>{}};
vm.createContext(serverContext);
vm.runInContext(serverSource.slice(serverSource.indexOf('  const reportError ='),serverSource.indexOf('  const sendFrame ='))+'\nreportError("transient failure");',serverContext);
let sends=0;
const clientContext={fileRequestGeneration:0,currentDeviceId:'d',setBusy:()=>{},showFleetView:()=>{},safeSend:()=>{sends++;}};
for(const name of ['screenEl','hintEl','uploadFormEl','swipeControlsEl','homeButtonEl','typeFormEl','releaseButtonEl','fileListEl','filesHintEl'])clientContext[name]={};
vm.createContext(clientContext);
const start=clientSource.indexOf('function deselect(message)');
const end=clientSource.indexOf('\n}',start)+2;
vm.runInContext(clientSource.slice(start,end)+'\ndeselect("transient failure");',clientContext);
assert.equal(serverContext.selected.status,'in-use');assert.equal(clientContext.currentDeviceId,null);assert.equal(sends,0);
results.push('9 transient error: server still owns device; client clears selection, hides release, sends no release');

// 10. Emergency stop admits a new owner while old input is unfinished.
lease.reset();lease.switchToAI('e');lease.applyEvent('e','START_TASK');
let finishInput; const input=new Promise(resolve=>finishInput=resolve);
lease.registerPendingAiAction('e',input);lease.emergencyStop('e');
assert.equal(lease.canHumanSelect('e'),true);
results.push('10 emergency stop: pending physical input unresolved, canHumanSelect=true');
finishInput();lease.reset();
console.log(results.join('\n'));
console.log('Temporary fixture directory: '+root);
