'use strict';
const root=require('node:path').resolve(__dirname, '../../../../..');
const c=require(root+'/skills/bork-review/scripts/support.js');
const {fs,P,temporary,run,sleep,assert}=require(root+'/tests/support.js');const {privatePty}=require(root+'/tests/fixtures/pty.js');const a=require(root+'/skills/bork-doitall/scripts/layout-adapters/screen.js');
const temp=temporary({prefix:'i16-screen-proof-'}),dir=P(temp.name);dir.chmod(0o700);const env={...process.env,SCREENDIR:String(dir),TERM:'xterm-256color'};delete env.STY;
const rc=dir.join('rc');rc.writeText('startup_message off\nmsgwait 0\ncaption always "%n %t"\n');const pty=privatePty(['screen','-m','-S','proof','-c',String(rc),'-t','coordinator','bash','--norc'],{env,columns:180,rows:60});let fd;
/** Control only the attached private fixture. */
function raw(...args){return run(['screen','-S','proof',...args],{env,stdin:{fd},check:true}).stdout;}
try{fd=fs.openSync(pty.tty(),'r');sleep(.2);const session=fs.readdirSync(String(dir)).find(x=>x.endsWith('.proof'));let ctx={session,socket_dir:String(dir),display_tty:pty.tty()};
/** Execute confirmed public control. */
function x(...args){return a.borkLayoutScreen(ctx,['-X',...args]);}
/** Read concrete screen window/process identities. */
function processes(){const pid=+session.split('.')[0];return fs.readFileSync(`/proc/${pid}/task/${pid}/children`,'utf8').trim().split(/\s+/).map(Number);}
/** Snapshot public measured geometry. */
function snap(){return a.borkLayoutScreenSnapshot(ctx,'0');}
/** Focus a uniquely displayed private window. */
function focus(id){a.borkLayoutScreenFocus(ctx,id);}
x('split');x('focus','down');x('screen','-t','unrelated','bash','--norc');x('resize','-v','10');focus('0');const initial=snap();const foreign=initial.panes['1'];
const record=String(dir.join('layout.json'));let n=0;
/** Execute the actual serialized production lifecycle. */
function act(action,input={}) {const file=String(dir.join('input-'+(++n)+'.json'));fs.writeFileSync(file,JSON.stringify({record,...input}));const r=run([process.execPath,root+'/skills/bork-doitall/scripts/layout.js',action,file],{env,stdin:{fd},timeout:180});console.log(action,r.stdout,r.stderr);const response=JSON.parse(r.stdout);assert.equal(response.ok,true,response.error);return response.result;}
act('create',{driver:'screen',context:ctx,coordinator:'0',concurrency:3,cwd:String(dir),run_id:'dynamic-screen'});
for(const slot of (process.env.BORK_DEMAND_RECOVERY_ONLY==='1'?[1]:[2,1,3]))for(const role of (process.env.BORK_DEMAND_RECOVERY_ONLY==='1'?['master']:['master','fix','review']))act('claim',{role,slot,target_id:'t'+slot,task_id:role+slot});
const result=String(dir.join('result.json'));fs.writeFileSync(result,JSON.stringify({status:'complete'}));
if(process.env.BORK_DEMAND_RECOVERY_ONLY==='1'){
 const host=require(root+'/skills/bork-doitall/scripts/layout-demand-host.js'),demand=require(root+'/skills/bork-doitall/scripts/layout-demand.js'),original=host.close;
 /** Simulate helper loss after removing the region but before killing its retained window. */
 host.close=(journal,id)=>{a.borkLayoutScreenFocus(ctx,id);a.borkLayoutScreen(ctx,['-X','remove']);throw Error('injected after region removal');};
 try{assert.throws(()=>demand.release({placement:'master:1',task_id:'master1',result_path:result,results_verified:true,worker_stopped:true,descendants_stopped:true},JSON.parse(fs.readFileSync(record))),/injected/);}finally{host.close=original;}
 act('reconcile');
 assert.ok(!a.borkLayoutScreen(ctx,['-Q','windows','%n|%f;']).split(';').some(entry=>entry.trim().startsWith('2|')));
 console.log('PASS hidden-window close recovery');
}else for(const slot of [1,3,2])for(const role of ['review','fix','master'])act('release',{placement:role+':'+slot,task_id:role+slot,result_path:result,results_verified:true,worker_stopped:true,descendants_stopped:true});
act('cleanup',{results_verified:true,descendants_stopped:true});

}finally{try{raw('-X','quit');console.log('PRIVATE_SCREEN_STOPPED');}finally{if(fd)fs.closeSync(fd);pty.cleanup();}}
