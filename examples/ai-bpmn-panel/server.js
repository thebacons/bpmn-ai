const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.AI_PORT) || 5174;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

const catalogPath = path.join(__dirname, 'app', 'ai', 'model-catalog.json');
const modelCatalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

const SYSTEM_PROMPT = [
  'You are a BPMN 2.0 modeler.',
  'Return valid BPMN 2.0 XML only. Do not include code fences or explanations.',
  'Include BPMN DI (bpmndi:BPMNDiagram, bpmndi:BPMNPlane, and shapes/edges).',
  'Use a single process with a start event, tasks, gateways as needed, and an end event.',
  'Keep the diagram simple, readable, and consistent with the user request.'
].join(' ');

const CHAT_FORMAT_PROMPT = [
  'Return a JSON object with keys: summary, assumptions, questions, actions, bpmnXml.',
  'summary: short reasoning summary in plain language (no chain-of-thought).',
  'assumptions/questions/actions: arrays of strings.',
  'If clarification is needed, return questions and leave bpmnXml empty.',
  'If bpmnXml is provided, it must be valid BPMN 2.0 XML only.',
  'Return JSON only, no additional text.'
].join(' ');

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 1400;

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function normalizeOptions(body = {}) {
  const temperature = clampNumber(body.temperature, 0, 2, DEFAULT_TEMPERATURE);
  const maxTokens = clampNumber(body.maxTokens, 128, 8192, DEFAULT_MAX_TOKENS);
  const systemPrompt = typeof body.systemPrompt === 'string' && body.systemPrompt.trim()
    ? body.systemPrompt.trim()
    : SYSTEM_PROMPT;

  return {
    temperature,
    maxTokens,
    systemPrompt
  };
}

function sendJson(res, statusCode, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function getOllamaModels() {
  try {
    const resp = await fetchWithTimeout(`${OLLAMA_URL}/api/tags`, { method: 'GET' }, 3000);
    if (!resp.ok) {
      return [];
    }
    const data = await resp.json();
    const models = Array.isArray(data.models) ? data.models.map((model) => model.name) : [];
    return models;
  } catch (err) {
    return [];
  }
}

function extractXml(text) {
  if (!text) {
    return '';
  }
  let trimmed = text.trim();

  const fenced = trimmed.match(/```(?:xml)?([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    trimmed = fenced[1].trim();
  }

  const start = trimmed.indexOf('<definitions');
  const end = trimmed.lastIndexOf('</definitions>');
  if (start >= 0 && end >= 0) {
    return trimmed.slice(start, end + '</definitions>'.length);
  }

  return trimmed;
}

function extractJson(text) {
  if (!text) {
    return null;
  }
  let trimmed = text.trim();

  const fenced = trimmed.match(/```(?:json)?([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    trimmed = fenced[1].trim();
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end >= start) {
    const candidate = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch (err) {
      return null;
    }
  }

  return null;
}

function buildUserPrompt(prompt) {
  return `User request: ${prompt}\n\nReturn only BPMN 2.0 XML.`;
}

function buildConversationPrompt(messages = []) {
  return messages.map((message) => {
    const role = (message.role || 'user').toUpperCase();
    const content = message.content || '';
    return `${role}: ${content}`;
  }).join('\n');
}

async function generateOpenAI({ model, prompt, credential, systemPrompt, temperature, maxTokens }) {
  const apiKey = credential || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY or credential.');
  }

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildUserPrompt(prompt) }
      ],
      temperature,
      max_tokens: maxTokens
    })
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error?.message || 'OpenAI request failed.');
  }

  return data.choices?.[0]?.message?.content || '';
}

async function generateAnthropic({ model, prompt, credential, systemPrompt, maxTokens }) {
  const explicitKey = credential || process.env.ANTHROPIC_API_KEY || '';
  const explicitToken = credential || process.env.ANTHROPIC_AUTH_TOKEN || '';

  const useApiKey = explicitKey.startsWith('sk-ant-') || !!process.env.ANTHROPIC_API_KEY;
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01'
  };

  if (useApiKey && explicitKey) {
    headers['x-api-key'] = explicitKey;
  } else if (explicitToken) {
    headers['Authorization'] = `Bearer ${explicitToken}`;
  } else {
    throw new Error('Missing ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN or credential.');
  }

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [
        { role: 'user', content: buildUserPrompt(prompt) }
      ]
    })
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error?.message || 'Anthropic request failed.');
  }

  return data.content?.[0]?.text || '';
}

async function generateGemini({ model, prompt, credential, systemPrompt, temperature }) {
  const apiKey = credential || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY or credential.');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: buildUserPrompt(prompt) }]
        }
      ],
      generationConfig: {
        temperature
      }
    })
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error?.message || 'Gemini request failed.');
  }

  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function generateOllama({ model, prompt, systemPrompt, temperature }) {
  const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: `${systemPrompt}\n\n${buildUserPrompt(prompt)}`,
      stream: false,
      options: {
        temperature
      }
    })
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error || 'Ollama request failed.');
  }

  return data.response || '';
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/providers') {
    const ollamaModels = await getOllamaModels();

    sendJson(res, 200, {
      sources: modelCatalog.sources,
      providers: {
        openai: {
          label: 'OpenAI',
          available: !!process.env.OPENAI_API_KEY,
          models: modelCatalog.openai
        },
        anthropic: {
          label: 'Claude (Anthropic)',
          available: !!process.env.ANTHROPIC_API_KEY || !!process.env.ANTHROPIC_AUTH_TOKEN,
          models: modelCatalog.anthropic,
          authHint: 'API key or Claude Code token'
        },
        gemini: {
          label: 'Gemini',
          available: !!process.env.GEMINI_API_KEY,
          models: modelCatalog.gemini
        },
        ollama: {
          label: 'Ollama (Local)',
          available: ollamaModels.length > 0,
          models: ollamaModels,
          suggestedModels: modelCatalog.ollamaSuggested
        }
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/generate') {
    try {
      const body = await readJsonBody(req);
      const provider = body.provider;
      const model = body.model;
      const prompt = body.prompt;
      const credential = body.credential;
      const options = normalizeOptions(body);

      if (!provider || !model || !prompt) {
        sendJson(res, 400, { error: 'provider, model, and prompt are required.' });
        return;
      }

      let raw = '';
      if (provider === 'openai') {
        raw = await generateOpenAI({ model, prompt, credential, ...options });
      } else if (provider === 'anthropic') {
        raw = await generateAnthropic({ model, prompt, credential, ...options });
      } else if (provider === 'gemini') {
        raw = await generateGemini({ model, prompt, credential, ...options });
      } else if (provider === 'ollama') {
        raw = await generateOllama({ model, prompt, ...options });
      } else {
        sendJson(res, 400, { error: `Unknown provider: ${provider}` });
        return;
      }

      sendJson(res, 200, { xml: extractXml(raw) });
    } catch (err) {
      sendJson(res, 500, { error: err.message || 'Generation failed.' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    try {
      const body = await readJsonBody(req);
      const provider = body.provider;
      const model = body.model;
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const credential = body.credential;
      const options = normalizeOptions(body);

      if (!provider || !model || !messages.length) {
        sendJson(res, 400, { error: 'provider, model, and messages are required.' });
        return;
      }

      const systemPrompt = `${options.systemPrompt}\n\n${CHAT_FORMAT_PROMPT}`;
      const prompt = buildConversationPrompt(messages);

      let raw = '';
      if (provider === 'openai') {
        raw = await generateOpenAI({ model, prompt, credential, systemPrompt, ...options });
      } else if (provider === 'anthropic') {
        raw = await generateAnthropic({ model, prompt, credential, systemPrompt, ...options });
      } else if (provider === 'gemini') {
        raw = await generateGemini({ model, prompt, credential, systemPrompt, ...options });
      } else if (provider === 'ollama') {
        raw = await generateOllama({ model, prompt, systemPrompt, ...options });
      } else {
        sendJson(res, 400, { error: `Unknown provider: ${provider}` });
        return;
      }

      const parsed = extractJson(raw);
      if (!parsed) {
        sendJson(res, 500, { error: 'AI response was not valid JSON.' });
        return;
      }

      const response = {
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
        questions: Array.isArray(parsed.questions) ? parsed.questions : [],
        actions: Array.isArray(parsed.actions) ? parsed.actions : [],
        bpmnXml: typeof parsed.bpmnXml === 'string' ? extractXml(parsed.bpmnXml) : ''
      };

      sendJson(res, 200, response);
    } catch (err) {
      sendJson(res, 500, { error: err.message || 'Chat request failed.' });
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`AI server listening on http://localhost:${PORT}`);
});
