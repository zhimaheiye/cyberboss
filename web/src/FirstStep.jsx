import React, { useEffect, useState } from 'react';
import { api, Button, localDate, useWorkbench } from './shared';

export default function FirstStep({ children }) {
  const { state, refresh } = useWorkbench();
  const card = state.firstStep;
  const [today, setToday] = useState(localDate);
  const [showOverview, setShowOverview] = useState(false);
  useEffect(() => {
    if (!card) return;
    const update = () => setToday(localDate());
    const midnight = Date.parse(today + 'T00:00:00+08:00') + 86400000;
    const timer = setTimeout(update, Math.max(0, midnight - Date.now()) + 50);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [today, card?.id]);

  if (!card || card.date > today || (card.finishedAt && localDate(card.finishedAt) !== today)) return children;
  if (showOverview) return <><Button onClick={() => setShowOverview(false)}>回到今天的第一步</Button>{children}</>;

  async function finish() {
    await api('procrastination', { action:'finishFirstStep', expectedId:card.id });
    await refresh();
  }
  return <section className="panel start-step first-step" aria-label="今天的第一步">
    <small>{card.subject || '今天的第一步'}</small>
    {card.finishedAt ? <>
      <h2>这一步做过了</h2>
      <p className="preserve-lines">{card.step}</p>
      {card.after && <details><summary>还想继续一点</summary><p className="preserve-lines">{card.after}</p></details>}
    </> : <>
      <h2>先做这一小步</h2>
      <p className="start-instruction preserve-lines">{card.step}</p>
      {card.hint && <details><summary>给我一点提示</summary><p className="preserve-lines">{card.hint}</p></details>}
      <div className="actions"><Button className="primary" onClick={finish}>这一步做了</Button></div>
    </>}
    <Button className="text-button" onClick={() => setShowOverview(true)}>查看完整首页</Button>
  </section>;
}
