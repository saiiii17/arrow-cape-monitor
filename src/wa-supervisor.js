// The single authority on whether the WhatsApp browser may be torn down.
//
// This file exists because the connection layer grew fifteen independent
// restart call sites and four competing watchdogs, none aware of the others.
// Every connection bug so far has been one of them firing at the wrong
// moment: a stall watchdog killing a healthy page, a crash handler racing a
// reconnect, and -- most expensively -- the QR staleness timer tearing down
// Chromium while a phone was mid-handshake, which both aborted the scan and
// burned one of WhatsApp's limited link attempts.
//
// So watchdogs no longer act. They report, and this decides. It holds no
// browser handle and does no I/O, which is the point: the decision logic can
// be tested against every historical failure sequence without launching
// Chromium. See src/test-supervisor.js.

// A scan in flight is sacred. WhatsApp freezes the QR the moment a phone
// takes it, so silence here means progress, not death -- and a restart costs
// a link attempt against the account's rate limit.
const PROTECTED = new Set(["scanning", "authenticating", "loading"]);

// How long each state may sit still before it is genuinely stuck. Protected
// states get generous budgets because the cost of being wrong is a lockout.
const DEADLINES = {
  launching: 240_000,
  waiting_qr: 90_000,
  scanning: 120_000,
  authenticating: 150_000,
  loading: 150_000,
  ready: Infinity,
  idle: Infinity,
  stopped: Infinity,
};

// Restarting faster than this cannot help -- Chromium has not finished dying
// -- and WhatsApp counts every attempt.
const MIN_RESTART_GAP_MS = 3_000;

// The circuit breaker. Repeated relinking is what trips WhatsApp's "can't
// link new devices" lockout, so the supervisor stops trying and says so
// rather than hammering the account into a longer ban.
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 600_000;

// Events that prove the page is alive, and the state each moves us to.
const TRANSITIONS = {
  launch: "launching",
  qr_shown: "waiting_qr",
  qr_taken: "scanning", // code left the DOM: a phone has it
  authenticated: "authenticating",
  loading: "loading",
  ready: "ready",
  stop: "stopped",
};

function createSupervisor({ now = Date.now, onLog = () => {} } = {}) {
  const state = {
    name: "idle",
    since: now(),
    restarts: [], // timestamps, for the circuit breaker
    lastRestartAt: 0,
    trippedAt: 0,
  };

  function enter(name) {
    if (state.name === name) return;
    state.name = name;
    state.since = now();
  }

  // A watchdog reporting something it observed. Any real event clears the
  // current deadline by moving us forward.
  function event(kind) {
    const next = TRANSITIONS[kind];
    if (!next) throw new Error(`unknown supervisor event: ${kind}`);
    enter(next);
    return state.name;
  }

  function recentRestarts() {
    const cutoff = now() - RESTART_WINDOW_MS;
    return state.restarts.filter((t) => t > cutoff);
  }

  // The whole point of the module. A caller that wants to tear the browser
  // down asks here first and does nothing unless `allow` is true.
  function requestRestart(reason, { force = false } = {}) {
    const t = now();

    // A crash is not a judgement call -- the browser is already gone, so the
    // protected-state guard cannot apply. The circuit breaker still does.
    if (!force && PROTECTED.has(state.name)) {
      const waited = t - state.since;
      const budget = DEADLINES[state.name];
      if (waited < budget) {
        return {
          allow: false,
          reason: `${state.name} in progress (${Math.round(waited / 1000)}s of ${Math.round(budget / 1000)}s) — not interrupting a link in flight`,
        };
      }
    }

    const recent = recentRestarts();
    if (recent.length >= MAX_RESTARTS) {
      state.trippedAt = t;
      return {
        allow: false,
        tripped: true,
        reason: `${recent.length} restarts in ${Math.round(RESTART_WINDOW_MS / 60000)} minutes — stopping. Repeated attempts are what trigger WhatsApp's "can't link new devices" lockout. Wait 15 minutes, then press Connect.`,
      };
    }

    if (t - state.lastRestartAt < MIN_RESTART_GAP_MS) {
      return { allow: false, reason: "a restart is already in flight" };
    }

    state.restarts = [...recent, t];
    state.lastRestartAt = t;
    onLog(`restart allowed: ${reason}`);
    return { allow: true, reason, attempt: state.restarts.length };
  }

  // Called on a timer. Returns a restart request only when the current state
  // has genuinely overrun its budget.
  function tick() {
    const budget = DEADLINES[state.name];
    if (!Number.isFinite(budget)) return null;
    const waited = now() - state.since;
    if (waited < budget) return null;
    return requestRestart(`${state.name} exceeded ${Math.round(budget / 1000)}s`);
  }

  // An operator pressing Connect clears the breaker: they have waited, and
  // they are allowed to try again.
  function reset() {
    state.restarts = [];
    state.lastRestartAt = 0;
    state.trippedAt = 0;
    enter("idle");
  }

  return {
    event,
    tick,
    requestRestart,
    reset,
    get name() { return state.name; },
    get protectedNow() { return PROTECTED.has(state.name); },
    get restartCount() { return recentRestarts().length; },
    get tripped() { return state.trippedAt > 0; },
    waitedMs: () => now() - state.since,
  };
}

module.exports = { createSupervisor, PROTECTED, DEADLINES, MAX_RESTARTS };
