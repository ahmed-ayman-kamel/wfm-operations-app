/**
 * Assistant.gs
 * Server side of the AI Assistant in the Personal Assistant section. Client side: Assistant_HTML.html (an .html file cannot share the base name of a .gs file).
 *
 * WHAT THIS FILE DOES
 *   - Keeps an ordered list of AI providers ("API #1, API #2, ...") in Script Properties.
 *     Admins edit it in the app (gear icon in the AI Assistant); no code change is needed to add,
 *     replace, reorder or disable a provider. API keys never leave the server.
 *   - Answers a chat message by trying the providers IN ORDER and stopping at the first success
 *     (AI_complete_). API #2 is only called when API #1 could not answer, and so on.
 *   - Remembers for a short time that a provider failed in a way that will repeat (rate limit, quota,
 *     bad key, outage), so the next messages go straight to the next provider instead of waiting on
 *     a provider that is known to be down. When that pause ends, API #1 is used again first.
 *
 * PROVIDER TYPES (the request format; add a new one in AI_ADAPTERS_)
 *   openai             OpenAI Chat Completions            default endpoint https://api.openai.com/v1/chat/completions
 *   anthropic          Anthropic Messages API             default endpoint https://api.anthropic.com/v1/messages
 *   gemini             Google Gemini generateContent      default endpoint .../v1beta/models/<model>:generateContent
 *   openai_compatible  any OpenAI-style API (OpenRouter, Groq, DeepSeek, Mistral, Together, Azure OpenAI...)
 *                      endpoint required. Azure endpoints (*.azure.com) get the key in the "api-key" header,
 *                      which both the classic deployment URLs and the /openai/v1/ URLs accept.
 *
 * CONVERSATION CONTEXT
 * The browser keeps the conversation (in memory and in that browser's local storage) and sends the
 * recent messages with every question; this server keeps no chat history at all. That is the
 * simplest design for Apps Script (no database, nothing per user to clean up) and each request is
 * self-contained, which is also what makes switching provider mid-conversation seamless.
 *
 * SECURITY NOTE (read with WFM_App_Documentation.md 3.7 and 5.8)
 * Keys are in Script Properties, never in the page. Because the web app runs as each user, every
 * person in Roles is an Editor of the spreadsheet, and spreadsheet Editors can open the Apps Script
 * editor and see Script Properties. Use keys with a spending limit.
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const AI_CONFIG = {
  PROVIDERS_PROP: 'WFM_AI_PROVIDERS',     // Script Property holding the JSON list of providers
  MAX_PROVIDERS: 10,
  MAX_MESSAGES: 24,                       // recent messages sent as context
  MAX_MESSAGE_CHARS: 8000,                // per message
  MAX_CONTEXT_CHARS: 32000,               // all messages together
  MAX_OUTPUT_TOKENS: 4096,   // a ceiling, not a target: reasoning models (OpenAI o/gpt-5, Gemini 2.5) spend part of it thinking
  RATE_LIMIT_PER_HOUR: 60,                // per person, protects the shared quota
  MAX_TODOS_IN_CONTEXT: 60,
  // How long a provider is skipped after a failure of each kind (seconds).
  // Only set AFTER the retries below have failed. "unavailable" is short because an overloaded
  // model (Gemini 503) usually recovers within seconds.
  COOLDOWN_SEC: { rate_limit: 60, unavailable: 30, quota: 3600, auth: 3600, config: 1800 },
  // Retries on the SAME provider for temporary failures (HTTP 500, 502, 503, 504, a short 429, a
  // dropped connection), with exponential backoff and jitter, before moving to the next provider.
  // Waits: about 0.5-1 s, 1-2 s, 2-4 s. BUDGET_MS caps the total time one question may spend
  // retrying (across all providers), so a person never waits minutes.
  // QUICK_ATTEMPTS is used instead when another healthy provider is next in line: failing over to a
  // different model is faster than waiting on an overloaded one. The last provider gets MAX_ATTEMPTS.
  // HARD_STOP_MS: no further provider is started after this long. 65 s so that one provider hanging
  // until Google's fetch timeout (about 60 s) can still be followed by the next one, while two hanging
  // providers in a row stay bounded at about 2 minutes.
  RETRY: { MAX_ATTEMPTS: 4, QUICK_ATTEMPTS: 2, BASE_MS: 1000, MAX_DELAY_MS: 8000, RETRY_AFTER_MAX_MS: 10000, BUDGET_MS: 45000, HARD_STOP_MS: 65000, FAST_NETWORK_ERROR_MS: 10000,
    QUICK_SKIP_IF_SLOWER_MS: 5000, QUICK_SKIP_IF_RETRY_AFTER_MS: 2000 },
  // While a provider keeps failing, each pause doubles (30 s, 1, 2, 4, 8 min) up to this cap, and after
  // a pause it gets one probe try. One success resets it. Failures older than STRIKE_TTL_SEC are forgotten.
  COOLDOWN_MAX_SEC: 600,
  STRIKE_TTL_SEC: 3600,
  BUSY_TTL_SEC: 150,                      // a person's question in flight (guard against double sends)
  STATUS_TTL_SEC: 6 * 3600                // how long the admin screen remembers each provider's last result
};

const AI_TYPES_ = {
  openai: { label: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', modelHint: 'for example gpt-4o-mini' },
  anthropic: { label: 'Anthropic (Claude)', endpoint: 'https://api.anthropic.com/v1/messages', modelHint: 'for example claude-haiku-4-5' },
  gemini: { label: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent', modelHint: 'for example gemini-2.5-flash' },
  openai_compatible: { label: 'OpenAI-compatible (OpenRouter, Groq, DeepSeek, ...)', endpoint: '', modelHint: 'the model name your provider uses' }
};

// ============================================================================
// PROVIDER STORE (Script Properties)
// ============================================================================

function AI_loadProviders_() {
  const raw = PropertiesService.getScriptProperties().getProperty(AI_CONFIG.PROVIDERS_PROP);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.error('[AI] The ' + AI_CONFIG.PROVIDERS_PROP + ' Script Property is not valid JSON; no provider can be used until it is saved again.');
    return [];
  }
}

function AI_saveProviders_(list) {
  PropertiesService.getScriptProperties().setProperty(AI_CONFIG.PROVIDERS_PROP, JSON.stringify(list));
}

function AI_keyHint_(key) {
  const k = String(key || '');
  return k ? '\u2022\u2022\u2022\u2022' + k.slice(-4) : '';
}

/** Removes a key (and its obvious variants) from any text before it is logged or shown. */
function AI_redact_(text, providers) {
  let s = String(text == null ? '' : text);
  (providers || []).forEach(function (p) {
    if (p && p.apiKey && p.apiKey.length >= 6) s = s.split(p.apiKey).join('[key]');
  });
  return s.replace(/(sk-[A-Za-z0-9_\-]{6})[A-Za-z0-9_\-]+/g, '$1...').replace(/(AIza[A-Za-z0-9_\-]{4})[A-Za-z0-9_\-]+/g, '$1...');
}

function AI_validateProvider_(p, index) {
  const where = 'Provider #' + (index + 1) + (p.name ? ' ("' + p.name + '")' : '');
  if (!AI_TYPES_[p.type]) throw new Error(where + ': choose a provider type.');
  if (!p.name) throw new Error(where + ': give it a name, for example "API #' + (index + 1) + '".');
  if (p.name.length > 40) throw new Error(where + ': the name is too long (max 40 characters).');
  if (!p.model) throw new Error(where + ': enter the model name (' + AI_TYPES_[p.type].modelHint + ').');
  if (!/^[A-Za-z0-9._:\/\-@]+$/.test(p.model) || p.model.length > 120) throw new Error(where + ': the model name has characters that are not allowed.');
  if (p.endpoint && !/^https:\/\/[^\s]+$/.test(p.endpoint)) throw new Error(where + ': the endpoint must be an https:// address.');
  if (p.endpoint.length > 300) throw new Error(where + ': the endpoint is too long (max 300 characters).');
  if (p.type === 'openai_compatible' && !p.endpoint) throw new Error(where + ': an OpenAI-compatible provider needs its endpoint (the .../chat/completions address).');
  if (p.enabled && !p.apiKey) throw new Error(where + ': enter its API key, or switch it off.');
  if (p.apiKey && (p.apiKey.length > 400 || /\s/.test(p.apiKey))) throw new Error(where + ': the API key does not look right (it has spaces or is too long).');
}

// ============================================================================
// COOLDOWNS AND LAST RESULT (Script Cache: shared by everyone, expires by itself)
// ============================================================================

function AI_cooldownKey_(id) { return 'WFM_AI_COOL_' + id; }
function AI_statusKey_(id) { return 'WFM_AI_LAST_' + id; }

function AI_getCooldown_(id) {
  try {
    const raw = CacheService.getScriptCache().get(AI_cooldownKey_(id));
    if (!raw) return null;
    const c = JSON.parse(raw);
    return c.until > Date.now() ? c : null;
  } catch (e) { return null; }
}

function AI_setCooldown_(id, kind, seconds) {
  if (!seconds) return;
  try {
    const sec = Math.max(1, Math.min(21600, Math.round(seconds)));
    CacheService.getScriptCache().put(AI_cooldownKey_(id), JSON.stringify({ kind: kind, until: Date.now() + sec * 1000 }), sec);
  } catch (e) {}
}

function AI_clearCooldown_(id) {
  try { CacheService.getScriptCache().remove(AI_cooldownKey_(id)); } catch (e) {}
}

function AI_recordStatus_(id, status) {
  try { CacheService.getScriptCache().put(AI_statusKey_(id), JSON.stringify(status), AI_CONFIG.STATUS_TTL_SEC); } catch (e) {}
}

function AI_readStatus_(id) {
  try { const raw = CacheService.getScriptCache().get(AI_statusKey_(id)); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}

function AI_cacheGet_(key) {
  try { return CacheService.getScriptCache().get(key); } catch (e) { return null; }
}

// Consecutive failures of a provider ("strikes"): they make its pause grow and turn the try after a
// pause into a single probe. One success clears them.
function AI_strikesKey_(id) { return 'WFM_AI_STRIKES_' + id; }
function AI_getStrikes_(id) { return Number(AI_cacheGet_(AI_strikesKey_(id)) || 0) || 0; }
function AI_addStrike_(id) {
  const n = AI_getStrikes_(id) + 1;
  try { CacheService.getScriptCache().put(AI_strikesKey_(id), String(n), AI_CONFIG.STRIKE_TTL_SEC); } catch (e) {}
  return n;
}
function AI_clearStrikes_(id) {
  try { CacheService.getScriptCache().remove(AI_strikesKey_(id)); } catch (e) {}
}
/** Pause after the n-th failure in a row: doubles for temporary kinds (outage, rate limit), capped. */
function AI_escalatedCooldown_(kind, baseSec, strikes) {
  if (kind !== 'unavailable' && kind !== 'rate_limit') return baseSec;     // quota, key, model: already long
  const grown = Math.round(baseSec * Math.pow(2, Math.max(0, strikes - 1)));
  return Math.max(baseSec, Math.min(AI_CONFIG.COOLDOWN_MAX_SEC, grown));    // never shorter than asked
}

/** What the settings screen shows about a provider's health (no secrets). */
function AI_providerState_(id, p) {
  const cool = AI_getCooldown_(id);
  return {
    last: AI_readStatus_(id),
    pausedUntil: cool ? new Date(cool.until).toISOString() : '',
    pausedKind: cool ? cool.kind : '',
    strikes: AI_getStrikes_(id),
    thinkingSkipped: !!(p && p.type === 'gemini' && AI_cacheGet_(AI_noThinkKey_(p)))
  };
}

/**
 * Gemini "thinking": the model reasons before it answers. Google's default for Gemini 3.7 and 3.8
 * Flash is "medium"; "low" answers much sooner and is plenty for this chat (Google: "Low thinking
 * effort: Reduces time-to-answer for latency-critical tasks"). "minimal" is NOT accepted by 3.7/3.8
 * Flash, so "low" is used. Gemini 2.5 takes a token budget instead. Flash-Lite already thinks
 * minimally by default, so it is left alone, as are aliases such as gemini-flash-latest.
 * If a model rejects the setting anyway (HTTP 400 mentioning thinking), the request is sent again
 * without it and that is remembered for 6 hours (AI_callProvider_), so this can never break a provider.
 */
function AI_geminiThinking_(model) {
  const m = String(model || '').toLowerCase();
  if (/flash-lite|-lite\b/.test(m)) return null;
  const v = /^gemini-(\d+)(?:\.(\d+))?/.exec(m);
  if (!v) return null;
  const major = Number(v[1]), minor = Number(v[2] || 0);
  if (major >= 3) return { thinkingLevel: 'low' };
  if (major === 2 && minor >= 5) return { thinkingBudget: 512 };
  return null;
}
function AI_noThinkKey_(p) { return 'WFM_AI_NOTHINK_' + p.id + ':' + p.model; }
// Only a 400 that names the thinking setting itself (not any text that happens to contain "thinking").
const AI_THINKING_REJECTED_RE_ = /thinking[_ ]?(level|budget|config)|thinking is not supported/i;

// ============================================================================
// PROVIDER ADAPTERS (request format + reply parsing, one per type)
// ============================================================================

/** Anthropic and Gemini need strictly alternating turns that start with the user. */
function AI_alternate_(messages) {
  const out = [];
  messages.forEach(function (m) {
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += '\n\n' + m.content;
    else out.push({ role: m.role, content: m.content });
  });
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

const AI_ADAPTERS_ = {
  openai: function (p, system, messages, maxTokens) {
    return {
      url: p.endpoint || AI_TYPES_.openai.endpoint,
      headers: { Authorization: 'Bearer ' + p.apiKey },
      // max_completion_tokens is what current OpenAI models accept; temperature is left at the
      // provider default because reasoning models reject any other value.
      payload: { model: p.model, messages: [{ role: 'system', content: system }].concat(messages), max_completion_tokens: maxTokens },
      parse: AI_parseOpenAi_,
      usage: AI_usageOpenAi_
    };
  },
  openai_compatible: function (p, system, messages, maxTokens) {
    const azure = /^https:\/\/[^\/]+\.azure\.com\//i.test(p.endpoint);
    return {
      url: p.endpoint,
      headers: azure ? { 'api-key': p.apiKey } : { Authorization: 'Bearer ' + p.apiKey },
      payload: { model: p.model, messages: [{ role: 'system', content: system }].concat(messages), max_tokens: maxTokens },
      parse: AI_parseOpenAi_,
      usage: AI_usageOpenAi_
    };
  },
  anthropic: function (p, system, messages, maxTokens) {
    return {
      url: p.endpoint || AI_TYPES_.anthropic.endpoint,
      headers: { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' },
      payload: { model: p.model, max_tokens: maxTokens, system: system, messages: AI_alternate_(messages) },
      parse: function (json) {
        const parts = (json && json.content) || [];
        return parts.filter(function (c) { return c && c.type === 'text'; }).map(function (c) { return c.text; }).join('').trim();
      },
      usage: function (json) {
        const u = json && json.usage;
        return u ? { in: u.input_tokens || 0, out: u.output_tokens || 0, think: 0 } : null;
      }
    };
  },
  gemini: function (p, system, messages, maxTokens, opts) {
    const url = p.endpoint
      ? p.endpoint.replace('{model}', encodeURIComponent(p.model))
      : AI_TYPES_.gemini.endpoint.replace('{model}', encodeURIComponent(p.model));
    // Google: this limit includes thinking tokens. Without the "low" setting a model may think at its
    // default level (medium or more), so it gets a bigger allowance, or it could run out before answering.
    const gen = { maxOutputTokens: opts && opts.thinking ? maxTokens : Math.max(maxTokens, 8192) };
    if (opts && opts.thinking) gen.thinkingConfig = opts.thinking;
    return {
      url: url,
      headers: { 'x-goog-api-key': p.apiKey },   // in a header, never in the URL, so it cannot leak into error text
      payload: {
        systemInstruction: { parts: [{ text: system }] },
        contents: AI_alternate_(messages).map(function (m) { return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }; }),
        generationConfig: gen
      },
      usage: function (json) {
        const u = json && json.usageMetadata;
        return u ? { in: u.promptTokenCount || 0, out: u.candidatesTokenCount || 0, think: u.thoughtsTokenCount || 0 } : null;
      },
      parse: function (json) {
        const c = json && json.candidates && json.candidates[0];
        const parts = (c && c.content && c.content.parts) || [];
        // Parts marked "thought" are the model's internal reasoning, not the answer.
        return parts.filter(function (x) { return x && !x.thought; }).map(function (x) { return x.text || ''; }).join('').trim();
      },
      // Why a 200 response had no text: blocked prompt, safety stop, or the whole allowance spent thinking.
      emptyReason: function (json) {
        const c = json && json.candidates && json.candidates[0];
        if (json && json.promptFeedback && json.promptFeedback.blockReason) return 'prompt blocked: ' + json.promptFeedback.blockReason;
        if (c && c.finishReason) return 'finishReason ' + c.finishReason + (c.finishReason === 'MAX_TOKENS' ? ' (the output allowance was used up, often by thinking)' : '');
        return 'no candidates';
      }
    };
  }
};

/**
 * The provider's own error text, for logs and for Admins (never for other users). Understands the
 * error shapes of Gemini ({error:{code,status,message}}), OpenAI and Anthropic ({error:{type,message}}).
 * Keys are removed and the text is shortened.
 */
function AI_providerMessage_(body, providers) {
  let msg = '';
  try {
    const j = JSON.parse(body);
    const e = (j && j.error) || (Array.isArray(j) && j[0] && j[0].error) || null;
    if (e) msg = [e.status || e.type || e.code || '', e.message || ''].filter(String).join(': ');
  } catch (x) {
    msg = String(body || '').replace(/<[^>]*>/g, ' ');
  }
  return AI_redact_(msg.replace(/\s+/g, ' ').trim(), providers).slice(0, 200);
}

function AI_usageOpenAi_(json) {
  const u = json && json.usage;
  if (!u) return null;
  const d = u.completion_tokens_details || {};
  return { in: u.prompt_tokens || 0, out: u.completion_tokens || 0, think: d.reasoning_tokens || 0 };
}

function AI_parseOpenAi_(json) {
  const msg = json && json.choices && json.choices[0] && json.choices[0].message;
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content.trim();
  if (Array.isArray(msg.content)) return msg.content.map(function (x) { return x.text || ''; }).join('').trim();
  return '';
}

// ============================================================================
// FAILURE CLASSIFICATION
// ============================================================================

/**
 * Decides what a failed call means, so the right thing happens next:
 *   kind        what the UI/admin sees         cooldown?   next provider?
 *   rate_limit  too many requests right now    short       yes
 *   quota       quota/credit used up           1 hour      yes
 *   auth        key invalid or not allowed     1 hour      yes
 *   config      model/endpoint not found       30 min      yes
 *   unavailable outage, timeout, 5xx, network  short       yes
 *   bad_request this request was refused       none        yes (another provider may accept it)
 *   empty       no text came back              none        yes
 * Every failure moves on to the next provider; the cooldown only decides whether the NEXT message
 * should skip this provider for a while.
 */
function AI_classify_(code, bodyText, headers) {
  const body = String(bodyText || '').toLowerCase();
  const quotaWords = /insufficient_quota|exceeded your current quota|quota|billing|credit|resource_exhausted|payment/;
  if (code === 429) {
    if (quotaWords.test(body) && !/rate.?limit|per minute|requests per|tokens per min/.test(body)) {
      return { kind: 'quota', cooldown: AI_CONFIG.COOLDOWN_SEC.quota };
    }
    let retry = 0;
    const h = headers || {};
    const ra = h['Retry-After'] || h['retry-after'];
    if (ra && !isNaN(Number(ra))) retry = Number(ra);
    return { kind: 'rate_limit', cooldown: Math.min(600, Math.max(retry, AI_CONFIG.COOLDOWN_SEC.rate_limit)) };
  }
  if (code === 402) return { kind: 'quota', cooldown: AI_CONFIG.COOLDOWN_SEC.quota };
  if (code === 401) return { kind: 'auth', cooldown: AI_CONFIG.COOLDOWN_SEC.auth };
  if (code === 403) return quotaWords.test(body) ? { kind: 'quota', cooldown: AI_CONFIG.COOLDOWN_SEC.quota } : { kind: 'auth', cooldown: AI_CONFIG.COOLDOWN_SEC.auth };
  if (code === 404) return { kind: 'config', cooldown: AI_CONFIG.COOLDOWN_SEC.config };
  if (code === 408 || code >= 500) return { kind: 'unavailable', cooldown: AI_CONFIG.COOLDOWN_SEC.unavailable };
  if (code === 400 || code === 422) {
    // Some providers report used-up credit or a bad key as 400 (for example Anthropic: "Your credit
    // balance is too low", Gemini: "API key not valid"). Anything else is a refusal of this one
    // request (for example a conversation that is too long): no pause, the next provider is tried.
    if (/credit balance|insufficient_quota|exceeded your current quota|billing|payment required|out of credits/.test(body)) return { kind: 'quota', cooldown: AI_CONFIG.COOLDOWN_SEC.quota };
    if (/api.?key/.test(body) && /invalid|not valid|incorrect|missing|expired/.test(body) || /authentication_error|invalid x-api-key/.test(body)) return { kind: 'auth', cooldown: AI_CONFIG.COOLDOWN_SEC.auth };
    if (/model_not_found|unknown model|invalid model|no such model|model\b[^"]{0,80}\b(not found|does not exist|is not supported|not available)/.test(body)) return { kind: 'config', cooldown: AI_CONFIG.COOLDOWN_SEC.config };
  }
  return { kind: 'bad_request', cooldown: 0 };
}

const AI_KIND_TEXT_ = {
  rate_limit: 'rate limited', quota: 'quota or credit used up', auth: 'API key rejected', config: 'model or endpoint not found',
  unavailable: 'service unavailable', bad_request: 'request refused', empty: 'empty reply', permission: 'app permission missing'
};

// ============================================================================
// ONE CALL, AND THE FAILOVER CHAIN
// ============================================================================

/** Calls one provider once. Returns { ok, text, ms, usage } or { ok:false, kind, cooldown, code, detail, ... }. */
function AI_callProvider_(p, system, messages, maxTokens) {
  const adapter = AI_ADAPTERS_[p.type];
  if (!adapter) return { ok: false, kind: 'config', cooldown: 0, code: 0, detail: 'unknown provider type' };
  const wanted = p.type === 'gemini' && p.thinking !== 'default' ? AI_geminiThinking_(p.model) : null;
  let thinking = wanted && !AI_cacheGet_(AI_noThinkKey_(p)) ? wanted : null;
  let req = adapter(p, system, messages, maxTokens, { thinking: thinking });
  const started = Date.now();
  let got = AI_fetch_(req);
  // A model that does not accept the thinking setting answers 400 naming it: send the same request
  // once more without it, and remember that for this provider and model (6 hours).
  if (thinking && got.response && got.response.getResponseCode() === 400 && AI_THINKING_REJECTED_RE_.test(got.response.getContentText())) {
    const said = AI_providerMessage_(got.response.getContentText(), [p]);
    const rejected = thinking;
    thinking = null;
    req = adapter(p, system, messages, maxTokens, { thinking: null });
    got = AI_fetch_(req);
    // Remembered only if the request really works without it (so an unrelated 400 changes nothing).
    const worked = !!got.response && got.response.getResponseCode() >= 200 && got.response.getResponseCode() < 300;
    if (worked) { try { CacheService.getScriptCache().put(AI_noThinkKey_(p), '1', 21600); } catch (e) {} }
    console.warn('[AI] "' + p.name + '" ' + p.type + '/' + p.model + ' does not accept the thinking setting ' + JSON.stringify(rejected) +
      '; sent again without it' + (worked ? ' (remembered for 6 hours)' : '') + '. Provider said: "' + said + '"');
  }
  const thinkingText = thinking ? (thinking.thinkingLevel ? 'thinking ' + thinking.thinkingLevel : 'thinking budget ' + thinking.thinkingBudget) : '';
  if (got.error) {
    const e = got.error;
    const took = Date.now() - started;
    if (isPermissionError_(e)) return { ok: false, kind: 'permission', cooldown: 0, code: 0, detail: 'UrlFetchApp permission', ms: took };
    // A connection dropped quickly is worth retrying; a timeout (Google gives up after about a
    // minute) is not, because a retry would keep the person waiting another minute.
    return { ok: false, kind: 'unavailable', cooldown: AI_CONFIG.COOLDOWN_SEC.unavailable, code: 0, ms: took,
      retryable: took < AI_CONFIG.RETRY.FAST_NETWORK_ERROR_MS, detail: 'network: ' + String(e && e.message || e).slice(0, 200) };
  }
  const res = got.response;
  const ms = Date.now() - started;
  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code >= 200 && code < 300) {
    let text = '', json = null;
    try { json = JSON.parse(body); text = req.parse(json); } catch (e) { text = ''; }
    let usage = null;
    try { usage = json && req.usage ? req.usage(json) : null; } catch (e) { usage = null; }
    if (text) return { ok: true, text: text, ms: ms, code: code, usage: usage, thinking: thinkingText };
    const why = json && req.emptyReason ? req.emptyReason(json) : 'no text in the answer';
    // Running out of allowance repeats on every question, so that provider is skipped for a minute.
    return { ok: false, kind: 'empty', cooldown: /MAX_TOKENS/.test(why) ? 60 : 0, code: code, detail: why, message: why, ms: ms, usage: usage };
  }
  let headers = {};
  try { headers = res.getAllHeaders() || {}; } catch (e) {}
  const c = AI_classify_(code, body, headers);
  const retryAfterMs = AI_retryAfterMs_(headers);
  // Temporary failures are retried on the same provider: 500, 502, 503, 504, and a 429 that is a
  // short rate limit (not used-up quota, and not a long Retry-After).
  const retryable = [500, 502, 503, 504].indexOf(code) !== -1 ||
    (code === 429 && c.kind === 'rate_limit' && (!retryAfterMs || retryAfterMs <= AI_CONFIG.RETRY.RETRY_AFTER_MAX_MS));
  return { ok: false, kind: c.kind, cooldown: c.cooldown, code: code, ms: ms, retryable: retryable, retryAfterMs: retryAfterMs,
    message: AI_providerMessage_(body, [p]), detail: body.slice(0, 300) };
}

function AI_fetch_(req) {
  try {
    return { response: UrlFetchApp.fetch(req.url, {
      method: 'post',
      contentType: 'application/json',
      headers: req.headers,
      payload: JSON.stringify(req.payload),
      muteHttpExceptions: true,
      followRedirects: false   // never resend the key to wherever a redirect points
    }) };
  } catch (e) {
    return { error: e };
  }
}

function AI_retryAfterMs_(headers) {
  const h = headers || {};
  const ra = h['Retry-After'] || h['retry-after'];
  if (ra === undefined || ra === null || ra === '') return 0;
  if (!isNaN(Number(ra))) return Math.max(0, Number(ra) * 1000);
  const when = Date.parse(String(ra));                     // HTTP-date form
  return isNaN(when) ? 0 : Math.max(0, when - Date.now());
}

/** Exponential backoff with jitter: half of the step fixed, half random (never zero, never in lockstep). */
function AI_backoffMs_(retryNumber, retryAfterMs) {
  const R = AI_CONFIG.RETRY;
  const step = Math.min(R.MAX_DELAY_MS, R.BASE_MS * Math.pow(2, retryNumber - 1));
  const wait = Math.round(step / 2 + Math.random() * step / 2);
  return Math.min(R.MAX_DELAY_MS, Math.max(wait, retryAfterMs || 0));
}

/**
 * One provider, with retries for temporary failures. Returns the last attempt's result plus
 * { tries, slept }. ctx = { id, started, providers } for logging and the overall time budget.
 * maxTries: how many tries this provider gets this time (see AI_complete_), at most RETRY.MAX_ATTEMPTS.
 */
function AI_callWithRetry_(p, system, messages, maxTokens, ctx, maxTries) {
  const R = AI_CONFIG.RETRY;
  const limit = Math.max(1, Math.min(R.MAX_ATTEMPTS, maxTries || R.MAX_ATTEMPTS));
  let r = null, slept = 0, tries = 0;
  for (let n = 1; n <= limit; n++) {
    tries = n;
    r = AI_callProvider_(p, system, messages, maxTokens);
    const where = '[AI] req ' + ctx.id + ' "' + p.name + '" ' + p.type + '/' + p.model + ' try ' + n + '/' + limit + ': ';
    if (r.ok) {
      if (n > 1) console.log(where + 'OK in ' + r.ms + ' ms (after ' + (n - 1) + ' retr' + (n === 2 ? 'y' : 'ies') + ').');
      r.tries = n; r.slept = slept;
      return r;
    }
    const what = (r.code ? 'HTTP ' + r.code : 'no response') + ', ' + r.kind + ' after ' + (r.ms || 0) + ' ms' +
      (r.message ? '. Provider said: "' + AI_redact_(r.message, ctx.providers) + '"' : (r.detail ? '. ' + AI_redact_(r.detail, ctx.providers).slice(0, 200) : ''));
    const elapsed = Date.now() - ctx.started;
    // Quick mode (another healthy provider is next): a failure that was slow, or that asks for a
    // longer wait, is not worth a retry; the next provider will answer sooner.
    const quickSkip = limit < R.MAX_ATTEMPTS && ((r.ms || 0) > R.QUICK_SKIP_IF_SLOWER_MS || (r.retryAfterMs || 0) > R.QUICK_SKIP_IF_RETRY_AFTER_MS);
    const wait = r.retryable && n < limit && !quickSkip ? AI_backoffMs_(n, r.retryAfterMs) : 0;
    if (!wait) {
      console.warn(where + what + '. ' + (!r.retryable ? 'Not a temporary error, not retried.'
        : limit === 1 ? 'One probe try after a pause; moving on.'
        : quickSkip ? 'Slow failure or long wait asked; moving on to the next provider.'
        : limit < R.MAX_ATTEMPTS ? 'Another provider is ready; moving on instead of waiting.'
        : 'No tries left.'));
      break;
    }
    if (elapsed + wait > R.BUDGET_MS) {
      console.warn(where + what + '. Time budget for this question used up (' + Math.round(elapsed / 1000) + ' s), moving on.');
      break;
    }
    console.warn(where + what + '. Retrying in ' + (wait / 1000).toFixed(1) + ' s.');
    Utilities.sleep(wait);
    slept += wait;
  }
  r.tries = tries;
  r.slept = slept;
  return r;
}

/**
 * Tries the enabled providers in order and returns the first good answer.
 *   Plan: the providers that are not paused, in order, then (only if none of them answered) the
 *         paused ones, in order, because an answer from a recently failing provider beats no answer.
 *   Tries per provider, to keep answers fast when one model is overloaded:
 *     - another healthy provider is next in line: 2 tries (1 quick retry), then move on;
 *       if the provider failed recently (it just came out of a pause): 1 probe try;
 *     - it is the last healthy provider: up to 4 tries, with backoff (just 1 if it failed recently
 *       and paused providers can still be tried after it);
 *     - a paused provider (second round): 1 try; the very last one 2 (or 4 if nothing else was tried).
 *   After its tries fail, a provider is paused; the pause doubles while it keeps failing (up to 10 min).
 * Returns { text, provider: { id, name }, attempts }. Throws { aiFailure: true, attempts } if none answered.
 */
function AI_complete_(system, messages, maxTokens) {
  const all = AI_loadProviders_();
  const providers = all.filter(function (p) { return p && p.enabled && p.apiKey && AI_TYPES_[p.type]; });
  if (!providers.length) {
    const err = new Error('AI_NOT_CONFIGURED');
    err.aiNotConfigured = true;
    throw err;
  }
  const R = AI_CONFIG.RETRY;
  const attempts = [];
  const ctx = { id: Utilities.getUuid().slice(0, 8), started: Date.now(), providers: all };

  const healthy = [], paused = [];
  providers.forEach(function (p) {
    const cool = AI_getCooldown_(p.id);
    if (cool) { paused.push(p); attempts.push({ name: p.name, ok: false, kind: cool.kind, skipped: true }); }
    else healthy.push(p);
  });
  const plan = [];
  healthy.forEach(function (p, i) {
    const nextReady = i < healthy.length - 1;
    const failing = AI_getStrikes_(p.id) > 0;
    plan.push({ p: p, tries: nextReady ? (failing ? 1 : R.QUICK_ATTEMPTS) : (failing && paused.length ? 1 : R.MAX_ATTEMPTS) });
  });
  paused.forEach(function (p, i) {
    const last = i === paused.length - 1;
    plan.push({ p: p, tries: last ? (healthy.length ? R.QUICK_ATTEMPTS : R.MAX_ATTEMPTS) : 1, secondRound: true });
  });

  const tryOne = function (step) {
    const p = step.p;
    if (step.secondRound) {        // it is being tried after all: list it once, with the real result
      for (let a = attempts.length - 1; a >= 0; a--) { if (attempts[a].skipped && attempts[a].name === p.name) attempts.splice(a, 1); }
    }
    const r = AI_callWithRetry_(p, system, messages, maxTokens || AI_CONFIG.MAX_OUTPUT_TOKENS, ctx, step.tries);
    const when = new Date().toISOString();
    if (r.ok) {
      AI_clearCooldown_(p.id);
      AI_clearStrikes_(p.id);
      AI_recordStatus_(p.id, { ok: true, at: when, ms: r.ms, tries: r.tries });
      attempts.push({ name: p.name, ok: true, ms: r.ms, tries: r.tries });
      return r;
    }
    const said = AI_redact_(r.message || '', all);
    attempts.push({ name: p.name, ok: false, kind: r.kind, code: r.code, tries: r.tries, message: said });
    AI_recordStatus_(p.id, { ok: false, at: when, kind: r.kind, code: r.code, tries: r.tries, message: said });
    // Pause only now, after its tries: one short blip no longer takes a provider out for everybody,
    // but a provider that keeps failing is paused for longer each time, so it stops costing time.
    if (r.cooldown) {
      const strikes = AI_addStrike_(p.id);
      const pause = AI_escalatedCooldown_(r.kind, r.cooldown, strikes);
      AI_setCooldown_(p.id, r.kind, pause);
      console.warn('[AI] req ' + ctx.id + ' "' + p.name + '" paused for ' + pause + ' s (' + r.kind + (strikes > 1 ? ', failure ' + strikes + ' in a row' : '') + ').');
    }
    return null;
  };

  const done = function (r, p) {
    const calls = attempts.reduce(function (n, a) { return n + (a.tries || 0); }, 0);
    const failed = attempts.filter(function (a) { return !a.ok && !a.skipped; });
    const u = r.usage;
    console.log('[AI] req ' + ctx.id + ' answered by "' + p.name + '" (' + p.type + '/' + p.model + (r.thinking ? ', ' + r.thinking : '') + ') in ' +
      ((Date.now() - ctx.started) / 1000).toFixed(1) + ' s: ' + calls + ' call' + (calls === 1 ? '' : 's') + ', the answer itself took ' + (r.ms / 1000).toFixed(1) + ' s' +
      (u ? ', tokens in ' + u.in + ' / out ' + u.out + (u.think ? ' / thinking ' + u.think : '') : '') +
      (failed.length ? '; before it: ' + failed.map(function (a) { return a.name + ' ' + (a.code ? 'HTTP ' + a.code : a.kind) + ' x' + a.tries; }).join(', ') : '') + '.');
    return { text: r.text, provider: { id: p.id, name: p.name }, attempts: attempts };
  };

  for (let k = 0; k < plan.length; k++) {
    if (k > 0 && Date.now() - ctx.started > R.HARD_STOP_MS) {
      console.warn('[AI] req ' + ctx.id + ' stopped after ' + Math.round((Date.now() - ctx.started) / 1000) + ' s without starting the remaining providers.');
      break;
    }
    const r = tryOne(plan[k]);
    if (r) return done(r, plan[k].p);
  }
  console.warn('[AI] req ' + ctx.id + ' no provider answered in ' + ((Date.now() - ctx.started) / 1000).toFixed(1) + ' s: ' +
    attempts.map(function (a) { return a.name + ' ' + (a.skipped ? 'paused' : (a.code ? 'HTTP ' + a.code : a.kind) + ' x' + (a.tries || 1)); }).join(', ') + '.');
  const fail = new Error('AI_ALL_FAILED');
  fail.aiFailure = true;
  fail.attempts = attempts;
  throw fail;
}

// ============================================================================
// CONVERSATION
// ============================================================================

/**
 * Cleans the conversation sent by the browser: only user/assistant text, each message capped,
 * the most recent messages kept within the size limits, and it must end with the user's question.
 */
function AI_sanitizeMessages_(messages) {
  if (!Array.isArray(messages)) throw new Error('Nothing to send.');
  const clean = messages
    .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim(); })
    .map(function (m) { return { role: m.role, content: m.content.trim().slice(0, AI_CONFIG.MAX_MESSAGE_CHARS) }; });
  if (!clean.length || clean[clean.length - 1].role !== 'user') throw new Error('Type a message first.');
  const kept = [];
  let chars = 0;
  for (let i = clean.length - 1; i >= 0 && kept.length < AI_CONFIG.MAX_MESSAGES; i--) {
    if (chars + clean[i].content.length > AI_CONFIG.MAX_CONTEXT_CHARS && kept.length) break;
    kept.unshift(clean[i]);
    chars += clean[i].content.length;
  }
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept;
}

function AI_systemPrompt_(user, todos) {
  const tz = (function () { try { return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(); } catch (e) { return 'UTC'; } })();
  const now = Utilities.formatDate(new Date(), tz, "EEEE d MMMM yyyy, HH:mm");
  const lines = [
    'You are the Personal Assistant inside the "WFM Operations App", an internal tool used by a workforce-management (WFM) and real-time-monitoring team. The app has a shared daily shift checklist (Morning, Mid and Overnight shifts), operational tickets (Issues, Tasks, Flags), reports, and a private personal to-do list.',
    'You are talking with ' + user.email + ' (role in the app: ' + user.role + '). Local date and time: ' + now + ' (' + tz + ').',
    'Help with planning, prioritising, writing (handover notes, emails, ticket descriptions, messages to agents), summarising, spreadsheet formulas, and WFM questions (forecasting, scheduling, service level, adherence, occupancy, shrinkage).',
    'Be concise and practical. Use short paragraphs or bullet points. Reply in the language the user writes in.',
    'Write formulas as plain text (for example: FTE = workload hours / productive hours per FTE). Do not use LaTeX or $...$ notation.',
    'You cannot see or change the shift checklist, tickets or any app data unless the user pastes it into the chat, and you cannot take actions in the app. Never claim you did something in the app.'
  ];
  if (todos) {
    if (!todos.length) {
      lines.push('The user shared their personal to-do list with you, and it is currently empty.');
    } else {
      lines.push('The user shared their personal to-do list with you (private to them). Use it when they ask about their tasks or priorities:');
      todos.slice(0, AI_CONFIG.MAX_TODOS_IN_CONTEXT).forEach(function (t) {
        lines.push('- [' + (t.completed ? 'x' : ' ') + '] ' + t.title + ' (priority: ' + t.priority + ', category: ' + t.category +
          (t.dueDate ? ', due ' + t.dueDate : '') + ')' + (t.notes ? ' Notes: ' + String(t.notes).slice(0, 200).replace(/\s+/g, ' ') : ''));
      });
      if (todos.length > AI_CONFIG.MAX_TODOS_IN_CONTEXT) lines.push('(' + (todos.length - AI_CONFIG.MAX_TODOS_IN_CONTEXT) + ' more tasks not shown.)');
    }
  }
  return lines.join('\n');
}

/** Per-person hourly limit, so one person cannot use up the team's quota. */
function AI_checkRateLimit_(email) {
  // The user lock stops two questions sent at the same moment by the same person from both reading
  // the old count. Best effort: if the lock is busy for 3 s, the check still runs.
  let lock = null;
  try { lock = LockService.getUserLock(); if (!lock.tryLock(3000)) lock = null; } catch (e) { lock = null; }
  try {
    // Refuse a second question while the first is still running (double click, a second tab).
    if (CacheService.getScriptCache().get(AI_busyKey_(email))) throw new Error('Your previous question is still being answered. Please wait for it to finish.');
    AI_countMessage_(email);
    AI_claimBusy_(email);
  } finally { if (lock) { try { lock.releaseLock(); } catch (e) {} } }
}

function AI_busyKey_(email) {
  return 'WFM_AI_BUSY_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(email).toLowerCase(), Utilities.Charset.UTF_8));
}
/** Marks this person's question as in flight. A second one (double click, second tab) is refused. */
function AI_claimBusy_(email) {
  const cache = CacheService.getScriptCache();
  const key = AI_busyKey_(email);
  if (cache.get(key)) throw new Error('Your previous question is still being answered. Please wait for it to finish.');
  cache.put(key, String(Date.now()), AI_CONFIG.BUSY_TTL_SEC);
}
function AI_releaseBusy_(email) {
  try { CacheService.getScriptCache().remove(AI_busyKey_(email)); } catch (e) {}
}

function AI_countMessage_(email) {
  const cache = CacheService.getScriptCache();
  const who = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(email).toLowerCase(), Utilities.Charset.UTF_8));
  const key = 'WFM_AI_RATE_' + who + '_' + Math.floor(Date.now() / 3600000);
  const n = Number(cache.get(key) || 0);
  if (n >= AI_CONFIG.RATE_LIMIT_PER_HOUR) {
    throw new Error('You have reached the limit of ' + AI_CONFIG.RATE_LIMIT_PER_HOUR + ' AI messages per hour. Please try again a little later.');
  }
  cache.put(key, String(n + 1), 3700);
}

// ============================================================================
// PUBLIC: CHAT
// ============================================================================

/** What the chat panel needs to know when it opens. */
function getAssistantStatus() {
  const user = requireRegistered_();
  const ready = AI_loadProviders_().filter(function (p) { return p && p.enabled && p.apiKey && AI_TYPES_[p.type]; }).length;
  return { configured: ready > 0, providerCount: ready, isAdmin: user.isAdmin, rateLimitPerHour: AI_CONFIG.RATE_LIMIT_PER_HOUR };
}

/**
 * Answers the last user message of `messages` ([{ role: 'user'|'assistant', content }]).
 * options.includeTodos: add the person's own to-do list to the context.
 * Returns { reply, via? } (via: provider name, for Admins only). Errors are plain sentences.
 */
function askAssistant(messages, options) {
  const user = requireRegistered_();
  const convo = AI_sanitizeMessages_(messages);
  AI_checkRateLimit_(user.email);   // also marks this person's question as in flight

  try {
    let todos = null;
    const apiMode = (typeof API_REQUEST_EMAIL_ !== 'undefined' && !!API_REQUEST_EMAIL_);
    if (options && options.includeTodos === true && apiMode) {
      // Backend API: My To-Do lives in the front app; the page sends the person's own list with the question.
      if (Array.isArray(options.todos)) todos = AI_cleanSharedTodos_(options.todos);
    } else if (options && options.includeTodos === true && getAuthMode_().executesAsUser) {
      // Same rule as My To-Do: only read the personal list when the app really runs as this person.
      try { todos = ptReadAll_(PropertiesService.getUserProperties()); } catch (e) { todos = null; }
    }
    return AI_answer_(user, AI_systemPrompt_(user, todos), convo);
  } finally {
    AI_releaseBusy_(user.email);     // always, also after an error
  }
}

/** A personal to-do list sent by the page (backend API mode): only the fields the prompt uses, size-capped. */
function AI_cleanSharedTodos_(list) {
  return list.slice(0, 300).map(function (t) {
    t = t || {};
    return {
      title: String(t.title || '').slice(0, 200),
      notes: String(t.notes || '').slice(0, 1000),
      priority: String(t.priority || '').slice(0, 10),
      category: String(t.category || '').slice(0, 20),
      dueDate: String(t.dueDate || '').slice(0, 10),
      completed: t.completed === true
    };
  }).filter(function (t) { return !!t.title; });
}

function AI_answer_(user, system, convo) {
  try {
    const r = AI_complete_(system, convo);
    const out = { reply: r.text };
    if (user.isAdmin) out.via = r.provider.name;
    return out;
  } catch (e) {
    if (e.aiNotConfigured) {
      throw new Error(user.isAdmin
        ? 'The AI Assistant is not set up yet. Click the gear icon in the AI Assistant to add your first AI provider.'
        : 'The AI Assistant is not set up yet. Ask an Admin to add an AI provider.');
    }
    if (e.aiFailure) {
      const permission = (e.attempts || []).some(function (a) { return a.kind === 'permission'; });
      if (permission) throw new Error(permissionErrorMessage_('Connect to an external service'));
      let msg = 'The AI Assistant is temporarily unavailable. Please try again in a minute.';
      if (user.isAdmin) {
        msg += ' (Admin details: ' + e.attempts.map(function (a) {
          return a.name + ': ' + (AI_KIND_TEXT_[a.kind] || a.kind) + (a.code ? ' (HTTP ' + a.code + ')' : '') +
            (a.tries > 1 ? ', ' + a.tries + ' tries' : '') + (a.skipped ? ', paused after an earlier failure' : '') +
            (a.message ? ', "' + a.message + '"' : '');
        }).join('; ') + '.)';
      }
      throw new Error(msg);
    }
    throw e;
  }
}

// ============================================================================
// PUBLIC: ADMIN SETTINGS (Admins only; keys are write-only)
// ============================================================================

function getAiSettings() {
  requireAdmin_();
  return AI_settingsView_();
}

/** The provider list as the settings screen shows it: never the keys, only a hint of the last 4 characters. */
function AI_settingsView_() {
  return {
    types: Object.keys(AI_TYPES_).map(function (k) { return { id: k, label: AI_TYPES_[k].label, endpoint: AI_TYPES_[k].endpoint, modelHint: AI_TYPES_[k].modelHint }; }),
    providers: AI_loadProviders_().map(function (p) {
      return Object.assign({
        id: p.id, name: p.name, type: p.type, model: p.model, endpoint: p.endpoint || '', enabled: !!p.enabled,
        thinking: p.thinking === 'default' ? 'default' : 'low',
        hasKey: !!p.apiKey, keyHint: AI_keyHint_(p.apiKey)
      }, AI_providerState_(p.id, p));
    }),
    maxProviders: AI_CONFIG.MAX_PROVIDERS
  };
}

/**
 * Saves the ordered provider list. For an existing provider, a blank apiKey keeps the saved key;
 * clearKey: true removes it. Order in the list = order they are tried.
 */
function saveAiSettings(list) {
  const admin = requireAdmin_();
  if (!Array.isArray(list)) throw new Error('Nothing to save.');
  if (list.length > AI_CONFIG.MAX_PROVIDERS) throw new Error('At most ' + AI_CONFIG.MAX_PROVIDERS + ' providers.');
  const old = {};
  AI_loadProviders_().forEach(function (p) { old[p.id] = p; });
  const seenNames = {};
  const next = list.map(function (item, i) {
    const src = item || {};
    const prev = src.id && old[src.id] ? old[src.id] : null;
    const type = String(src.type || '').trim();
    const endpoint = String(src.endpoint || '').trim();
    const newKey = String(src.apiKey || '').trim();
    // A saved key is only kept for the same service: after a change of type or endpoint it must be
    // pasted again, so it can never be sent to an address it was not meant for.
    const sameService = !!prev && prev.type === type && (prev.endpoint || '') === endpoint;
    if (prev && prev.apiKey && !newKey && !sameService && src.enabled === true && src.clearKey !== true) {
      throw new Error('Provider #' + (i + 1) + ' ("' + String(src.name || '').trim() + '"): you changed its type or endpoint, so paste its API key again. A saved key is never sent to a different address.');
    }
    const p = {
      id: prev ? prev.id : Utilities.getUuid(),
      name: String(src.name || '').trim(),
      type: type,
      model: String(src.model || '').trim().replace(type === 'gemini' ? /^models\// : /^$/, ''),
      endpoint: endpoint,
      enabled: src.enabled === true,
      thinking: src.thinking === 'default' ? 'default' : 'low',   // Gemini only: "low" = faster answers
      apiKey: src.clearKey === true ? '' : (newKey || (sameService ? prev.apiKey : ''))
    };
    AI_validateProvider_(p, i);
    const lower = p.name.toLowerCase();
    if (seenNames[lower]) throw new Error('Two providers are called "' + p.name + '". Give each a different name.');
    seenNames[lower] = true;
    return p;
  });
  if (JSON.stringify(next).length > 8500) {
    throw new Error('The provider list is too long to save (Google allows about 9,000 characters for it). Remove a provider or shorten a long endpoint.');
  }
  AI_saveProviders_(next);
  next.forEach(function (p) {
    const prev = old[p.id];
    if (!prev || prev.apiKey !== p.apiKey || prev.model !== p.model || prev.endpoint !== p.endpoint || prev.type !== p.type) { AI_clearCooldown_(p.id); AI_clearStrikes_(p.id); }
    // Saving gives the thinking setting a fresh chance (for example after Google adds support for it).
    try { CacheService.getScriptCache().remove(AI_noThinkKey_(p)); if (prev) CacheService.getScriptCache().remove(AI_noThinkKey_(prev)); } catch (e) {}
  });
  console.log('[AI] Provider list saved by ' + admin.email + ': ' + next.map(function (p, i) { return (i + 1) + '. ' + p.name + ' (' + p.type + ', ' + p.model + (p.enabled ? '' : ', off') + ')'; }).join('; '));
  return AI_settingsView_();
}

/** Sends a tiny test message to ONE saved provider (ignores its pause) and reports the result. */
function testAiProvider(id) {
  requireAdmin_();
  const all = AI_loadProviders_();
  const p = all.filter(function (x) { return x.id === id; })[0];
  if (!p) throw new Error('Save the provider first, then test it.');
  if (!p.apiKey) return { ok: false, message: 'No API key saved for "' + p.name + '".' };
  // One test per provider at a time (a second click, or a second Admin, would only add load).
  const cache = CacheService.getScriptCache();
  const busyKey = 'WFM_AI_TESTING_' + p.id;
  if (cache.get(busyKey)) return { ok: false, message: 'A test of "' + p.name + '" is already running. Wait for its result.' };
  cache.put(busyKey, '1', 120);
  try {
    // Same retries as a real question, so Test shows what users would experience.
    // 1024, not 20: reasoning models use part of the allowance to think, and would return no text with a tiny one.
    const ctx = { id: 'test-' + Utilities.getUuid().slice(0, 4), started: Date.now(), providers: all };
    const r = AI_callWithRetry_(p, 'You are a connection test. Reply with the single word OK.', [{ role: 'user', content: 'Reply with OK.' }], 1024, ctx);
    const when = new Date().toISOString();
    const tries = r.tries > 1 ? ', after ' + r.tries + ' tries' : '';
    if (r.ok) {
      AI_clearCooldown_(p.id);   // a working provider is usable again at once, for everybody
      AI_clearStrikes_(p.id);
      AI_recordStatus_(p.id, { ok: true, at: when, ms: r.ms, tries: r.tries });
      console.log('[AI] ' + ctx.id + ' "' + p.name + '" (' + p.type + '/' + p.model + (r.thinking ? ', ' + r.thinking : '') + ') test OK in ' + (r.ms / 1000).toFixed(1) + ' s' + tries + '.');
      return { ok: true, state: AI_providerState_(p.id, p),
        message: '"' + p.name + '" works (answered in ' + (r.ms / 1000).toFixed(1) + ' s' + (r.thinking ? ', ' + r.thinking : '') + tries +
        (r.tries > 1 ? '; the first tries were refused because the service was busy' : '') + ').' };
    }
    const said = AI_redact_(r.message || '', all);
    AI_recordStatus_(p.id, { ok: false, at: when, kind: r.kind, code: r.code, tries: r.tries, message: said });
    if (r.kind === 'permission') return { ok: false, state: AI_providerState_(p.id, p), message: permissionErrorMessage_('Connect to an external service') };
    const overloaded = r.code === 503 || /overloaded|UNAVAILABLE/i.test(said);
    const hint = overloaded
      ? 'The provider\'s servers for this model are overloaded right now. This is on the provider\'s side, not your key; it usually passes within minutes. For a real backup, give another provider a different model.'
      : ({
        auth: 'Check the API key.', quota: 'The account has no quota or credit left.', config: 'Check the model name and the endpoint.',
        rate_limit: 'It is rate limited right now; try again in a minute.', unavailable: 'The service did not answer; try again later.',
        bad_request: 'The provider refused the request; check the model name and provider type.', empty: 'It answered, but with no text; check the model name.'
      }[r.kind] || '');
    return { ok: false, state: AI_providerState_(p.id, p),
      message: '"' + p.name + '" failed: ' + (AI_KIND_TEXT_[r.kind] || r.kind) + (r.code ? ' (HTTP ' + r.code + ')' : '') + tries + '. ' +
        (said ? 'Provider said: "' + said + '". ' : '') + hint,
      detail: AI_redact_(r.detail, all).slice(0, 240) };
  } finally {
    cache.remove(busyKey);
  }
}

/** Editor helper: prints the provider list and each one's state. Safe to run any time. */
function checkAiSetup() {
  requireSetupAccess_();
  const s = AI_settingsView_();
  const lines = ['AI providers (tried in this order):'];
  if (!s.providers.length) lines.push('  none. Open the app, Personal Assistant, AI Assistant, gear icon, to add one.');
  s.providers.forEach(function (p, i) {
    lines.push('  ' + (i + 1) + '. ' + p.name + ' [' + p.type + ', ' + p.model + '] ' + (p.enabled ? 'on' : 'OFF') + ', key ' + (p.hasKey ? p.keyHint : 'MISSING') +
      (p.type === 'gemini' ? ', thinking ' + (p.thinking === 'default' ? 'model default' : 'low') : '') +
      (p.pausedUntil ? ', paused until ' + p.pausedUntil + ' (' + p.pausedKind + ')' : '') +
      (p.strikes ? ', ' + p.strikes + ' failure(s) in a row' : '') +
      (p.last ? ', last: ' + (p.last.ok ? 'OK' : (AI_KIND_TEXT_[p.last.kind] || p.last.kind)) + ' at ' + p.last.at : ''));
  });
  Logger.log(lines.join('\n'));
  return lines.join('\n');
}