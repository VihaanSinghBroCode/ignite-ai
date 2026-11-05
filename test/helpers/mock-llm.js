// A local stand-in for both LLM APIs, speaking their real SSE wire formats so the
// actual SDKs parse the responses. Tests queue one scripted reply per expected request.

import http from 'node:http';

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function chunks(text, size = 400) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function streamAnthropic(res, reply) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1000, output_tokens: 1 },
    },
  });
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (const text of chunks(reply.text ?? '')) {
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  }
  if (reply.hang) return undefined; // Leaves the stream open, like a slow model.
  if (reply.midStreamError) {
    sse(res, 'error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    return res.end();
  }
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: reply.stopReason ?? 'end_turn', stop_sequence: null },
    usage: { output_tokens: 2000 },
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  return res.end();
}

function streamOpenAI(res, reply) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let sequence_number = 0;
  const send = (event) => sse(res, event.type, { ...event, sequence_number: sequence_number++ });
  if (reply.events) {
    reply.events.forEach(send);
    return res.end();
  }
  send({ type: 'response.created', response: { id: 'resp_mock', status: 'in_progress' } });
  for (const delta of chunks(reply.text ?? '')) {
    send({ type: 'response.output_text.delta', delta, item_id: 'msg', output_index: 0, content_index: 0 });
  }
  const usage = { input_tokens: 1000, output_tokens: 2000, total_tokens: 3000 };
  if (reply.incomplete) {
    send({ type: 'response.incomplete', response: { id: 'resp_mock', status: 'incomplete', usage, incomplete_details: { reason: reply.incomplete } } });
  } else {
    send({ type: 'response.completed', response: { id: 'resp_mock', status: 'completed', usage } });
  }
  return res.end();
}

/** replies: [{ status, headers, body } for an HTTP error, or { text, ... } for a stream] */
export async function startMockLLM(replies) {
  const requests = [];
  const queue = [...replies];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const record = { url: req.url, headers: req.headers, body: JSON.parse(raw || '{}'), closedEarly: false };
      requests.push(record);
      res.once('close', () => {
        record.closedEarly = !res.writableEnded;
      });
      const reply = queue.shift();
      if (!reply) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'mock queue is empty' } }));
      }
      if (reply.status) {
        res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
        return res.end(JSON.stringify(reply.body));
      }
      return req.url.startsWith('/v1/responses') ? streamOpenAI(res, reply) : streamAnthropic(res, reply);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    requests,
    remaining: () => queue.length,
    anthropicUrl: `http://127.0.0.1:${port}`,
    openaiUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// A small app that really builds and runs. /api/env reports what it can see of the environment.
export const GOOD_SERVER = `import express from 'express';
import { WebSocketServer } from 'ws';

const app = express();
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/env', (req, res) => res.json({
  anthropic: process.env.ANTHROPIC_API_KEY ?? null,
  openai: process.env.OPENAI_API_KEY ?? null,
  canary: process.env.MY_SECRET_TOKEN ?? null,
  hasPath: Boolean(process.env.PATH),
}));
app.get('/{*splat}', (req, res) => res.send('spa fallback'));
const server = app.listen(process.env.PORT || 3001, '127.0.0.1');
new WebSocketServer({ server, path: '/api/ws' }).on('connection', (socket) => socket.send('hello from the api'));
`;

// Crashes at startup on Express 5, the mistake models make most often with this stack.
export const BROKEN_SERVER = GOOD_SERVER.replace("app.get('/api/health'", "app.get('*', (req, res) => res.send('x'));\napp.get('/api/health'");

export const appFiles = (overrides = {}) => ({
  'package.json': JSON.stringify({
    name: 'whatever-the-model-said',
    description: 'A test app',
    scripts: {
      preinstall: 'touch PWNED_PREINSTALL',
      postinstall: 'touch PWNED_POSTINSTALL',
      dev: 'touch PWNED_DEV && vite',
    },
    dependencies: { react: '^16.0.0', nanoid: '^5.0.0', 'left-pad': 'github:attacker/left-pad' },
    overrides: { react: 'file:../attacker' },
    bin: { sneaky: 'server/index.js' },
  }),
  'index.html': '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n',
  'src/main.jsx': "import { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\ncreateRoot(document.getElementById('root')).render(<App />);\n",
  'src/App.jsx': "import { nanoid } from 'nanoid';\nexport default function App() {\n  return <h1>Hello {nanoid(4)}</h1>;\n}\n",
  'server/index.js': GOOD_SERVER,
  'README.md': '# Test app\n',
  ...overrides,
});
