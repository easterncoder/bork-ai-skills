'use strict';
const {assert, fs, P, temporary, run, background, sleep, json} = require('../../../../../tests/support.js');
/** Flatten the private tree's terminal leaves. */
function leaves(n) { return n.type === 'block' ? [n] : (n.children || []).flatMap(leaves); }
/** Exercise public CAS reflow against a private App/core/display. */
function main() {
 const root=P(temporary({prefix:'i16-app-dynamic-'}).name), session='i16-app-dynamic-'+process.pid;
 const env={...process.env, HERDR_APP_HOME:String(root.join('home')),XDG_STATE_HOME:String(root.join('state')),HC_SESSION:session,HERDR_APP_NO_SOUND:'1',WAYLAND_DISPLAY:''};delete env.HC_TERMINAL_ID;
 let x,app,core; const evidence=[];
 /** Run a bounded command only against private endpoints. */
 function command(argv,check=true){return run(argv,{env,check,timeout:15});}
 /** Read or mutate the private core using a JSON-RPC envelope. */
 function call(method,params={}) {const r=run(['hc','connect','--session',session],{env,input:json({jsonrpc:'2.0',id:1,method,params})+'\n',check:true,timeout:15});const v=JSON.parse(r.stdout);assert.ok(!v.error,r.stdout);return v.result;}
 /** Dispatch a documented public App control. */
 function control(name,args){return JSON.parse(command(['herdr-app','do',name,json(args)]).stdout);}
 /** Wait for a bounded private document change. */
 function wait(predicate){for(let i=0;i<100;i++){const d=call('doc.get',{name:'herdr-app'});if(d.value&&predicate(d.value))return d;sleep(.05);}throw Error('doc timeout');}
 /** Snapshot durable pane and process facts. */
 function snap(label){const d=call('doc.get',{name:'herdr-app'});const status=JSON.parse(command(['herdr-app','status']).stdout);const facts=leaves(d.value.spaces[0].tabs[0].root).map(n=>({pane:n.id,node:n,terminal:call('terminal.get',{terminal:n.content.terminal})}));evidence.push({label,doc:d,status,facts});fs.writeFileSync(String(root.join('evidence.json')),json(evidence,{indent:2}));console.log(label,json(facts.map(f=>({id:f.pane,t:f.terminal.address,pid:f.terminal.pid,cols:f.terminal.cols,rows:f.terminal.rows}))),status.focused_pane);return {d,status,facts};}
 /** Stop one owned process group. */
 function stop(p){if(p&&p.poll()===null){process.kill(-p.pid,'SIGTERM');try{p.wait({timeout:5});}catch{process.kill(-p.pid,'SIGKILL');p.wait({timeout:5});}}if(p)p.dispose();}
 try {
 x=background(['Xvfb','-displayfd','1','-screen','0','2000x2400x24','-nolisten','tcp']);for(let i=0;i<30&&!fs.statSync(x.stdoutPath).size;i++)sleep(.1);env.DISPLAY=':'+fs.readFileSync(x.stdoutPath,'utf8').trim();P(env.HERDR_APP_HOME).mkdir();root.join('home/window.json').writeText(json({state:'windowed',bounds:[0,0,1800,2200]}));root.join('home/shared.json').writeText(json({'frame.welcomed':'skipped'}));
 /** Launch the private App process. */
 function start(){app=background(['herdr-app'],{env});for(let i=0;i<100;i++){let s=command(['herdr-app','status'],false);if(s.status===0)return;sleep(.1);}throw Error('app timeout');}
 start();core=call('server.status');console.log('ROOT',String(root),'CORE',json(core));control('layout.switch',{name:'terminals'});control('layout.switch',{name:'main'});control('space.new',{name:'probe',folder:String(root),argv:['/bin/sh']});let d=wait(v=>v.spaces.length===1);const tab=d.value.spaces[0].tabs[0].id,coordinator=leaves(d.value.spaces[0].tabs[0].root)[0].id;
 control('pane.split',{pane:coordinator,direction:'down',argv:['/bin/sh']});d=wait(v=>leaves(v.spaces[0].tabs[0].root).length===2);const foreign=leaves(d.value.spaces[0].tabs[0].root).find(n=>n.id!==coordinator).id;control('pane.focus',{pane:foreign});
 control('tab.new',{name:'unrelated',argv:['/bin/sh']});wait(v=>v.spaces[0].tabs.length===2);control('pane.focus',{pane:foreign});
 control('layout.resize',{id:coordinator,weight:9});control('layout.resize',{id:foreign,weight:1});sleep(1);let base=snap('baseline');const unrelated=structuredClone(base.d.value.spaces[0].tabs[1]);
 const record=String(root.join('layout.json'));let sequence=0;
 /** Execute the production public demand lifecycle. */
 function action(name,input={}){const file=String(root.join('input-'+(++sequence)+'.json'));fs.writeFileSync(file,JSON.stringify({record,...input}));const r=run([process.execPath,require('node:path').resolve(__dirname, '../../layout.js'),name,file],{env,timeout:30});console.log('ACTION',name,r.stdout,r.stderr);const response=JSON.parse(r.stdout);if(!response.ok)console.log('FAILURE_STATUS',command(['herdr-app','status'],false).stdout);assert.equal(response.ok,true,response.error);return response.result;}
 action('create',{driver:'hc',visual_host:'herdr-app',context:{session,app_home:env.HERDR_APP_HOME},coordinator,concurrency:3,cwd:String(root),run_id:'dynamic-app'});
 for(const slot of (process.env.BORK_DEMAND_WORKER_ONLY==='1'?[]:[3,1,2]))for(const role of ['master','fix','review'])action('claim',{role,slot,target_id:'t'+slot,task_id:role+slot});
 const result=String(root.join('result.json'));fs.writeFileSync(result,JSON.stringify({status:'complete'}));
 for(const slot of (process.env.BORK_DEMAND_WORKER_ONLY==='1'?[]:[2,1,3]))for(const role of ['review','fix','master'])action('release',{placement:role+':'+slot,task_id:role+slot,result_path:result,results_verified:true,worker_stopped:true,descendants_stopped:true});
 /* Launch a harmless actual hc worker, restart its visual frontend and release it. */
 const job=String(root.join('worker-job.json'));fs.writeFileSync(job,json({argv:[process.execPath,'-e','console.log("demand worker");setTimeout(()=>{},30000)'],exit_record:String(root.join('worker-exit.json'))}));
 const launch={record:String(root.join('worker.json')),job,cwd:String(root),name:'demand-fixture',role:'master',slot:1,run_id:'dynamic-app',task_id:'master-live',target_id:'live',session,layout_record:record};
 /** Exercise actual worker/view binding against the production lifecycle. */
 function worker(name,input){const file=String(root.join('worker-input.json'));fs.writeFileSync(file,json(input));const r=run([process.execPath,require('node:path').resolve(__dirname,'../../hc.js'),name,file],{env,timeout:40});console.log('HC',name,r.stdout,r.stderr);const response=JSON.parse(r.stdout);if(!response.ok)console.log('FAILURE_STATUS',command(['herdr-app','status'],false).stdout);assert.equal(response.ok,true,response.error);return response.result;}
 const live=worker('launch',launch);sleep(.3);const geometry=call('terminal.get',{terminal:live.terminal_id});assert.ok(geometry.cols>=35&&geometry.rows>=6,json(geometry));
 stop(app);start();worker('reconcile',{record:launch.record});
 assert.equal(worker('cleanup',{record:launch.record,result_path:result,results_verified:true,descendants_stopped:true}).state,'removed');
 action('release',{placement:'master:1',task_id:'master-live',result_path:result,results_verified:true,worker_stopped:true,descendants_stopped:true});
 action('cleanup',{results_verified:true,descendants_stopped:true});
 assert.deepEqual(call('doc.get',{name:'herdr-app'}).value.spaces[0].tabs[1],unrelated);
 console.log('PASS production three-group reflow, stable identities, foreign geometry/focus, out-of-order turnover and actual hc binding/restart/cleanup');
 }finally{stop(app);if(core){console.log('STOP_CORE',json(call('server.stop')));}stop(x);console.log('CLEANED',String(root));}
}
main();
