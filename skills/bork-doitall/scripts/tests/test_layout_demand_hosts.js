'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
/** Exercise production demand adapters only on explicitly opted-in private hosts. */
for(const [host,tools] of Object.entries({app:['hc','herdr-app','Xvfb'],herdr:['herdr','cc'],screen:['screen','cc']})) {
 const skip=process.env.BORK_TEST_LIVE_HOSTS!=='1'?'set BORK_TEST_LIVE_HOSTS=1 for private host fixtures':tools.some(tool=>spawnSync('which',[tool]).status!==0)?'optional host prerequisites missing':false;
 test(`private ${host} demand lifecycle`,{skip,timeout:1200000},()=>{
  const result=spawnSync(process.execPath,[path.join(__dirname,'fixtures',`live_demand_${host}.js`)],{encoding:'utf8',timeout:1190000,maxBuffer:16*1024*1024});
  console.log(result.stdout);assert.equal(result.status,0,result.stdout+result.stderr);
 });
}
