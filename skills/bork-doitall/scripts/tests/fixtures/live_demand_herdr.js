'use strict';
const root=require('node:path').resolve(__dirname, '../../../../..');
const {privatePty}=require(root+'/tests/fixtures/pty.js');
const {fs,P,run,sleep,assert}=require(root+'/tests/support.js');
const dir=fs.mkdtempSync('/tmp/i16-herdr-production-'),session='i16-production-'+process.pid,env={...process.env,HERDR_ENV:'1',TERM:'xterm-256color'};
const clientEnv={...env};delete clientEnv.HERDR_ENV;delete clientEnv.HERDR_PANE_ID;const pty=privatePty(['herdr','--session',session],{env:clientEnv,columns:240,rows:95});let n=0;
/** Address only this fixture's private session. */
function cmd(...args){const r=run(['herdr','--session',session,...args],{env,timeout:15});if(r.status)throw Error(r.stdout+r.stderr);return JSON.parse(r.stdout).result;}
/** Execute the public serialized production lifecycle. */
function action(name,input={}){const before=cmd('api','snapshot').snapshot.focused_pane_id;const file=dir+'/'+(++n)+'.json';fs.writeFileSync(file,JSON.stringify({record:dir+'/layout.json',...input}));const r=run([process.execPath,root+'/skills/bork-doitall/scripts/layout.js',name,file],{env,timeout:45});console.log(name,r.stdout,r.stderr);const response=JSON.parse(r.stdout);assert.equal(response.ok,true,response.error);const after=cmd('api','snapshot').snapshot.focused_pane_id;assert.equal(after,response.result.id===before&&name==='release'?JSON.parse(fs.readFileSync(dir+'/layout.json')).coordinator:before);return response.result;}
try{
 sleep(1);let snap=cmd('api','snapshot').snapshot;if(!snap.panes.length){cmd('workspace','create','--cwd',dir,'--label','proof','--focus');sleep(.3);snap=cmd('api','snapshot').snapshot;}
 const coordinator=snap.panes[0].pane_id;
 const foreign=cmd('pane','split','--pane',coordinator,'--direction','right','--ratio','.85','--cwd',dir,'--no-focus').pane.pane_id;
 const foreignRect=cmd('pane','layout','--pane',coordinator).layout.panes.find(p=>p.pane_id===foreign).rect;
 action('create',{driver:'herdr',context:{session},coordinator,concurrency:3,cwd:dir,run_id:'dynamic-herdr'});
 let pivot;
 for(const slot of [3,1,2])for(const role of ['master','fix','review']){const r=action('claim',{role,slot,target_id:'t'+slot,task_id:role+slot});if(!pivot){pivot=r.id;cmd('pane','focus','--pane',coordinator,'--direction','right');}assert.deepEqual(cmd('pane','layout','--pane',coordinator).layout.panes.find(p=>p.pane_id===foreign).rect,foreignRect);}
 const result=dir+'/result.json';fs.writeFileSync(result,JSON.stringify({status:'complete'}));
 for(const slot of [1,2,3])for(const role of ['review','fix','master'])action('release',{placement:role+':'+slot,task_id:role+slot,result_path:result,results_verified:true,worker_stopped:true,descendants_stopped:true});
 action('cleanup',{results_verified:true,descendants_stopped:true});console.log('PASS',dir);
 }finally{const stopped=run(['herdr','session','stop',session],{env:clientEnv,timeout:15});console.log('STOP_PRIVATE',stopped.status,stopped.stdout,stopped.stderr);pty.cleanup();}
