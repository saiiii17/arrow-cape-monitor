require("dotenv").config();

// Two providers behind one call so the same cached days can be re-extracted and
// compared. C3_PROVIDER picks: "groq" (default) or "anthropic".
const PROVIDER = (process.env.C3_PROVIDER || "groq").toLowerCase();

const MODEL =
  PROVIDER === "anthropic"
    ? process.env.C3_ANTHROPIC_MODEL // set in .env locally and in the host's dashboard
    : process.env.C3_MODEL || "openai/gpt-oss-120b";

// ---------------------------------------------------------------------------
// Groq counts the *requested* max_tokens against a per-minute budget, so a
// generous reservation alone can exceed the limit. This paces requests against
// a rolling 60s window instead of discovering the ceiling with a 429.
// Anthropic's limits are far higher, so the pacer only applies to Groq.
// ---------------------------------------------------------------------------
const TPM = Number(process.env.GROQ_TPM || 8000);
const spent = [];

function estimate(text, maxTokens) {
  return Math.ceil(text.length / 3.5) + maxTokens;
}

async function reserve(tokens) {
  if (PROVIDER !== "groq") return;
  for (;;) {
    const cutoff = Date.now() - 60_000;
    while (spent.length && spent[0].at < cutoff) spent.shift();
    const used = spent.reduce((n, s) => n + s.n, 0);
    if (used + tokens <= TPM) {
      spent.push({ at: Date.now(), n: tokens });
      return;
    }
    await new Promise((r) => setTimeout(r, Math.max(1000, spent[0].at + 60_000 - Date.now() + 250)));
  }
}

let groq = null;
let anthropic = null;

function getGroq() {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set in .env");
  if (!groq) groq = new (require("groq-sdk"))({ apiKey: process.env.GROQ_API_KEY });
  return groq;
}

function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set in .env (needed for C3_PROVIDER=anthropic)");
  }
  if (!anthropic) {
    const Anthropic = require("@anthropic-ai/sdk");
    anthropic = new Anthropic();
  }
  return anthropic;
}

// Token usage accumulates across a run so a provider comparison can report cost.
const usage = { provider: PROVIDER, model: MODEL, calls: 0, input: 0, output: 0 };

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("model did not return JSON");
  }
}

async function callGroq(system, user, maxTokens) {
  const res = await getGroq().chat.completions.create({
    model: MODEL,
    temperature: 0,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  usage.input += res.usage?.prompt_tokens || 0;
  usage.output += res.usage?.completion_tokens || 0;
  return res.choices[0].message.content.trim();
}

async function callAnthropic(system, user, maxTokens) {
  if (!MODEL) throw new Error("C3_ANTHROPIC_MODEL is not set — add the Anthropic model name to the environment");
  // Haiku 4.5 predates adaptive thinking and rejects output_config.effort, so
  // neither is sent. The system prompt already demands JSON-only output; the
  // prompt and parsing are identical to the Groq path to keep an A/B honest.
  const res = await getAnthropic().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  usage.input += res.usage?.input_tokens || 0;
  usage.output += res.usage?.output_tokens || 0;
  return res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

// A missing key or a 401 will never succeed on retry, and retrying it burns
// minutes because the caller also splits failed batches recursively.
function isFatal(err) {
  return (
    err.status === 401 ||
    err.status === 403 ||
    /API_KEY is not set|C3_ANTHROPIC_MODEL is not set|invalid[_ ]api[_ ]key|authentication/i.test(err.message || "") ||
    // Billing failures are permanent for the whole run, not transient.
    /credit balance is too low|billing|quota|payment required/i.test(err.message || "")
  );
}

async function completeJson(system, user, { maxTokens = 3600, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await reserve(estimate(system + user, maxTokens));
      usage.calls++;
      const text = PROVIDER === "anthropic"
        ? await callAnthropic(system, user, maxTokens)
        : await callGroq(system, user, maxTokens);
      return parseJson(text);
    } catch (err) {
      lastErr = err;
      if (isFatal(err)) throw err;
      const isRate = err.status === 429 || /rate_limit|too large/i.test(err.message || "");
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, isRate ? 20_000 : 1500 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

module.exports = { completeJson, MODEL, PROVIDER, usage };
