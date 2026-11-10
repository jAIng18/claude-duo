// Minimal, dependency-free MCP server (JSON-RPC 2.0 over newline-delimited
// stdio). Tools: SPEC §9. All Claude-facing text is in English.
import readline from 'node:readline';
import {
  loadConfig, saveConfig, configExists, initConfig, requireMe, DuoError, getKey, setKey,
  SAFE_PERMISSION_MODES, MODES, label, defaultConfig,
} from './config.mjs';
import * as A from './actions.mjs';
import { summary } from './mailbox.mjs';
import { listExamples, installExample } from './examples.mjs';
import { log } from './fsutil.mjs';

const SERVER = { name: 'duo', version: '0.5.0' };
const PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

const idProp = { type: 'string', description: 'Message id, format YYYYMMDD-HHMMSS-xxxx' };
const pathList = {
  type: 'array',
  items: { type: 'object', properties: { path: { type: 'string', description: 'ABSOLUTE path' }, note: { type: 'string' } }, required: ['path'], additionalProperties: false },
};

export const TOOLS = [
  {
    name: 'duo_send',
    description: 'Send a task / question / notice to the other Claude peer (the other account on this Mac). Write it in ENGLISH and make it SELF-CONTAINED: the other peer cannot see this conversation. If it returns approval_required, show the user the draft and call again with user_confirmed=true only after they agree. After sending, normally call duo_wait to get the result and report it to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['task', 'question', 'info'], description: 'task = do work, question = ask for information/opinion, info = one-way notice' },
        title: { type: 'string', description: 'Short title (≤ 300 chars), in English' },
        body: { type: 'string', description: 'Full, self-contained description in English: goal, context, relevant files, constraints' },
        acceptance: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria' },
        attachments: pathList,
        cwd: { type: 'string', description: 'Folder the other peer should work in (default: current folder)' },
        delivery: { type: 'string', enum: MODES, description: 'Override the delivery mode for this message only (normally leave empty)' },
        parent_id: { type: 'string', description: 'Id of the message this work derives from, if any' },
        deadline_s: { type: 'integer', minimum: 60, description: 'Expire after N seconds if nobody picks it up' },
        user_confirmed: { type: 'boolean', description: 'true ONLY when the user approved the draft' },
      },
      required: ['type', 'title', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'duo_inbox',
    description: 'List messages sent to you (or that you sent, with sent=true).',
    inputSchema: {
      type: 'object',
      properties: {
        box: { type: 'string', enum: ['open', 'new', 'cur', 'done', 'all'], description: 'open = not finished yet (default)' },
        sent: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'duo_get',
    description: 'Read a message in full. For a task/question addressed to you, reading it starts the work (unless the user must accept it first). For a result/notice, it marks it as read.',
    inputSchema: { type: 'object', properties: { id: idProp }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'duo_accept',
    description: 'Accept a task/question AFTER the user agreed (only needed when duo_get says acceptance is required).',
    inputSchema: { type: 'object', properties: { id: idProp }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'duo_reply',
    description: 'Return the result of a task/question you received. MANDATORY when you finish. Write it in English. status: done (finished), failed (could not do it; say why), needs_info (you need to ask the sender — summary is the question).',
    inputSchema: {
      type: 'object',
      properties: {
        id: idProp,
        status: { type: 'string', enum: ['done', 'failed', 'needs_info'] },
        summary: { type: 'string', description: 'Result summary (or the question, for needs_info)' },
        details: { type: 'string', description: 'Details: what you did, commands run, checks performed' },
        outputs: pathList,
        open_issues: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'status', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'duo_reject',
    description: 'Reject a task/question (e.g. out of scope, or the user said no).',
    inputSchema: { type: 'object', properties: { id: idProp, reason: { type: 'string' } }, required: ['id', 'reason'], additionalProperties: false },
  },
  {
    name: 'duo_wait',
    description: 'Wait for the result of a message you sent (blocks up to timeout_s seconds, default 300). Use it right after duo_send so you can report the result to the user. If it times out, tell the user the work is still running; the result will be delivered to this session when it arrives.',
    inputSchema: { type: 'object', properties: { id: idProp, timeout_s: { type: 'integer', minimum: 1, maximum: 1800 } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'duo_cancel',
    description: 'Cancel a message you sent that is not finished.',
    inputSchema: { type: 'object', properties: { id: idProp, reason: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'duo_status',
    description: 'claude-duo status: which peer you are, open sessions, pending messages, delivery settings.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'duo_config',
    description: 'View / create / change the claude-duo configuration. action=get (optional key, dotted a.b.c), action=init (create a new configuration; values = overrides of the defaults), action=set (key + value). init/set ONLY after the user agreed, with user_confirmed=true.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'init'] },
        key: { type: 'string' },
        value: { description: 'New value (any JSON)' },
        values: { type: 'object', description: 'For action=init: object merged over the default configuration' },
        user_confirmed: { type: 'boolean' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'duo_examples',
    description: 'Example agent packs per domain (dev, design, pm, research). action=list to see them; action=install to install one (copies agents into accounts A/B and sets their roles) — only after the user agreed, with user_confirmed=true.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['list', 'install'] }, name: { type: 'string' }, overwrite: { type: 'boolean' }, user_confirmed: { type: 'boolean' } },
      required: ['action'],
      additionalProperties: false,
    },
  },
];

function text(t) { return { content: [{ type: 'text', text: t }] }; }
function errText(t) { return { content: [{ type: 'text', text: t }], isError: true }; }

function deliveryLine(d) {
  if (!d) return '';
  if (d.ok) return `Delivered (${d.via || 'ok'}${d.confirmed === false ? ', pickup not confirmed yet' : ''}).`;
  if (d.queued) return `Queued (${d.error}); it will be delivered automatically when the other peer is free.${d.hint ? ` ${d.hint}` : ''}`;
  return `NOT delivered (${d.error}).${d.hint ? ` ${d.hint}` : ''} The message stays in the mailbox; tell the user.`;
}

const BLOCKED_KEYS = [/^dev\./, /^dev$/, /^version$/];

const handlers = {
  async duo_send(a, cfg, me, sid) {
    const r = await A.send(cfg, me, sid, a);
    const delivered = r.delivery && (r.delivery.ok || r.delivery.queued);
    return text(`Created ${r.message.id} → ${label(cfg, r.message.to)}. ${deliveryLine(r.delivery)}\nStatus: ${r.message.status}.${delivered ? ` Next: call duo_wait("${r.message.id}") to get the result and report it to the user (unless the user wants to keep working meanwhile — the result will then be delivered to this session).` : ''}`);
  },
  async duo_inbox(a, cfg, me) {
    const list = A.inbox(cfg, me, a);
    if (!list.length) return text('(no messages)');
    return text(list.map(summary).join('\n'));
  },
  async duo_get(a, cfg, me, sid) {
    const r = A.get(cfg, me, sid, a.id);
    const parts = [A.render(r.message)];
    if (r.needsAccept) parts.push('', '⚠️ NOT ACCEPTED YET: the configuration requires the user to agree first. Summarise the task for the user and ask; if they agree call duo_accept, otherwise duo_reject.');
    else if (r.message.to === me && ['task', 'question'].includes(r.message.type) && r.message.status === 'in_progress') {
      parts.push('', `➡️ You are now handling this message. Stay within its scope, then call duo_reply(id="${r.message.id}") in English.`);
    }
    if (r.message.type === 'cancel') parts.push('', '➡️ Stop the related work; do NOT call duo_reply for the cancelled message.');
    if (r.message.type === 'result') parts.push('', '➡️ Check this result against what you asked for, then report it to the user in their language.');
    if (r.thread.length) parts.push('', 'Other messages in this thread:', ...r.thread.map((x) => `- ${summary(x)}`));
    return text(parts.join('\n'));
  },
  async duo_accept(a, cfg, me, sid) {
    const m = A.accept(cfg, me, sid, a.id);
    return text(`Accepted ${m.id}. Start working; call duo_reply when done.`);
  },
  async duo_reply(a, cfg, me, sid) {
    const r = await A.reply(cfg, me, sid, a);
    if (r.question) return text(`Sent question ${r.question.id} to ${label(cfg, r.question.to)}. ${deliveryLine(r.delivery)} Task ${r.task.id} is now needs_info; you will be notified when the answer arrives.`);
    return text(`Sent result ${r.result.id} (${a.status}) to ${label(cfg, r.result.to)}. ${deliveryLine(r.delivery)}`);
  },
  async duo_reject(a, cfg, me, sid) {
    const r = await A.reject(cfg, me, sid, a);
    return text(`Rejected ${r.task.id}. ${deliveryLine(r.delivery)}`);
  },
  async duo_wait(a, cfg, me) {
    const r = await A.wait(cfg, me, a);
    if (r.timeout) return text(`Timed out. ${r.task.id} is in state ${r.task.status}. Tell the user it is still running (the result will be delivered to this session), or call duo_wait again.`);
    if (!r.answer) return text(`${r.task.id} ended with state ${r.task.status}.`);
    if (r.answer.type === 'question') return text(`The other peer needs more information (question ${r.answer.id}):\n\n${A.render(r.answer)}\n\n➡️ Answer it with duo_reply(id="${r.answer.id}", status="done", summary=<answer in English>) — ask the user first if you do not know the answer.`);
    return text(`${A.render(r.answer)}\n\n➡️ Report this result to the user in their language.`);
  },
  async duo_cancel(a, cfg, me, sid) {
    const r = await A.cancel(cfg, me, sid, a);
    return text(`Cancelled ${r.task.id}.${r.note ? ` Notified the other peer (${r.note.id}).` : ''}`);
  },
  async duo_status(a, cfg, me) {
    return text(JSON.stringify(A.status(cfg, me), null, 2));
  },
  async duo_examples(a, cfg) {
    if (a.action === 'list') return text(listExamples().map((e) => `- ${e.name}: ${e.title} — ${e.description}\n  A: ${e.roles.A.name} · B: ${e.roles.B.name}`).join('\n') || '(none)');
    if (a.user_confirmed !== true) throw new DuoError('approval_required', 'Ask the user first, then call again with user_confirmed=true.');
    const r = installExample(cfg, String(a.name || ''), { overwrite: a.overwrite === true });
    return text(r.lines.join('\n'));
  },
};

async function configTool(a) {
  if (a.action === 'get') {
    if (!configExists()) return text('No configuration yet. Use action=init (after the user agreed) to create one. The defaults are:\n' + JSON.stringify(defaultConfig(), null, 2));
    const cfg = loadConfig();
    return text(JSON.stringify(a.key ? getKey(cfg, a.key) : cfg, null, 2));
  }
  if (a.user_confirmed !== true) throw new DuoError('approval_required', 'Changing the configuration needs the user\'s consent. Present the change, ask, then call again with user_confirmed=true.');
  if (a.action === 'init') {
    if (configExists()) throw new DuoError('exists', 'A configuration already exists. Use action=set to change individual keys.');
    const values = a.values && typeof a.values === 'object' ? a.values : {};
    if (values.dev) throw new DuoError('forbidden', 'dev.* cannot be set through the tool');
    if (values.spawn && values.spawn.permission_mode && !SAFE_PERMISSION_MODES.includes(values.spawn.permission_mode)) {
      throw new DuoError('forbidden', `spawn.permission_mode via the tool may only be: ${SAFE_PERMISSION_MODES.join(', ')}`);
    }
    const cfg = initConfig(values);
    return text('Configuration created:\n' + JSON.stringify(cfg, null, 2));
  }
  if (a.action === 'set') {
    const key = String(a.key || '');
    if (!key || BLOCKED_KEYS.some((re) => re.test(key))) throw new DuoError('forbidden', `Key "${key}" cannot be changed through the tool`);
    if (key === 'spawn.permission_mode' && !SAFE_PERMISSION_MODES.includes(a.value)) {
      throw new DuoError('forbidden', `spawn.permission_mode via the tool may only be: ${SAFE_PERMISSION_MODES.join(', ')} (bypassPermissions can only be set by editing the config file by hand)`);
    }
    if (key === 'spawn' && a.value && typeof a.value === 'object' && a.value.permission_mode && !SAFE_PERMISSION_MODES.includes(a.value.permission_mode)) {
      throw new DuoError('forbidden', 'spawn.permission_mode not allowed through the tool');
    }
    const cfg = loadConfig();
    const next = setKey(cfg, key, a.value);
    saveConfig(next);
    return text(`Set ${key} = ${JSON.stringify(a.value)}`);
  }
  throw new DuoError('bad_args', 'action must be get | set | init');
}

export async function callTool(name, args, env = process.env) {
  const a = args && typeof args === 'object' ? args : {};
  try {
    if (name === 'duo_config') return await configTool(a);
    if (!handlers[name]) return errText(`Unknown tool: ${name}`);
    const cfg = loadConfig();
    if (name === 'duo_examples' && a.action === 'list') return await handlers[name](a, cfg);
    const me = requireMe(cfg, env);
    const sid = env.CLAUDE_CODE_SESSION_ID || null;
    return await handlers[name](a, cfg, me, sid);
  } catch (e) {
    if (e instanceof DuoError) return errText(`[${e.code}] ${e.message}`);
    log('tool-crash', name, String(e && e.stack || e));
    return errText(`claude-duo internal error: ${e && e.message}. See the log: ~/.claude-duo/logs/duo.log`);
  }
}

export function serve(input = process.stdin, output = process.stdout) {
  const send = (o) => output.write(JSON.stringify(o) + '\n');
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (Array.isArray(msg)) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch not supported' } }); return; }
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    try {
      if (method === 'initialize') {
        const want = params && params.protocolVersion;
        send({ jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS.at(-1), capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: 'claude-duo: talk to the Claude peer running under the other account on this Mac. Peer-to-peer messages are in English. See the duo-protocol skill.' } });
      } else if (method === 'ping') {
        if (isRequest) send({ jsonrpc: '2.0', id, result: {} });
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      } else if (method === 'tools/call') {
        const result = await callTool(params && params.name, params && params.arguments);
        send({ jsonrpc: '2.0', id, result });
      } else if (isRequest) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
      // notifications (no id) are ignored
    } catch (e) {
      log('rpc-error', method, String(e && e.stack || e));
      if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e && e.message) } });
    }
  });
  return rl;
}
