import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LayoutDashboard, CheckSquare, Workflow, MessagesSquare, BookOpen, History, Settings2, Bell, ArrowUpRight, Menu, X, Sparkles, CircleAlert } from 'lucide-react';
import Chat from './Chat';
import Tasks from './Tasks';
import Jobs from './Jobs';
import { Memory, Timeline } from './Records';
import Settings from './Settings';
import { Workbench, useWorkbench, api, tool, Button, Badge, Dialog, Empty, fmt, titleOf } from './shared';
import { setupNotifications, notificationLabel, enableNotifications, deliverNotifications } from './notifications';

const navigation=[['overview','今天',LayoutDashboard],['chat','对话与提醒',MessagesSquare],['tasks','待办事项',CheckSquare],['jobs','交给 Agent',Workflow],['memory','记忆',BookOpen],['timeline','生活时间线',History],['settings','设置',Settings2]];
function Overview() {
  const {state,tasks,taskLoading,taskError,go,ask,openMessage}=useWorkbench();const active=state.jobs.filter(j=>j.status==='active'), notices=state.messages.filter(m=>m.unread).slice(-3).reverse();
  return <><section className="welcome"><div><span className="eyebrow">你的生活工作台</span><h2>把心思留给眼前，<br/>其余的，一起记着。</h2><p>待办、提醒与记忆都在这里。你可以亲手安排，也可以交给 Agent。</p><Button className="primary" onClick={()=>ask('看看最近还有什么没做的事情，结合我的待办和托管事项。')}>聊聊今天的安排<ArrowUpRight size={17}/></Button></div><div className="welcome-orbit" aria-hidden="true"><span/><Sparkles size={45}/><span/></div></section>
    <div className="stats">{[['未完成待办',taskError?'—':taskLoading?'…':tasks.filter(t=>!t.completed).length,'tasks'],['正在跟进',active.length,'jobs'],['待接管 / 需处理',state.jobs.filter(j=>['draft','blocked'].includes(j.status)).length,'jobs'],['未读提醒',state.messages.filter(m=>m.unread).length,'chat']].map(([label,value,page])=><button key={label} className="stat" onClick={()=>go(page)}><span>{label}</span><strong>{value}</strong><ArrowUpRight size={17}/></button>)}</div>
    {notices.length>0&&<section className="panel"><div className="section-heading"><h2>有几件事想告诉你</h2><Badge>{notices.length} 条待看</Badge></div>{notices.map(m=><Button className="overview-notice" key={m.id} onClick={()=>openMessage(m.id)}><Bell size={17}/><span>{m.text.slice(0,180)}</span><small>{fmt(m.createdAt)}</small><ArrowUpRight size={16}/></Button>)}</section>}
    <div className="two-cols"><section className="panel"><div className="section-heading"><h2>近期事项</h2><Button className="text-button" onClick={()=>go('tasks')}>全部待办 <ArrowUpRight size={15}/></Button></div>{taskError?<div className="alert error">{taskError}</div>:tasks.filter(t=>!t.completed).length?tasks.filter(t=>!t.completed).slice(0,6).map(t=><Button className="overview-row" key={t.id} onClick={()=>go('tasks')}><CheckSquare size={17}/><span>{titleOf(t)}<small>{t.due?.date||'未安排日期'}</small></span></Button>):<Empty title={taskLoading?'正在读取…':'暂时没有待办'}>从一件小事开始就好。</Empty>}</section><section className="panel"><div className="section-heading"><h2>Agent 正在跟进</h2><Button className="text-button" onClick={()=>go('jobs')}>管理 <ArrowUpRight size={15}/></Button></div>{active.length?active.slice(0,6).map(j=><Button className="overview-row" key={j.id} onClick={()=>go('jobs')}><Workflow size={17}/><span>{j.title}<small>{j.nextRunAt?`下次 ${fmt(j.nextRunAt)}`:'等待合适时机'}</small></span><Badge value={j.kind}/></Button>):<Empty title="这里会持续跟进你的安排">周期提醒与信息监控，都可以交给 Agent。</Empty>}</section></div>
  </>;
}
class ErrorBoundary extends React.Component {
  state={error:null};
  static getDerivedStateFromError(error){return {error};}
  render(){return this.state.error?<div className="startup"><h1>工作台遇到一个界面错误</h1><p>本机数据仍由后台保存。</p><pre>{this.state.error.message}</pre><button onClick={()=>location.reload()}>重新打开</button></div>:this.props.children;}
}
function App() {
  const [state,setState]=useState(null),[connected,setConnected]=useState(false),[connectionError,setConnectionError]=useState(''),[page,setPage]=useState('overview'),[mobile,setMobile]=useState(false);
  const [tasks,setTasks]=useState([]),[taskLoading,setTaskLoading]=useState(false),[taskError,setTaskError]=useState(''),[includeCompleted,setIncludeCompleted]=useState(false);
  const [draft,setDraft]=useState(''),[notice,setNotice]=useState(null),[historyMessage,setHistoryMessage]=useState(null),[notificationStatus,setNotificationStatus]=useState(notificationLabel());
  const snapshot=useRef(null), timer=useRef(), refreshFlight=useRef(null), taskSequence=useRef(0), refreshVersion=useRef(0);
  const toast=useCallback((text,error=false)=>{setNotice({text,error});clearTimeout(timer.current);timer.current=setTimeout(()=>setNotice(null),8000);},[]);
  const refresh=useCallback(async()=>{
    // Coalesce streaming events, but request one fresh snapshot after any event
    // that arrived while a read was in flight.
    refreshVersion.current++;
    if(refreshFlight.current)return refreshFlight.current;
    refreshFlight.current=(async()=>{let version;do{version=refreshVersion.current;try{const next=await api('state');snapshot.current=next;setState(next);setConnected(true);setConnectionError('');deliverNotifications(next);}catch(error){setConnected(false);setConnectionError(error.message);break;}}while(version!==refreshVersion.current);})();
    try{await refreshFlight.current;}finally{refreshFlight.current=null;}
  },[]);
  const refreshTasks=useCallback(async()=>{
    const sequence=++taskSequence.current;setTaskLoading(true);
    try{let cursor,all=[];do{const result=await tool('opentodo_list_tasks',{view:'all',include_completed:includeCompleted,timezone:'Asia/Shanghai',limit:200,...(cursor?{cursor}:{})});all.push(...(result.tasks||[]));cursor=result.next_cursor;}while(cursor&&all.length<2000);
      if(sequence===taskSequence.current){setTasks(all);setTaskError(cursor?'当前显示前 2000 条，更多事项请到完整看板查看。':'');}
    }catch(error){if(sequence===taskSequence.current)setTaskError(error.message);}finally{if(sequence===taskSequence.current)setTaskLoading(false);}
  },[includeCompleted]);
  const go=useCallback(name=>{if(navigation.some(n=>n[0]===name)){setPage(name);setMobile(false);history.replaceState(null,'',`/#${name}`);}},[]);
  const ask=useCallback(text=>{setDraft(text);go('chat');},[go]);
  const clearDraft=useCallback(()=>setDraft(''),[]);
  const openMessage=useCallback(async id=>{
    go('chat');const message=snapshot.current?.messages.find(m=>m.id===id)||await api(`message?id=${encodeURIComponent(id)}`);
    if(!message){toast('未找到这条消息',true);return;}await api('read',{id});await refresh();
    if(snapshot.current?.messages.some(m=>m.id===id)){requestAnimationFrame(()=>requestAnimationFrame(()=>document.getElementById(`message-${id}`)?.scrollIntoView({block:'center',behavior:'smooth'})));}
    else setHistoryMessage(message);
  },[go,refresh,toast]);
  const enablePush=useCallback(async(ask=false)=>{const label=await enableNotifications(snapshot.current?.pushPublicKey,ask);setNotificationStatus(label);if(snapshot.current)deliverNotifications(snapshot.current);},[]);
  useEffect(()=>{
    void refresh();const events=new EventSource('/api/events');events.onmessage=()=>void refresh();events.onerror=()=>setConnected(false);
    const onVisible=()=>{if(!document.hidden)void refresh();};document.addEventListener('visibilitychange',onVisible);
    void setupNotifications().then(()=>enablePush()).catch(error=>setNotificationStatus(`提醒未就绪：${error.message}`));
    const gesture=e=>{if(!e.isTrusted||(e.type==='keydown'&&e.key!=='Enter'))return;if(window.Notification?.permission==='default')void enablePush(true).catch(error=>toast(error.message,true));document.removeEventListener('click',gesture);document.removeEventListener('keydown',gesture);};
    document.addEventListener('click',gesture);document.addEventListener('keydown',gesture);
    return()=>{events.close();document.removeEventListener('visibilitychange',onVisible);document.removeEventListener('click',gesture);document.removeEventListener('keydown',gesture);clearTimeout(timer.current);};
  },[refresh,enablePush,toast]);
  useEffect(()=>{if(state)void refreshTasks();},[state?.taskRevision,refreshTasks]);
  useEffect(()=>{if(state?.pushPublicKey)void enablePush().catch(error=>toast(error.message,true));},[state?.pushPublicKey,enablePush,toast]);
  const hasState=!!state;
  useEffect(()=>{
    if(!hasState)return;
    const hash=()=>{const id=new URLSearchParams(location.hash.slice(1)).get('message');if(id)void openMessage(id).catch(e=>toast(e.message,true));else{const name=location.hash.slice(1);if(navigation.some(n=>n[0]===name))setPage(name);}};
    hash();window.addEventListener('hashchange',hash);return()=>window.removeEventListener('hashchange',hash);
  },[hasState,openMessage,toast]);
  if(!state)return <div className="startup"><img src="/icon.svg" alt=""/><h1>CyberBoss</h1><p>{connectionError||'正在连接你的本地工作台…'}</p>{connectionError&&<button onClick={()=>void refresh()}>重新连接</button>}</div>;
  const value={state,connected,refresh,tasks,taskLoading,taskError,includeCompleted,setIncludeCompleted,refreshTasks,go,ask,draft,clearDraft,toast,openMessage,enablePush,notificationStatus};
  const unread=state.messages.filter(m=>m.unread).length;
  return <Workbench.Provider value={value}><div className="app-shell"><aside className={`sidebar ${mobile?'mobile-open':''}`}><a className="brand" href="#overview"><img src="/icon.svg" alt=""/><span>CyberBoss<small>生活工作台</small></span></a><div className="nav-caption">工作空间</div><nav aria-label="工作台导航">{navigation.map(([id,label,Icon])=><button key={id} className={page===id?'active':''} aria-current={page===id?'page':undefined} onClick={()=>go(id)}><Icon size={19}/><span>{label}</span>{id==='chat'&&unread>0&&<b>{unread}</b>}</button>)}</nav><div className="sidebar-foot"><span><i className={`status-dot ${connected?'':'offline'}`}/>{connected?'已连接这台电脑':'连接中断，正在重连'}</span><small>本地保存 · 由你掌控</small></div></aside>
    {mobile&&<button className="sidebar-backdrop" onClick={()=>setMobile(false)} aria-label="收起导航"/>}<main className={page==='chat'?'main chat-main':'main'}><header className="page-header"><div className="header-heading"><button className="icon-button mobile-menu" onClick={()=>setMobile(!mobile)} aria-label="打开导航"><Menu size={21}/></button><div><div className="eyebrow">{new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'long',timeZone:'Asia/Shanghai'}).format(new Date())}</div><h1>{navigation.find(n=>n[0]===page)?.[1]}</h1></div></div><div className="header-actions"><span className="agent-status"><i className={`status-dot ${state.agent.busy?'working':''}`}/>{state.agent.approvals.length?'等待处理':state.agent.busy?state.agent.background?'后台检查中':'正在回复':'Agent 待命'}</span><Button className="notification-button secondary" onClick={()=>enablePush(true)} title={notificationStatus}><Bell size={16}/><span>{notificationStatus}</span></Button></div></header>
      {(!connected||state.error||state.taskService.error)&&<div className="global-alert" role="status"><CircleAlert size={18}/><span>{[!connected&&(connectionError||'连接中断，正在尝试重连。当前草稿不会清空。'),state.error,state.taskService.error].filter(Boolean).join(' · ')}</span></div>}
      <Chat active={page==='chat'}/><div className="page-content" hidden={page==='chat'}>{page==='overview'&&<Overview/>}{page==='tasks'&&<Tasks/>}{page==='jobs'&&<Jobs/>}{page==='memory'&&<Memory/>}{page==='timeline'&&<Timeline/>}{page==='settings'&&<Settings/>}</div>
    </main></div>{notice&&<div className={`toast ${notice.error?'error':''}`} role="status"><span>{notice.text}</span><button className="icon-button" aria-label="关闭提示" onClick={()=>setNotice(null)}><X size={16}/></button></div>}
    {historyMessage&&<Dialog title="历史消息" onClose={()=>setHistoryMessage(null)} wide><small>{fmt(historyMessage.createdAt)}</small><p className="preserve-lines">{historyMessage.text}</p><div className="attachments">{(historyMessage.images||[]).map(image=><a key={image.id} href={`/api/chat-image?id=${encodeURIComponent(image.id)}`} target="_blank" rel="noreferrer"><img src={`/api/chat-image?id=${encodeURIComponent(image.id)}`} alt={image.name}/></a>)}</div></Dialog>}
  </Workbench.Provider>;
}
createRoot(document.getElementById('root')).render(<ErrorBoundary><App/></ErrorBoundary>);
