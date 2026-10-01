import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {buildApp}=await import(pathToFileURL(path.resolve('apps/api-ts/dist/app.js')).href);
let queries=0,pings=0;
const app=buildApp({pool:{query:async()=>{queries++;throw new Error('synthetic db unavailable');},end:async()=>{}},redis:{ping:async()=>{pings++;throw new Error('synthetic redis unavailable');},quit:async()=>{}},agentTrace:null,demoMode:false,evalMode:false});
try {
 const response=await app.inject({method:'GET',url:'/health/live'});
 assert.equal(response.statusCode,200);assert.deepEqual(response.json(),{status:'ok',service:'api'});assert.equal(queries,0);assert.equal(pings,0);
 const ready=await app.inject({method:'GET',url:'/health'});assert.equal(ready.statusCode,500);assert.ok(queries>0);
 if(process.argv.includes('--http')){await app.listen({port:0,host:'127.0.0.1'});const addr=app.server.address();const r=await fetch(`http://127.0.0.1:${addr.port}/health/live`);assert.equal(r.status,200);assert.deepEqual(await r.json(),{status:'ok',service:'api'});}
 console.log('Independent health acceptance passed'+(process.argv.includes('--http')?' including actual HTTP':''));
}finally{await app.close();}
