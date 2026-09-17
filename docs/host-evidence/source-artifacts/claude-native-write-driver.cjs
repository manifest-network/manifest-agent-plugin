'use strict';
const fs=require('node:fs'), path=require('node:path'), http=require('node:http'), assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const toolOutput=body=>(body.messages||[]).flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(c=>c.type==='tool_result');
const content=JSON.stringify({skill:'review-fixture',intent:'Public harmless native Write acceptance',literal:'quote " and shell text $(touch should-not-execute) `literal`',outcome:'success'},null,2)+'\n';
function events(body,target){
 const done=toolOutput(body).length>0;
 const block=done?{type:'text',text:''}:{type:'tool_use',id:'write_fixture',name:'Write',input:{}};
 const delta=done?{type:'text_delta',text:'Write fixture complete.'}:{type:'input_json_delta',partial_json:JSON.stringify({file_path:target,content})};
 return [['message_start',{type:'message_start',message:{id:'msg_write',type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}}],['content_block_start',{type:'content_block_start',index:0,content_block:block}],['content_block_delta',{type:'content_block_delta',index:0,delta}],['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:done?'end_turn':'tool_use',stop_sequence:null},usage:{output_tokens:10}}],['message_stop',{type:'message_stop'}]].map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}
(async()=>{
 process.umask(0o022);
 const root=fs.mkdtempSync('/var/tmp/pr20-native-write-');fs.chmodSync(root,0o700);
 const report={schemaVersion:1,evidenceKind:'actual-claude-native-write-local-model',recordedAt:new Date().toISOString(),hostVersion:spawnSync('claude',['--version'],{encoding:'utf8',timeout:10000}).stdout.trim(),nodeVersion:process.version,operatorDriverSha256:createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),cases:[],limitations:['Actual Claude Write tool under a deterministic loopback model in print mode with Write preallowed; this tests file semantics, not terminal confirmation UI.','Harmless literal JSON only; no wallet, MCP mutation or real API credentials.'],cleanup:{verified:false}};
 let activeChild,activeApi;
 try{
  for(const existing of [true,false]){
   const work=path.join(root,existing?'existing':'private-parent');fs.mkdirSync(work,{mode:0o700});
   const config=path.join(work,'config');fs.mkdirSync(config,{mode:0o700});const home=path.join(work,'home');fs.mkdirSync(home,{mode:0o700});
   const target=path.join(work,'input.json');if(existing)fs.writeFileSync(target,'',{mode:0o600});
   const requests=[],errors=[];
   activeApi=http.createServer(async(req,res)=>{try{let raw='';for await(const b of req)raw+=b;const body=raw?JSON.parse(raw):{};if(req.url.includes('count_tokens')){res.end('{"input_tokens":100}');return;}if(req.method!=='POST'){res.end('{}');return;}requests.push(body);res.setHeader('content-type','text/event-stream');res.end(events(body,target));}catch(e){errors.push(e.message);res.statusCode=500;res.end('{}');}});
   await new Promise(r=>activeApi.listen(0,'127.0.0.1',r));
   const env={PATH:process.env.PATH,HOME:home,CLAUDE_CONFIG_DIR:config,ANTHROPIC_BASE_URL:`http://127.0.0.1:${activeApi.address().port}`,ANTHROPIC_API_KEY:'public-local-fixture-key',DISABLE_UPDATES:'1',DISABLE_INSTALLATION_CHECKS:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',LANG:'C.UTF-8'};
   fs.writeFileSync(path.join(config,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,theme:'dark',projects:{[work]:{hasTrustDialogAccepted:true}}}));
   const args=['-p','Run the harmless Write fixture once.','--output-format','stream-json','--verbose','--setting-sources','','--settings','{}','--permission-mode','manual','--allowedTools','Write','--tools','Write','--model','claude-sonnet-4-5-20250929'];
   activeChild=spawn('claude',args,{cwd:work,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';activeChild.stdout.on('data',b=>stdout+=b);activeChild.stderr.on('data',b=>stderr+=b);
   const code=await new Promise((resolve,reject)=>{const t=setTimeout(()=>{activeChild.kill('SIGTERM');reject(new Error('Native Write fixture timed out'));},60000);activeChild.on('error',reject);activeChild.on('exit',c=>{clearTimeout(t);resolve(c);});});activeChild=null;
   const results=requests.flatMap(toolOutput);const observed={name:existing?'precreated-file-without-read':'new-file-in-private-directory',exitCode:code,readToolAvailable:false,directoryMode:(fs.statSync(work).mode&0o777).toString(8),writeResults:results,stderr,toolUseCount:stdout.split('\n').filter(l=>l.includes('"name":"Write"')).length};
   assert.equal(code,0);assert.deepEqual(errors,[]);assert.ok(results.length);
   if(existing){assert.match(JSON.stringify(results),/not been read|read.*first/i);assert.equal(fs.readFileSync(target,'utf8'),'');observed.rejectedWithoutChangingFile=true;}
   else {assert.equal(fs.readFileSync(target,'utf8'),content);observed.fileMode=(fs.statSync(target).mode&0o777).toString(8);assert.equal(observed.directoryMode,'700');observed.literalJsonBytesPreserved=true;assert.ok(!fs.existsSync(path.join(work,'should-not-execute')));}
   report.cases.push(observed);await new Promise(r=>activeApi.close(r));activeApi=null;
  }
 }finally{
  if(activeChild)activeChild.kill('SIGTERM');if(activeApi){activeApi.closeAllConnections();activeApi.close();}
  await pause(300);fs.rmSync(root,{recursive:true,force:true});assert.ok(!fs.existsSync(root));report.cleanup={verified:true,temporaryRootRemoved:true};
 }
 fs.writeFileSync(path.resolve(process.argv[2]||'dist/pr20-native-write.json'),JSON.stringify(report,null,2).replaceAll(root,'<fixture>')+'\n');console.log(JSON.stringify({hostVersion:report.hostVersion,cases:report.cases.map(c=>({name:c.name,rejected:c.rejectedWithoutChangingFile,passed:c.literalJsonBytesPreserved,fileMode:c.fileMode,parentMode:c.directoryMode})),cleanup:report.cleanup}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
