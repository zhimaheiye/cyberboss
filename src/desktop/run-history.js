const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { recordEvent } = require('./run-progress');

// Read-only recovery for runs created before detailed event recording existed.
// Do not import model reasoning, user prompts, token records or unrelated turns.
async function readRunHistory(store, run, refresh = false) {
  if (!run || (!refresh && run.toolDetails?.length)) return run;
  const threadId = run.threadId || store.data.threadId;
  if (!/^[a-f0-9-]{36}$/i.test(threadId || '')) return run;
  const started = Date.parse(run.createdAt);
  const nextRun = store.data.runs.find(r => Date.parse(r.createdAt) > started);
  const end = Math.min(Date.parse(run.finishedAt) || Infinity, Date.parse(nextRun?.createdAt) || Infinity);
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const files = [];
  // A resumed thread can retain its original day's filename. Search names,
  // never session contents, and stop after finding this exact thread ID.
  const visit = (dir, depth = 0) => {
    if (depth > 3 || !fs.existsSync(dir)) return;
    for (const item of fs.readdirSync(dir, { withFileTypes:true })) {
      if (item.isDirectory() && /^\d{2,4}$/.test(item.name)) visit(path.join(dir,item.name),depth+1);
      else if(item.isFile()&&item.name.endsWith(`-${threadId}.jsonl`)) files.push(path.join(dir,item.name));
    }
  };
  visit(root);
  const recovered = { ...run, steps:[], updates:[], detailSource:'codex-session' };
  const calls = new Map();
  for (const file of files) {
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try { for await (const line of lines) {
      let row;try{row=JSON.parse(line);}catch{continue;}
      const at=Date.parse(row.timestamp);if(!Number.isFinite(at)||at<started||at>end||row.type!=='response_item')continue;
      const p=row.payload;
      if(['function_call','custom_tool_call'].includes(p.type)) {
        const id=p.call_id||p.id; if(!id)continue;
        let args=p.arguments||p.input||'';try{args=JSON.parse(args);}catch{}
        const item={type:'dynamicToolCall',id,tool:p.name,arguments:args};calls.set(id,item);
        recordEvent(recovered,'item/started',{item},row.timestamp);
      } else if(['function_call_output','custom_tool_call_output'].includes(p.type)) {
        const item=calls.get(p.call_id);if(!item)continue;
        const content=Array.isArray(p.output)?p.output.map(c=>({type:'text',text:c.text||''})):[{type:'text',text:String(p.output||'')}];
        const yielded=content.some(c=>c.text?.includes('Script running with cell ID'));
        recordEvent(recovered,'item/completed',{item:{...item,status:yielded?'yielded':'completed',result:{content}}},row.timestamp);
      } else if(p.type==='message'&&p.role==='assistant'&&['commentary','final'].includes(p.channel)) {
        recordEvent(recovered,'item/completed',{item:{type:'agentMessage',id:p.id,text:(p.content||[]).filter(c=>c.type==='output_text').map(c=>c.text).join('\n'),phase:p.channel}},row.timestamp);
      }
    } } finally { lines.close(); stream.destroy(); }
  }
  if(!recovered.steps.length&&!recovered.updates.length)return { ...run, detailNote: '未找到本轮原始工具正文；以已保存记录为准。' };
  if(run.status!=='running')for(const step of recovered.steps)if(step.status==='running')step.status='unknown';
  if (run.updates?.length || run.steps?.length) return { ...run, toolDetails: recovered.steps, detailSource: 'codex-session' };
  return recovered;
}
module.exports={readRunHistory};
