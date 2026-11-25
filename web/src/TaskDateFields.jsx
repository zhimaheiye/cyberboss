import React, { useState } from 'react';
import { Button, Field, localDate } from './shared';

export default function TaskDateFields({ initialDate = '', initialTime = '' }) {
  const [date, setDate] = useState(initialDate), [time, setTime] = useState(initialTime);
  return <div className="task-date-fields">
    <div className="actions">
      <Button onClick={() => setDate(localDate())}>今天</Button>
      <Button onClick={() => setDate(localDate(Date.now() + 86400000))}>明天</Button>
      <Button onClick={() => { setDate(''); setTime(''); }}>清除日期</Button>
      {time && <Button onClick={() => setTime('')}>只保留日期</Button>}
    </div>
    <div className="field-pair">
      <Field label="日期"><input name="date" type="date" value={date} onChange={e => { setDate(e.target.value); if (!e.target.value) setTime(''); }}/></Field>
      <Field label="时间（北京时间，可留空）"><input name="time" type="time" value={time} disabled={!date} onChange={e => setTime(e.target.value)}/></Field>
    </div>
  </div>;
}
