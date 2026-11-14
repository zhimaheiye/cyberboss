import React, { useEffect, useRef, useState } from 'react';
import { Maximize, Minimize, X } from 'lucide-react';
import { api, Button, fmt, useWorkbench } from './shared';

const PREFERENCES = 'cyberboss-breathing-settings';
const PREPARE_MS = 3000;
const FEEDBACK = { better: '好一点', same: '差不多', worse: '更不舒服' };

export function breathingPreferences() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(PREFERENCES)); } catch {}
  return {
    minutes: [1, 2, 5, null].includes(saved?.minutes) ? saved.minutes : 2,
    pace: [3, 4, 5].includes(saved?.pace) ? saved.pace : 4,
    reducedMotion: saved?.reducedMotion === true,
  };
}

function elapsedLabel(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export default function Breathing({ session, onClose, onShowReminders }) {
  const { state, refresh, toast } = useWorkbench();
  const dialog = useRef(null), layout = useRef(null), circle = useRef(null);
  const options = useRef(session.options);
  const clock = useRef({ activeMs: 0, cycleMs: 0, prepareMs: PREPARE_MS, lastFrame: null, manualPause: false });
  const ending = useRef(null);
  const alive = useRef(true);
  const [selected, setSelected] = useState(session.options);
  const [display, setDisplay] = useState({ phase: '准备', seconds: 3, activeSeconds: 0 });
  const [record, setRecord] = useState(null);
  const [finishing, setFinishing] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [fullscreen, setFullscreen] = useState(false);

  function request(action, extra = {}, keepalive = false) {
    const { minutes, pace } = options.current;
    return api('breathing', { action, id: session.id, minutes, pace, activeMs: clock.current.activeMs, ...extra },
      { keepalive, signal: AbortSignal.timeout(6000) });
  }

  function finish(outcome, close = false) {
    if (ending.current) return ending.current;
    setFinishing(true);
    setConnectionError('');
    const pending = request('finish', { outcome }, true).then(saved => {
      void refresh();
      if (!alive.current) return;
      setRecord(saved?.id ? saved : { outcome, activeMs: clock.current.activeMs });
      if (close) onClose();
    }).catch(error => {
      if (close) toast('退出请求未确认，服务端会在练习状态过期后恢复提醒。', true);
      else if (alive.current) setConnectionError(`暂时无法保存练习。${error.message}`);
      ending.current = null;
      clock.current.manualPause = true;
    }).finally(() => {
      if (alive.current) setFinishing(false);
    });
    ending.current = pending;
    return pending;
  }

  useEffect(() => {
    const element = dialog.current;
    const fullscreenTarget = layout.current;
    alive.current = true;
    element.showModal();
    const handleFullscreen = () => setFullscreen(document.fullscreenElement === fullscreenTarget);
    const leave = () => {
      if (!ending.current) void request('finish', { outcome: 'stopped' }, true).catch(() => {});
      onClose();
    };
    document.addEventListener('fullscreenchange', handleFullscreen);
    window.addEventListener('pagehide', leave);
    const restore = event => { if (event.persisted) onClose(); };
    window.addEventListener('pageshow', restore);
    return () => {
      alive.current = false;
      document.removeEventListener('fullscreenchange', handleFullscreen);
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', restore);
      if (document.fullscreenElement === fullscreenTarget) void document.exitFullscreen().catch(() => {});
      element.close();
      session.returnFocus?.focus();
    };
  }, []);

  useEffect(() => {
    if (record) return;
    let frame, heartbeatInFlight = false;
    const timer = clock.current;
    let lastDisplay;
    function prepare() {
      timer.lastFrame = null;
      timer.cycleMs = 0;
      timer.prepareMs = PREPARE_MS;
    }
    function pauseForFocus() {
      prepare();
      lastDisplay = undefined;
      if (!ending.current) setDisplay({ phase: '已暂停', seconds: 0, activeSeconds: Math.floor(timer.activeMs / 1000) });
    }
    async function checkpoint() {
      if (ending.current || heartbeatInFlight) return;
      heartbeatInFlight = true;
      try {
        await request('progress');
        if (alive.current && !ending.current) setConnectionError('');
      } catch (error) {
        if (!alive.current || ending.current) return;
        if (error.status === 400) {
          await finish('stopped');
        } else {
          timer.manualPause = true;
          pauseForFocus();
          setConnectionError('工作台连接暂时中断，已暂停。');
        }
      } finally { heartbeatInFlight = false; }
    }
    function onVisibility() {
      pauseForFocus();
      void checkpoint();
    }
    function tick(now) {
      if (!ending.current) {
        const delta = timer.lastFrame === null ? 0 : now - timer.lastFrame;
        timer.lastFrame = now;
        const { minutes, pace } = options.current;
        const phaseMs = pace * 1000;
        let phase = '准备', seconds = 0, scale = 0.76;
        if (document.hidden || !document.hasFocus() || timer.manualPause) {
          prepare();
          phase = '已暂停';
        } else if (delta > 1000) {
          prepare();
          seconds = 3;
        } else if (timer.prepareMs > 0) {
          timer.prepareMs = Math.max(0, timer.prepareMs - delta);
          seconds = Math.ceil(timer.prepareMs / 1000);
        } else {
          const untilEnd = phaseMs * 2 - timer.cycleMs;
          if (delta >= untilEnd && minutes !== null && timer.activeMs + untilEnd >= minutes * 60000) {
            timer.activeMs += untilEnd;
            void finish('completed');
            frame = requestAnimationFrame(tick);
            return;
          }
          timer.activeMs += delta;
          timer.cycleMs = (timer.cycleMs + delta) % (phaseMs * 2);
          const inhale = timer.cycleMs < phaseMs;
          const progress = (timer.cycleMs % phaseMs) / phaseMs;
          phase = inhale ? '吸气' : '呼气';
          seconds = Math.ceil((1 - progress) * pace);
          scale += 0.24 * (1 - Math.cos(Math.PI * (inhale ? progress : 1 - progress))) / 2;
        }
        if (circle.current) circle.current.style.setProperty('--breathing-scale', scale);
        const activeSeconds = Math.floor(timer.activeMs / 1000);
        if (lastDisplay?.phase !== phase || lastDisplay.seconds !== seconds || lastDisplay.activeSeconds !== activeSeconds) {
          lastDisplay = { phase, seconds, activeSeconds };
          setDisplay(lastDisplay);
        }
      }
      frame = requestAnimationFrame(tick);
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onVisibility);
    window.addEventListener('focus', onVisibility);
    const heartbeat = setInterval(checkpoint, 15_000);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onVisibility);
      window.removeEventListener('focus', onVisibility);
    };
  }, [record]);

  function changeOptions(change) {
    const next = { ...options.current, ...change };
    options.current = next;
    setSelected(next);
    try { localStorage.setItem(PREFERENCES, JSON.stringify(next)); } catch {}
    if (change.pace !== undefined) {
      Object.assign(clock.current, { cycleMs: 0, prepareMs: PREPARE_MS, lastFrame: null });
    }
  }

  async function toggleFullscreen() {
    try {
      if (fullscreen) await document.exitFullscreen();
      else await layout.current.requestFullscreen();
    } catch {
      setConnectionError('浏览器暂时无法切换全屏。');
    }
  }

  async function saveFeedback(value) {
    try {
      setRecord(await request('feedback', { feedback: value }));
      setConnectionError('');
    } catch (error) {
      setConnectionError(error.message);
    }
  }

  function close() {
    if (!record) void finish('stopped', true);
    onClose();
  }

  function togglePause() {
    const timer = clock.current;
    const manualPause = !timer.manualPause;
    Object.assign(timer, { manualPause, cycleMs: 0, prepareMs: PREPARE_MS, lastFrame: null });
  }

  const remaining = selected.minutes === null ? null : Math.max(0, selected.minutes * 60 - display.activeSeconds);
  const phaseLabel = { '准备': '先自然呼吸', '吸气': '轻轻吸气', '呼气': '慢慢呼气', '已暂停': '已暂停' };
  return <dialog ref={dialog} className="breathing-dialog" aria-labelledby="breathing-title"
    onCancel={event => { event.preventDefault(); if (!document.fullscreenElement) close(); }}>
    <div className="breathing-layout" ref={layout}>
      <header className="breathing-header">
        <h2 id="breathing-title">呼吸练习</h2>
        <div className="breathing-actions">
          {document.fullscreenEnabled && <Button className="breathing-icon" onClick={toggleFullscreen}
            aria-label={fullscreen ? '退出全屏' : '全屏'} title={fullscreen ? '退出全屏' : '全屏'}>
            {fullscreen ? <Minimize size={19}/> : <Maximize size={19}/>}
          </Button>}
          <Button className="breathing-icon" onClick={close} aria-label="退出练习" title="退出练习"><X size={22}/></Button>
        </div>
      </header>
      {record ? <div className="breathing-completion">
        <h3>{record.outcome === 'completed' ? '练习完成' : '练习已结束'}</h3>
        <p>练习时长 {elapsedLabel(record.activeMs)}</p>
        {record.id && <p>现在感觉怎么样？</p>}
        {record.id && <div className="breathing-actions">
          {Object.entries(FEEDBACK).map(([value, label]) => <Button className="breathing-button" key={value}
            aria-pressed={record.feedback === value} onClick={() => saveFeedback(value)}>{label}</Button>)}
        </div>}
        {state.breathing?.reminderCount > 0 && <Button className="breathing-button" onClick={onShowReminders}>
          练习期间有 {state.breathing.reminderCount} 条提醒
        </Button>}
        {connectionError && <p role="alert" className="breathing-error">{connectionError}</p>}
        <Button className="breathing-button breathing-primary" onClick={onClose}>返回工作台</Button>
      </div> : <>
        <div className={'breathing-stage' + (selected.reducedMotion ? ' breathing-reduced' : '')}>
          <div className="breathing-orbit" aria-hidden="true"><div className="breathing-circle" ref={circle}/></div>
          <div className="breathing-phase" role="status">{finishing ? '正在保存练习' : phaseLabel[display.phase]}</div>
          <div className="breathing-hint">{display.phase === '已暂停' ? '恢复自然呼吸' :
            display.seconds > 0 && <span aria-hidden="true">{display.seconds}</span>}</div>
          {remaining !== null && <div className="breathing-time">{remaining ? `剩余 ${elapsedLabel(remaining * 1000)}` : '这一轮结束后收尾'}</div>}
        </div>
        <footer className="breathing-footer">
          {connectionError && <p role="alert" className="breathing-error">{connectionError}</p>}
          <div className="breathing-actions">
            <Button className="breathing-button" disabled={finishing || (display.phase === '已暂停' && !clock.current.manualPause)}
              onClick={togglePause}>{clock.current.manualPause ? '继续' : '暂停'}</Button>
            <Button className="breathing-button" disabled={finishing} onClick={() => finish('stopped')}>结束练习</Button>
          </div>
          <details className="breathing-options">
            <summary>练习设置</summary>
            <div className="breathing-controls">
              <label>时长<select value={selected.minutes ?? 'open'} onChange={event => changeOptions({
                minutes: event.target.value === 'open' ? null : Number(event.target.value),
              })}><option value={1}>1 分钟</option><option value={2}>2 分钟</option><option value={5}>5 分钟</option><option value="open">不限时</option></select></label>
              <label>节奏<select value={selected.pace} onChange={event => changeOptions({ pace: Number(event.target.value) })}>
                <option value={3}>稍快 · 3 秒</option><option value={4}>舒缓 · 4 秒</option><option value={5}>稍慢 · 5 秒</option></select></label>
              <label className="breathing-motion"><input type="checkbox" checked={selected.reducedMotion}
                onChange={event => changeOptions({ reducedMotion: event.target.checked })}/>减弱动效</label>
            </div>
            {state.breathing?.recent.length > 0 && <details><summary>最近练习</summary>
              <ul>{state.breathing.recent.map(item => <li key={item.id}>{fmt(new Date(item.startedAt).toISOString())} · {elapsedLabel(item.activeMs)}
                {item.feedback ? ` · ${FEEDBACK[item.feedback]}` : ''}</li>)}</ul></details>}
          </details>
        </footer>
      </>}
    </div>
  </dialog>;
}
