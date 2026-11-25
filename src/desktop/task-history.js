// Local provenance supplements OpenTodo's task/occurrence state. Never infer an
// author for changes made through another client or before this ledger existed.
const MUTATIONS = new Set(['complete_tasks', 'reopen_tasks', 'create_tasks']);
const snapshot = task => ({ title: task.untrusted_text?.title || task.title || '', completed: !!task.completed,
  completedAt: task.completed_at || null, due: task.due || null, recurrence: task.recurrence || null });
const actionFor = (item, context) => item.status === 'already_completed' && (context.actor === 'user' || context.userQuote)
  ? 'confirmed' : ['created', 'reopened', 'completed', 'occurrence_completed'].includes(item.status) ? item.status : null;

class TaskHistory {
  constructor(store, todo) {
    this.store = store; this.todo = todo; this.tail = Promise.resolve();
    store.data.taskEvents ||= [];
  }
  context(actor, args = {}) {
    const run = actor === 'agent' ? require('./run-context').currentRun(this.store) : null;
    const quote = String(args.user_confirmation_quote || '').trim();
    const incoming = run?.inputEvents?.find(e => e.actor === 'user' && quote && e.data?.text?.includes(quote));
    const message = run && !run.background ? this.store.data.messages.find(m => m.id === run.queueId && m.role === 'user')
      : incoming ? { id: incoming.id, text: incoming.data.text, createdAt: incoming.createdAt } : null;
    if (quote && (!message || quote.length < 2 || !message.text.includes(quote))) {
      throw new Error('用户确认必须引用当前对话中真实存在的用户原话；自主判断请只填写 completion_evidence');
    }
    return { actor: actor === 'user' ? 'user' : 'agent', basis: actor === 'user' ? 'direct' : quote ? 'user_statement' : 'ai_judgment',
      evidence: String(args.completion_evidence || '').slice(0, 6000),
      runId: run?.id || null, messageId: incoming ? null : message?.id || null, inputEventId: incoming?.id || null,
      ...(quote ? { userQuote: quote, userStatementAt: message.createdAt } : {}) };
  }
  serial(work) {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
  edit({ id, expected, patch }, trash = false) {
    return this.serial(async () => {
      const cookie = await this.todo.browserSession();
      const { task } = await this.todo.call('get_task', { id, timezone:'Asia/Shanghai' });
      const editable = t => ({ title:t.untrusted_text?.title || t.title || '', description:t.untrusted_text?.description || t.description || '',
        due:t.due || null, completed:!!t.completed, recurrence:t.recurrence || null });
      if (!expected || JSON.stringify(editable(task)) !== JSON.stringify(editable(expected))) throw new Error('待办已变化，请重新打开后操作');
      let changes;
      if (!trash) {
        if (typeof patch?.title !== 'string' || !patch.title.trim() || patch.title.length > 300
          || typeof patch.description !== 'string' || patch.description.length > 20000) throw new Error('请填写标题，说明最多 2 万字');
        changes = { title:patch.title.trim(), description:patch.description, due:patch.due };
        if (changes.due !== null && (!changes.due || !/^\d{4}-\d{2}-\d{2}$/.test(changes.due.date))) throw new Error('日期无效');
        if (changes.due) changes.due = { date:changes.due.date, ...(changes.due.time ? { time:changes.due.time, tz:'Asia/Shanghai' } : {}) };
      }
      const action = trash ? 'trashed' : 'edited';
      const request = this.store.add('taskEvents', { action:'requested', tool:action, taskIds:[id], actor:'user', before:editable(task) });
      try {
        // The pinned upstream REST endpoint atomically patches the entire due object.
        // Its MCP schedule tool preserves an old time when the field is omitted.
        await this.todo.request('/api/v1/tasks/' + encodeURIComponent(id), trash ? 'DELETE' : 'PATCH', changes, cookie);
      } catch (error) {
        this.store.add('taskEvents', { action:'uncertain', requestId:request.id, taskId:id, actor:'user', evidence:error.message });
        throw error;
      }
      return this.store.add('taskEvents', { action, requestId:request.id, taskId:id, title:editable(task).title,
        actor:'user', before:editable(task), after:changes || null, evidence:trash ? '用户移入 OpenTodo 回收站' : '用户编辑待办' });
    });
  }
  list({ taskId, before, limit = 100 } = {}) {
    const size = Math.max(1, Math.min(200, Number(limit) || 100));
    const recorded = this.store.data.taskEvents;
    const answered = new Set(recorded.filter(e => e.requestId).map(e => e.requestId));
    const archived = new Set(recorded.filter(e => e.requestId && e.taskId).map(e => `${e.requestId}:${e.taskId}:${e.action}`));
    let events = recorded.filter(e => (e.action !== 'receipt' || e.results.some(item =>
      actionFor(item, e) && !archived.has(`${e.requestId}:${item.id}:${actionFor(item, e)}`)))
      && (e.action !== 'requested' || !answered.has(e.id)));
    if (taskId) {
      const related = new Set([taskId, ...recorded.filter(e => e.taskId === taskId && e.occurrenceId).map(e => e.occurrenceId)]);
      events = events.filter(e => related.has(e.taskId) || related.has(e.occurrenceId) || e.taskIds?.some(id => related.has(id)));
    }
    if (before) {
      const index = events.findIndex(e => e.id === before);
      if (index < 0) throw new Error('历史游标无效，请刷新');
      events = events.slice(0, index);
    }
    const page = events.slice(-size).reverse();
    return { events: page, nextCursor: events.length > size ? page.at(-1).id : null };
  }
  latest(task) {
    return this.store.data.taskEvents.findLast(e => (e.taskId === task.id || e.occurrenceId === task.id)
      && ['completed', 'occurrence_completed', 'confirmed', 'reopened'].includes(e.action));
  }
  decorate(task) {
    if (!task?.id) return task;
    const event = this.latest(task);
    // completed_at identifies this completion, including externally reopened
    // then re-completed tasks. Missing metadata must not borrow an old author.
    const matches = task.completed && event && event.action !== 'reopened' && event.completedAt
      && Date.parse(event.completedAt) === Date.parse(task.completed_at);
    return { ...task, completionRecord: matches ? event : null };
  }
  decorateResult(name, result) {
    if (!result || typeof result !== 'object') return result;
    if (result.task) result.task = this.decorate(result.task);
    for (const key of ['tasks', 'subtasks', 'overdue', 'due_today']) {
      if (Array.isArray(result[key])) result[key] = result[key].map(t => this.decorate(t));
    }
    return result;
  }
  async call(name, args, actor) {
    if (!MUTATIONS.has(name)) return this.decorateResult(name, await this.todo.call(name, args));
    const context = this.context(actor, args);
    if (actor !== 'user' && name !== 'create_tasks' && !context.evidence.trim()) throw new Error('请填写 completion_evidence，说明完成或更正的实际依据');
    const { completion_evidence, user_confirmation_quote, ...upstream } = args;
    return this.serial(async () => {
      const before = new Map();
      if (name !== 'create_tasks') {
        if (!Array.isArray(args.ids) || !args.ids.length || args.ids.length > 50) throw new Error('请选择 1～50 个任务');
        for (const id of new Set(args.ids)) {
          const { task } = await this.todo.call('get_task', { id, timezone: args.timezone || 'Asia/Shanghai' });
          if (name === 'reopen_tasks' && context.actor === 'agent') {
            const previous = this.decorate(task).completionRecord;
            if (previous && (previous.actor === 'user' || previous.basis === 'user_statement') && !context.userQuote) {
              throw new Error('用户已确认完成；只有用户提出更正时才能重新打开，请引用本轮用户的更正原话');
            }
          }
          before.set(id, snapshot(task));
        }
      }
      // Persist intent before dispatch. A crash or lost response is never a
      // successful completion and must not trigger an automatic replay.
      const request = this.store.add('taskEvents', { action: 'requested', tool: name,
        taskIds: [...before.keys()], ...context });
      let result;
      try { result = await this.todo.call(name, upstream); }
      catch (error) {
        this.store.add('taskEvents', { action: 'uncertain', requestId: request.id, taskIds: [...before.keys()],
          tool: name, ...context, evidence: `操作未获得成功回执，先读取实际状态，勿直接重试：${error.message}` });
        throw error;
      }
      // The upstream receipt is retained before follow-up reads, so a read
      // failure never invites a second completion of the next occurrence.
      this.store.add('taskEvents', { action: 'receipt', requestId: request.id, tool: name,
        taskIds: (result.results || []).map(r => r.id), results: result.results || [], ...context });
      for (const item of result.results || []) {
        const action = actionFor(item, context);
        if (!action) continue;
        let task = null;
        try { ({ task } = await this.todo.call('get_task', { id: item.occurrence_id || item.id, timezone: args.timezone || 'Asia/Shanghai' })); }
        catch { /* The receipt proves the mutation, but attribution in a live card waits for an exact snapshot. */ }
        this.store.add('taskEvents', { action, requestId: request.id, taskId: item.id,
          occurrenceId: item.occurrence_id || null, nextDue: item.next_due || null,
          title: before.get(item.id)?.title || task?.untrusted_text?.title || '',
          before: before.get(item.id) || null, after: task ? snapshot(task) : null,
          completedAt: task?.completed_at || (action === 'confirmed' ? before.get(item.id)?.completedAt : null), ...context });
      }
      return result;
    });
  }
  confirm({ taskId, eventId, completedAt }) {
    return this.serial(async () => {
      const { task } = await this.todo.call('get_task', { id: taskId, timezone: 'Asia/Shanghai' });
      const record = this.decorate(task).completionRecord;
      if (!task.completed) throw new Error('任务已经重新打开，请刷新后处理');
      if (!completedAt || Date.parse(completedAt) !== Date.parse(task.completed_at)) throw new Error('完成时间已变化，请刷新后再确认');
      if ((record?.id || null) !== (eventId || null)) throw new Error('完成记录已变化，请重新查看后确认');
      if (record?.actor === 'user') return record;
      return this.store.add('taskEvents', { action: 'confirmed', taskId,
        title: task.untrusted_text?.title || '', completedAt: task.completed_at || null,
        actor: 'user', basis: 'direct', evidence: '用户在工作台确认此项已完成',
        confirmsEventId: record?.id || null, before: snapshot(task), after: snapshot(task) });
    });
  }
}
module.exports = { TaskHistory };
