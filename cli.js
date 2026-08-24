#!/usr/bin/env node

// copilot-remote-host — CLI to discover, connect, and monitor remote Agent Host instances
// Uses the Agent Host Protocol (AHP) WebSocket interface from VS Code 1.134

import { WebSocket } from 'ws';
import { createInterface } from 'readline';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const VERSION = '1.0.0';

// ── Helpers ──

function usage() {
  console.log(`copilot-remote-host v${VERSION}

Usage:
  copilot-remote-host discover              Scan for local Agent Host processes
  copilot-remote-host connect <url>         Connect to an AHP WebSocket endpoint
  copilot-remote-host monitor <url>         Live-stream all AHP actions
  copilot-remote-host sessions <url>        List active sessions on a host
  copilot-remote-host send <url> <msg>      Send a user message to the active session
  copilot-remote-host status <url>          Show host status and capabilities

Options:
  --token <token>    Connection token for authenticated hosts
  --timeout <ms>     Connection timeout (default: 5000)
  --json             Output as JSON
  --help             Show this help
`);
}

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { _: [], token: null, timeout: 5000, json: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--token') { args.token = argv[++i]; }
    else if (a === '--timeout') { args.timeout = parseInt(argv[++i], 10); }
    else if (a === '--json') { args.json = true; }
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else { args._.push(a); }
    i++;
  }
  return args;
}

// ── AHP Client ──

class AHPClient {
  constructor(url, token, timeout = 5000) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.timeout = timeout;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
  }

  wsUrl() {
    let u = this.url;
    if (!u.startsWith('ws')) u = u.replace(/^http/, 'ws');
    if (this.token) u += (u.includes('?') ? '&' : '?') + `token=${this.token}`;
    return u;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Connection timeout after ${this.timeout}ms`));
      }, this.timeout);

      this.ws = new WebSocket(this.wsUrl());

      this.ws.on('open', () => {
        clearTimeout(timer);
        resolve();
      });

      this.ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(msg);
        } catch { /* ignore non-JSON */ }
      });

      this.ws.on('close', (code, reason) => {
        for (const [, rej] of this.pending) rej.reject(new Error('Connection closed'));
        this.pending.clear();
      });
    });
  }

  _handleMessage(msg) {
    // JSON-RPC response
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    // Notification / action broadcast
    for (const fn of this.listeners) fn(msg);
  }

  onAction(fn) {
    this.listeners.push(fn);
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, this.timeout);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  async close() {
    if (this.ws) this.ws.close();
  }
}

// ── Commands ──

async function cmdDiscover(args) {
  console.log('Scanning for Agent Host processes...\n');

  // Look for VS Code agent host processes
  let procs = '';
  try {
    procs = execSync(
      "ps aux | grep -i 'agent.host\\|code.*agent' | grep -v grep",
      { encoding: 'utf-8', timeout: 3000 }
    );
  } catch { /* no matches */ }

  // Check default AHP ports
  const defaultPorts = [4040, 4041, 4042, 18200, 18201];
  const found = [];

  for (const port of defaultPorts) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => { ws.close(); reject(); }, 1500);
        ws.on('open', () => { clearTimeout(t); ws.close(); resolve(); });
        ws.on('error', () => { clearTimeout(t); reject(); });
      });
      found.push({ host: '127.0.0.1', port, status: 'open' });
    } catch { /* port not open */ }
  }

  // Check for connection token files
  const tokenDir = join(homedir(), '.vscode', 'agent-host');
  let tokenFiles = [];
  if (existsSync(tokenDir)) {
    try {
      tokenFiles = execSync(`ls "${tokenDir}"`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
    } catch { /* empty */ }
  }

  if (args.json) {
    console.log(JSON.stringify({ processes: procs.trim().split('\n').filter(Boolean), ports: found, tokenFiles }, null, 2));
  } else {
    if (procs.trim()) {
      console.log('Agent Host processes:');
      procs.trim().split('\n').forEach(l => console.log(`  ${l.trim()}`));
      console.log();
    } else {
      console.log('No Agent Host processes found.\n');
    }

    if (found.length) {
      console.log('Open AHP ports:');
      found.forEach(p => console.log(`  ws://${p.host}:${p.port}  [${p.status}]`));
      console.log();
    } else {
      console.log('No open AHP ports on default range.\n');
    }

    if (tokenFiles.length) {
      console.log(`Token files in ${tokenDir}:`);
      tokenFiles.forEach(f => console.log(`  ${f}`));
    }

    console.log('\nTip: Start a host with `code agent host` or `code agent host --tunnel`');
  }
}

async function cmdConnect(args) {
  const url = args._[1];
  if (!url) die('Usage: copilot-remote-host connect <url>');

  const client = new AHPClient(url, args.token, args.timeout);
  console.log(`Connecting to ${url}...`);

  await client.connect();
  console.log('Connected to Agent Host.\n');

  // Try to get initial status
  try {
    const status = await client.request('host/status');
    console.log('Host status:', JSON.stringify(status, null, 2));
  } catch {
    console.log('(host/status not available — host may use a different method name)');
  }

  // Interactive REPL
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'ahp> ' });

  client.onAction((msg) => {
    const method = msg.method || msg.type || 'action';
    console.log(`\n← ${method}:`, JSON.stringify(msg.params || msg, null, 2));
    rl.prompt();
  });

  console.log('\nInteractive AHP console. Type JSON-RPC method calls:');
  console.log('  method param1=val1 param2=val2');
  console.log('  quit\n');

  rl.prompt();
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'quit' || trimmed === 'exit') {
      await client.close();
      process.exit(0);
    }

    const parts = trimmed.split(/\s+/);
    const method = parts[0];
    const params = {};
    for (let i = 1; i < parts.length; i++) {
      const [k, ...rest] = parts[i].split('=');
      const v = rest.join('=');
      try { params[k] = JSON.parse(v); } catch { params[k] = v; }
    }

    try {
      const result = await client.request(method, params);
      console.log('→', JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('Error:', err.message);
    }
    rl.prompt();
  });
}

async function cmdMonitor(args) {
  const url = args._[1];
  if (!url) die('Usage: copilot-remote-host monitor <url>');

  const client = new AHPClient(url, args.token, args.timeout);
  console.log(`Monitoring ${url}...\n`);

  await client.connect();
  console.log('Connected. Streaming all AHP actions (Ctrl+C to stop):\n');

  let actionCount = 0;
  const startTime = Date.now();

  client.onAction((msg) => {
    actionCount++;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const method = msg.method || msg.type || 'unknown';
    const seq = msg.params?.serverSeq || msg.serverSeq || '?';

    if (args.json) {
      console.log(JSON.stringify({ seq, elapsed, method, data: msg.params || msg }));
    } else {
      const summary = summarizeAction(method, msg.params || msg);
      console.log(`[${elapsed}s] #${seq} ${method}${summary ? ' — ' + summary : ''}`);
    }
  });

  process.on('SIGINT', async () => {
    console.log(`\n\nMonitored ${actionCount} actions in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    await client.close();
    process.exit(0);
  });
}

function summarizeAction(method, params) {
  if (!params) return '';
  if (method === 'chat/delta') return truncate(params.content || params.text || '', 80);
  if (method === 'chat/turnStarted') return truncate(params.message || params.prompt || '', 80);
  if (method === 'chat/toolCallStart') return `${params.name || params.tool || '?'} on ${params.file || params.target || '?'}`;
  if (method === 'chat/toolCallComplete') return params.status || 'done';
  if (method === 'chat/turnComplete') return `turn ${params.turnId || '?'} done`;
  return '';
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '...' : s;
}

async function cmdSessions(args) {
  const url = args._[1];
  if (!url) die('Usage: copilot-remote-host sessions <url>');

  const client = new AHPClient(url, args.token, args.timeout);
  await client.connect();

  try {
    const sessions = await client.request('sessions/list');
    if (args.json) {
      console.log(JSON.stringify(sessions, null, 2));
    } else {
      const list = Array.isArray(sessions) ? sessions : sessions?.sessions || [];
      if (!list.length) {
        console.log('No active sessions.');
      } else {
        console.log(`Found ${list.length} session(s):\n`);
        for (const s of list) {
          const id = s.id || s.sessionId || '?';
          const state = s.state || s.status || 'unknown';
          const chats = s.chats?.length || s.chatCount || 0;
          const agent = s.agent || s.harness || 'copilot';
          console.log(`  ${id}`);
          console.log(`    Agent: ${agent}  State: ${state}  Chats: ${chats}`);
          if (s.title || s.name) console.log(`    Title: ${s.title || s.name}`);
          console.log();
        }
      }
    }
  } catch (err) {
    console.error('Could not list sessions:', err.message);
  }

  await client.close();
}

async function cmdSend(args) {
  const url = args._[1];
  const message = args._.slice(2).join(' ');
  if (!url || !message) die('Usage: copilot-remote-host send <url> <message>');

  const client = new AHPClient(url, args.token, args.timeout);
  await client.connect();

  // Subscribe to responses
  client.onAction((msg) => {
    const method = msg.method || '';
    if (method === 'chat/delta') {
      process.stdout.write(msg.params?.content || msg.params?.text || '');
    } else if (method === 'chat/turnComplete') {
      console.log('\n\n[Turn complete]');
      client.close().then(() => process.exit(0));
    }
  });

  try {
    console.log(`Sending: "${message}"\n`);
    await client.request('chat/sendMessage', { message });
  } catch (err) {
    // Some hosts use fire-and-forget notifications for messages
    console.log('(Message sent as notification)');
  }

  // Wait for response with a generous timeout
  setTimeout(async () => {
    console.log('\n[Timeout — no turn completion received]');
    await client.close();
    process.exit(0);
  }, 60000);
}

async function cmdStatus(args) {
  const url = args._[1];
  if (!url) die('Usage: copilot-remote-host status <url>');

  const client = new AHPClient(url, args.token, args.timeout);
  await client.connect();

  const info = {};

  // Probe standard AHP methods
  const probes = ['host/status', 'host/capabilities', 'sessions/list', 'host/version'];
  for (const method of probes) {
    try {
      info[method] = await client.request(method);
    } catch (err) {
      info[method] = { error: err.message };
    }
  }

  if (args.json) {
    console.log(JSON.stringify(info, null, 2));
  } else {
    console.log('Agent Host Status\n');
    for (const [method, result] of Object.entries(info)) {
      console.log(`${method}:`);
      if (result?.error) {
        console.log(`  (not available: ${result.error})`);
      } else {
        const lines = JSON.stringify(result, null, 2).split('\n');
        lines.forEach(l => console.log(`  ${l}`));
      }
      console.log();
    }
  }

  await client.close();
}

// ── Main ──

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

try {
  switch (command) {
    case 'discover': await cmdDiscover(args); break;
    case 'connect': await cmdConnect(args); break;
    case 'monitor': await cmdMonitor(args); break;
    case 'sessions': await cmdSessions(args); break;
    case 'send': await cmdSend(args); break;
    case 'status': await cmdStatus(args); break;
    default: usage(); process.exit(command ? 1 : 0);
  }
} catch (err) {
  die(err.message);
}
