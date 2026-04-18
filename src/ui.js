/*
 * AI Manual — voice-driven manual for Ableton Move + Schwung.
 * Push-to-talk on bottom-row pads. Sampler captures mic, OpenAI Whisper
 * transcribes, GPT-4o-mini answers. Reply is split into a short headline
 * (pinned at top) and a scrollable detailed body.
 *
 * Setup: API key is entered at http://move.local:7700/config under
 * "Assistant" and lands at /data/UserData/schwung/secrets/openai_key.txt
 * (mode 0600, shared with AI Assistant). Model + base URL come from
 * shadow_config.json.
 */

import * as os from 'os';

const SCREEN_WIDTH = 128;
const SCREEN_HEIGHT = 64;
const LINE_H = 8;
const TEXT_COLS = 21;        /* small font, ~6px wide */
const HEADER_Y = 2;
const BODY_START_Y = 14;
const BODY_ROWS = 5;
const BODY_END_Y = BODY_START_Y + BODY_ROWS * LINE_H;  /* 54 */
const HINT_Y = SCREEN_HEIGHT - 8;                       /* 56 */

/* Done-state layout: replace the normal header with an inverted band
 * containing the short answer, then a scrollable detail region below. */
const SHORT_MAX_LINES = 2;
const SHORT_PAD = 1;

const CC_BACK = 51;
const CC_JOG = 14;           /* jog wheel turn (relative encoder) */
const CC_KNOB1 = 71;
const PAD_TALK_MIN = 68;     /* bottom-row pads */
const PAD_TALK_MAX = 75;
const PAD_CLEAR = 99;        /* top-right pad clears history */

const DIR = "/data/UserData/schwung/ai-manual";
const SECRETS_DIR = "/data/UserData/schwung/secrets";
const WAV_PATH = DIR + "/in.wav";
const STT_RESP = DIR + "/stt_resp.json";
const STT_STAT = DIR + "/stt_status.json";
const CHAT_REQ = DIR + "/chat_req.json";
const CHAT_RESP = DIR + "/chat_resp.json";
const CHAT_STAT = DIR + "/chat_status.json";
const PROBE_RESP = DIR + "/probe_resp";
const PROBE_STAT = DIR + "/probe_status.json";
const SHADOW_CFG = "/data/UserData/schwung/shadow_config.json";
const MOVE_MANUAL_PATH = "/data/UserData/schwung/shared/move_manual_bundled.json";
const SCHWUNG_MANUAL_PATH = "/data/UserData/schwung/shared/MANUAL.md";

/* Provider-agnostic connectivity check — hit Google's well-known 204 endpoint
 * instead of OpenAI's /models so the probe works even when the user has
 * picked a non-OpenAI provider (or hasn't set a key yet). */
const PROBE_URL = "https://www.google.com/generate_204";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

const SAMPLER_SOURCE_MOVE_INPUT = 1;

/* Cap conversation memory at this many user+assistant turns. Older turns are
 * dropped before each new request so the model only ever sees the most recent
 * N exchanges. Keeps token cost bounded even after a long session. */
const MAX_TURNS = 10;


const SYSTEM_PROMPT_CORE =
"You are a voice assistant for Ableton Move running Schwung custom firmware. " +
"You are read on a 128x64 1-bit OLED. You always reply with two parts:\n" +
"  short    — a one-line headline answer, MAX 21 characters, lead with the " +
"concrete action (shortcut, menu, button, parameter). No preamble, no " +
"\"sure\", no \"of course\", no restating the question. If the answer " +
"genuinely won't fit in 21 chars, abbreviate.\n" +
"  detailed — a fuller explanation, plain text, 2-8 sentences. Cover the " +
"how + the why + any gotchas. The user reads this by scrolling, so you " +
"have room to be thorough — but no fluff.\n\n" +
"Rules:\n" +
"- Try hard to answer. Use the bundled Move and Schwung manuals as the " +
"primary source; cite them implicitly through accuracy. If a question is " +
"about general music production or DAWs and not specifically Move/Schwung, " +
"give your best answer drawing on general knowledge.\n" +
"- Only say \"Not sure\" when you genuinely have no useful information. " +
"Phrase it as the short answer, then in detailed explain what you DO know " +
"adjacent to the question. Never refuse a question you can partially answer.\n" +
"- Don't invent Move-specific shortcuts or features that aren't in the " +
"manual. If unsure of a specific shortcut, say so in detailed and offer " +
"the closest documented behavior.\n" +
"- No markdown, bullets, asterisks, or numbered lists in either field.\n\n" +
"Examples (short / detailed):\n" +
"User: how do I quantize a clip?\n" +
"  short: Hold step, turn Knob 1\n" +
"  detailed: On Move you quantize per step rather than per clip. Hold a " +
"step button to select a note, then turn Knob 1 to nudge it to the grid. " +
"To quantize all notes in a clip at once, use the Live Set after sending " +
"to Live via the Note app — Move itself doesn't have a one-shot quantize-all.\n\n" +
"User: what does swing do?\n" +
"  short: Delays off-beats\n" +
"  detailed: Swing shifts every other 16th note slightly later in time, " +
"giving the rhythm a triplet-like groove. On Move it's set per track via " +
"the Groove menu. 50% is straight, higher values lean more triplet, lower " +
"values rush off-beats.";

let SYSTEM_PROMPT = SYSTEM_PROMPT_CORE;  /* enriched at init() with manuals */

/* Recursively flatten the parsed Move manual JSON into prose suitable for
 * an LLM system prompt. The on-device JSON has each section as
 * {title, lines?, children?}, with `lines` being the OLED-wrapped 20-char
 * strings — we re-join them so the model reads natural prose. */
function flattenManualSections(sections, depth) {
    if (!Array.isArray(sections)) return "";
    let out = "";
    const prefix = "#".repeat(Math.min(depth + 1, 6));
    for (const s of sections) {
        if (!s) continue;
        if (s.title) out += prefix + " " + s.title + "\n";
        if (Array.isArray(s.lines) && s.lines.length) {
            /* Re-join wrapped lines with spaces; blank lines mark paragraph
             * breaks in the on-device viewer, preserve them as newlines. */
            let para = "";
            for (const ln of s.lines) {
                if (ln === "") {
                    if (para) { out += para + "\n\n"; para = ""; }
                } else {
                    para = para ? (para + " " + ln) : ln;
                }
            }
            if (para) out += para + "\n";
            out += "\n";
        }
        if (s.children) out += flattenManualSections(s.children, depth + 1);
    }
    return out;
}

function buildSystemPrompt() {
    let prompt = SYSTEM_PROMPT_CORE;

    /* Move manual (parsed JSON shipped under shared/) */
    if (host_file_exists(MOVE_MANUAL_PATH)) {
        try {
            const raw = host_read_file(MOVE_MANUAL_PATH);
            if (raw) {
                const j = JSON.parse(raw);
                const text = flattenManualSections(j.sections || [], 0).trim();
                if (text) {
                    prompt += "\n\n=== ABLETON MOVE MANUAL ===\n" + text;
                }
            }
        } catch (e) { /* manual missing or malformed — fall back gracefully */ }
    }

    /* Schwung manual (markdown) */
    if (host_file_exists(SCHWUNG_MANUAL_PATH)) {
        const md = host_read_file(SCHWUNG_MANUAL_PATH);
        if (md) prompt += "\n\n=== SCHWUNG MANUAL ===\n" + md.trim();
    }

    return prompt;
}

let state = "idle";
/* idle | recording | waiting_record_stop | transcribing | thinking | done | error */
let messages = [];
let lastError = "";          /* short label (fits header, ~16 chars) */
let lastErrorDetail = "";    /* fuller message (wraps in body area) */
let shortAnswer = "";        /* current reply: one-line headline */
let shortLines = [];         /* shortAnswer wrapped to fit short region */
let displayLines = [];       /* detailed answer wrapped (scrollable) */
let scrollOffset = 0;
let frameCount = 0;
let recStartFrame = 0;
let configChecked = false;

/* Provider config loaded fresh on each module entry (and before each
 * recording) so users who switch providers in the web UI pick up the
 * change without exiting the tool. */
let providerCfg = {
    provider: "gemini",  /* "gemini" | "openai" */
    openai:  {key: null, chatModel: "gpt-4o-mini",
              baseUrl: "https://api.openai.com/v1", sttModel: "whisper-1"},
    gemini:  {key: null, chatModel: "gemini-2.5-flash"},
};

/* Connectivity probe state. Hits the configured OpenAI base URL on init and
 * caches the result so we can show a clear "Offline" message before the user
 * wastes effort recording. Re-probes every PROBE_RE_INTERVAL_FRAMES while
 * offline so the UI clears as soon as Wi-Fi returns. While online we don't
 * keep polling — the next chat/STT failure (curl_exit 6) will flip us back. */
let online = null;           /* null = unknown, true = online, false = offline */
let probeInFlight = false;
let lastProbeFrame = -9999;
const PROBE_RE_INTERVAL_FRAMES = 44 * 10;  /* re-probe every ~10s while offline */

function ensureDir() {
    if (typeof host_ensure_dir === "function") host_ensure_dir(DIR);
}

function safeUnlink(path) {
    try { os.remove(path); } catch (e) { /* ignore — file may not exist */ }
}

function cleanupTransientFiles() {
    /* Remove the recorded audio and transient API blobs once we don't need
     * them. The WAV is by far the largest (~500 KB) and is privacy-sensitive,
     * so it's the priority. JSON files are tiny but still pointless to keep. */
    safeUnlink(WAV_PATH);
    safeUnlink(STT_RESP);
    safeUnlink(STT_STAT);
    safeUnlink(CHAT_REQ);
    safeUnlink(CHAT_RESP);
    safeUnlink(CHAT_STAT);
    safeUnlink(PROBE_RESP);
    safeUnlink(PROBE_STAT);
}

function startConnectivityProbe() {
    if (probeInFlight) return;
    if (typeof host_http_request_background !== "function") {
        online = false;
        return;
    }
    probeInFlight = true;
    lastProbeFrame = frameCount;
    safeUnlink(PROBE_STAT);
    /* Hit Google's canonical connectivity endpoint (returns 204 No Content).
     * Provider-agnostic — works regardless of which LLM service is picked
     * and requires no auth. HTTP status > 0 = network is up.
     * GET (not HEAD): curl's -X HEAD doesn't set the internal nobody flag
     * so curl waits for a body that never comes and times out. GET avoids
     * this — response body is zero bytes for 204 anyway. */
    const ok = host_http_request_background({
        url: PROBE_URL,
        method: "GET",
        response_path: PROBE_RESP,
        status_path: PROBE_STAT,
        timeout_seconds: 10
    });
    if (!ok) {
        probeInFlight = false;
        online = false;
    }
}

function pollConnectivityProbe() {
    if (!probeInFlight) return;
    if (!host_file_exists(PROBE_STAT)) return;
    const txt = host_read_file(PROBE_STAT);
    if (!txt || txt.length === 0) return;
    let parsed;
    try { parsed = JSON.parse(txt); } catch (e) { return; }
    /* Any HTTP response = network works. Otherwise offline. */
    online = (parsed.http_status > 0);
    probeInFlight = false;
    safeUnlink(PROBE_RESP);
    safeUnlink(PROBE_STAT);
}

function readSecret(filename) {
    const path = SECRETS_DIR + "/" + filename;
    if (!host_file_exists(path)) return null;
    const s = host_read_file(path);
    return s ? s.trim() : null;
}

function loadConfig() {
    /* Always read fresh — the user may swap providers or rotate keys in the
     * web UI without exiting this module. */
    providerCfg.openai.key = readSecret("openai_key.txt");
    providerCfg.gemini.key = readSecret("gemini_key.txt");

    if (host_file_exists(SHADOW_CFG)) {
        try {
            const cfg = JSON.parse(host_read_file(SHADOW_CFG) || "{}");
            if (cfg.ai_provider) providerCfg.provider = String(cfg.ai_provider).trim();
            if (cfg.openai_model) providerCfg.openai.chatModel = String(cfg.openai_model).trim();
            if (cfg.openai_base_url) {
                providerCfg.openai.baseUrl = String(cfg.openai_base_url).trim().replace(/\/+$/, "");
            }
            if (cfg.gemini_model) providerCfg.gemini.chatModel = String(cfg.gemini_model).trim();
        } catch (e) { /* ignore */ }
    }
    configChecked = true;
}

/* Returns the effective active-provider config or null if no key is set. */
function activeProvider() {
    const p = providerCfg.provider;
    if (p === "gemini" && providerCfg.gemini.key) {
        return {kind: "gemini", key: providerCfg.gemini.key,
                model: providerCfg.gemini.chatModel};
    }
    if (p === "openai" && providerCfg.openai.key) {
        return {kind: "openai", key: providerCfg.openai.key,
                baseUrl: providerCfg.openai.baseUrl,
                chatModel: providerCfg.openai.chatModel,
                sttModel: providerCfg.openai.sttModel};
    }
    return null;
}

function wrapText(text, cols) {
    const out = [];
    const paragraphs = String(text).split("\n");
    for (const para of paragraphs) {
        if (para === "") { out.push(""); continue; }
        const words = para.split(/\s+/);
        let cur = "";
        for (const w of words) {
            if (!w) continue;
            if (cur.length === 0) {
                cur = w;
            } else if (cur.length + 1 + w.length <= cols) {
                cur += " " + w;
            } else {
                out.push(cur);
                cur = w;
            }
            while (cur.length > cols) {
                out.push(cur.slice(0, cols));
                cur = cur.slice(cols);
            }
        }
        if (cur.length) out.push(cur);
    }
    return out;
}

function setReply(short, detailed) {
    shortAnswer = String(short || "").trim();
    /* Short region gets up to 2 lines if the model exceeded 21 chars. */
    shortLines = shortAnswer ? wrapText(shortAnswer, TEXT_COLS).slice(0, 2) : [];
    displayLines = detailed ? wrapText(String(detailed), TEXT_COLS) : [];
    scrollOffset = 0;
}

function startRecording() {
    if (state === "recording" || state === "waiting_record_stop") return;
    if (!configChecked) loadConfig();
    else loadConfig();  /* refresh every attempt so provider/key changes stick */
    const prov = activeProvider();
    if (!prov) {
        state = "error";
        lastError = "Set API key";
        return;
    }
    /* Don't block on online===false — the probe can latch stale state on
     * networks where HEAD or generate_204 is flaky. Kick a fresh probe and
     * let the real API call determine the outcome; a success will flip
     * online back to true via readStatus, a real network failure will show
     * a specific curl error. */
    if (online === false) startConnectivityProbe();
    if (typeof host_sampler_start !== "function") {
        state = "error";
        lastError = "no sampler";
        return;
    }
    ensureDir();
    if (typeof host_sampler_set_source === "function") {
        host_sampler_set_source(SAMPLER_SOURCE_MOVE_INPUT);
    }
    /* Clear stale status files so the poller doesn't pick up old results. */
    if (host_file_exists(STT_STAT)) host_write_file(STT_STAT, "");
    if (host_file_exists(CHAT_STAT)) host_write_file(CHAT_STAT, "");
    host_sampler_start(WAV_PATH);
    state = "recording";
    recStartFrame = frameCount;
}

function stopRecording() {
    if (state !== "recording") return;
    if (typeof host_sampler_stop === "function") host_sampler_stop();
    state = "waiting_record_stop";
}

function readStatus(path) {
    if (!host_file_exists(path)) return null;
    const txt = host_read_file(path);
    if (!txt || txt.length === 0) return null;
    let stat;
    try { stat = JSON.parse(txt); } catch (e) { return null; }
    /* Centralized connectivity-state update. Any HTTP response (even 401,
     * 429) proves the network works — flips a stale-offline flag back to
     * true. A DNS (6) or connect-refused (7) curl exit proves it doesn't.
     * Other curl errors (TLS, timeout) are ambiguous; leave state alone. */
    if (stat && typeof stat.http_status === "number" && stat.http_status > 0) {
        online = true;
    } else if (stat && (stat.curl_exit === 6 || stat.curl_exit === 7)) {
        online = false;
    }
    return stat;
}

/* Pull a JSON object out of free-form model output. Gemini's
 * responseMimeType:"application/json" usually returns clean JSON, but in the
 * wild it occasionally wraps the object in ```json fences or prepends stray
 * prose. This trims those so JSON.parse succeeds. Returns the parsed object
 * or null. */
function extractJsonObject(raw) {
    if (!raw) return null;
    let t = String(raw).trim();
    /* Strip markdown code fences if present. */
    if (t.startsWith("```")) {
        t = t.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }
    /* Trim to the outermost {...} span in case the model added leading text. */
    const first = t.indexOf("{");
    const last = t.lastIndexOf("}");
    if (first > 0 || (first === 0 && last < t.length - 1)) {
        if (first >= 0 && last > first) t = t.substring(first, last + 1);
    }
    try { return JSON.parse(t); } catch (e) { return null; }
}

/* Translate an HTTP status + provider error body into:
 *   - a terse one-line label for the header (e.g. "Rate limited")
 *   - the provider's own human-readable message for the scrollable body
 * Works for both OpenAI-shape ({error: {message, type, code}}) and Gemini-shape
 * ({error: {code, message, status}}) error bodies. Falls back gracefully when
 * the body is empty or non-JSON. */
function setHttpError(status, bodyPath) {
    let shortLabel;
    switch (status) {
        case 400: shortLabel = "Bad request"; break;
        case 401: shortLabel = "Bad API key"; break;
        case 402: shortLabel = "Quota exceeded"; break;
        case 403: shortLabel = "Access denied"; break;
        case 404: shortLabel = "Not found"; break;
        case 408: shortLabel = "Timed out"; break;
        case 413: shortLabel = "Audio too big"; break;
        case 429: shortLabel = "Rate limited"; break;
        default:
            if (status >= 500 && status < 600) shortLabel = "Provider error";
            else shortLabel = "HTTP " + status;
    }
    let detail = "";
    if (bodyPath && host_file_exists(bodyPath)) {
        const body = host_read_file(bodyPath);
        if (body) {
            try {
                const parsed = JSON.parse(body);
                if (parsed && parsed.error) {
                    if (typeof parsed.error.message === "string") {
                        detail = parsed.error.message.trim();
                    } else if (typeof parsed.error === "string") {
                        detail = parsed.error.trim();
                    }
                }
            } catch (e) {
                /* Not JSON — if the body is short, show it raw as a hint. */
                if (body.length < 200) detail = body.trim();
            }
        }
    }
    /* Cap detail to something that doesn't swamp the scrollable body. */
    if (detail.length > 400) detail = detail.substring(0, 397) + "...";
    state = "error";
    lastError = shortLabel;
    lastErrorDetail = detail;
}

function setNetworkError(curlExit) {
    let shortLabel;
    let detail = "";
    switch (curlExit) {
        case 6:  shortLabel = "No internet"; detail = "DNS lookup failed. Check your Wi-Fi network."; break;
        case 7:  shortLabel = "Can't connect"; detail = "The provider refused the connection."; break;
        case 28: shortLabel = "Timed out"; detail = "Network or provider took too long to respond."; break;
        case 35: shortLabel = "TLS failed"; detail = "Could not establish a secure connection."; break;
        case 60: shortLabel = "Cert error"; detail = "TLS certificate could not be verified."; break;
        default: shortLabel = "Net err " + curlExit;
    }
    state = "error";
    lastError = shortLabel;
    lastErrorDetail = detail;
}

/* ----------------------------------------------------------------
 * Provider dispatch.
 * OpenAI / OpenAI-compatible: two calls (Whisper STT → chat completion).
 * Gemini: one call (inline audio + generateContent).
 * ---------------------------------------------------------------- */

function startProviderRequest() {
    if (!host_file_exists(WAV_PATH)) {
        state = "error"; lastError = "no audio"; return;
    }
    const prov = activeProvider();
    if (!prov) { state = "error"; lastError = "Set API key"; return; }
    if (prov.kind === "gemini") startGeminiTranscription(prov);
    else startOpenAITranscription(prov);
}

function pollProviderRequest() {
    const prov = activeProvider();
    if (!prov) return;
    if (state === "transcribing") {
        if (prov.kind === "gemini") pollGeminiTranscription(prov);
        else pollOpenAITranscription(prov);
    } else if (state === "thinking") {
        if (prov.kind === "gemini") pollGeminiAnswer();
        else pollOpenAIChat();
    }
}

/* ---- OpenAI / OpenAI-compatible ---- */

function startOpenAITranscription(prov) {
    host_write_file(STT_STAT, "");
    const ok = host_http_request_background({
        url: prov.baseUrl + "/audio/transcriptions",
        method: "POST",
        headers: ["Authorization: Bearer " + prov.key],
        body_form: [
            {name: "model", value: prov.sttModel},
            {name: "file", file: WAV_PATH, type: "audio/wav"}
        ],
        response_path: STT_RESP,
        status_path: STT_STAT,
        timeout_seconds: 30
    });
    if (!ok) { state = "error"; lastError = "STT launch failed"; return; }
    state = "transcribing";
}

function pollOpenAITranscription(prov) {
    const stat = readStatus(STT_STAT);
    if (!stat) return;
    if (stat.curl_exit !== 0) {
        setNetworkError(stat.curl_exit);
        safeUnlink(WAV_PATH);
        return;
    }
    if (stat.http_status !== 200) {
        setHttpError(stat.http_status, STT_RESP);
        safeUnlink(WAV_PATH);
        return;
    }
    const resp = host_read_file(STT_RESP);
    if (!resp) { state = "error"; lastError = "no STT body"; return; }
    let parsed;
    try { parsed = JSON.parse(resp); } catch (e) {
        state = "error"; lastError = "bad STT JSON"; return;
    }
    const text = parsed && parsed.text ? String(parsed.text).trim() : "";
    if (!text) {
        state = "error"; lastError = "(silence)";
        safeUnlink(WAV_PATH);
        return;
    }
    messages.push({role: "user", content: text});
    trimMessageHistory();
    safeUnlink(WAV_PATH);
    safeUnlink(STT_RESP);
    safeUnlink(STT_STAT);
    startOpenAIChat(prov);
}

function startOpenAIChat(prov) {
    const body = {
        model: prov.chatModel,
        messages: [{role: "system", content: SYSTEM_PROMPT}].concat(messages),
        max_tokens: 500,
        temperature: 0.3,
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "AssistantReply",
                strict: true,
                schema: {
                    type: "object",
                    properties: {
                        short:    {type: "string", description: "One-line headline answer, max 21 characters."},
                        detailed: {type: "string", description: "2-8 sentence explanation. Plain text, no markdown."}
                    },
                    required: ["short", "detailed"],
                    additionalProperties: false
                }
            }
        }
    };
    if (!host_write_file(CHAT_REQ, JSON.stringify(body))) {
        state = "error"; lastError = "write chat req"; return;
    }
    host_write_file(CHAT_STAT, "");
    const ok = host_http_request_background({
        url: prov.baseUrl + "/chat/completions",
        method: "POST",
        headers: [
            "Authorization: Bearer " + prov.key,
            "Content-Type: application/json"
        ],
        body_path: CHAT_REQ,
        response_path: CHAT_RESP,
        status_path: CHAT_STAT,
        timeout_seconds: 60
    });
    if (!ok) { state = "error"; lastError = "chat launch failed"; return; }
    state = "thinking";
}

function pollOpenAIChat() {
    const stat = readStatus(CHAT_STAT);
    if (!stat) return;
    if (stat.curl_exit !== 0) { setNetworkError(stat.curl_exit); return; }
    if (stat.http_status !== 200) {
        setHttpError(stat.http_status, CHAT_RESP);
        return;
    }
    const resp = host_read_file(CHAT_RESP);
    if (!resp) { state = "error"; lastError = "no chat body"; return; }
    let parsed;
    try { parsed = JSON.parse(resp); } catch (e) {
        state = "error"; lastError = "bad chat JSON"; return;
    }
    const reply = parsed && parsed.choices && parsed.choices[0]
        && parsed.choices[0].message && parsed.choices[0].message.content
        ? String(parsed.choices[0].message.content).trim() : "";
    if (!reply) { state = "error"; lastError = "(empty reply)"; return; }
    const obj = extractJsonObject(reply);
    let shortText = "", detailedText = "";
    if (obj) {
        shortText = String(obj.short || "").trim();
        detailedText = String(obj.detailed || "").trim();
    } else {
        detailedText = reply.replace(/^[\s{"]+|[\s}"]+$/g, "").trim();
    }
    if (!shortText && !detailedText) {
        state = "error"; lastError = "(empty reply)"; return;
    }
    /* Store plain-text in history so subsequent prompts don't see nested JSON. */
    const historyText = shortText && detailedText
        ? (shortText + "\n\n" + detailedText)
        : (detailedText || shortText);
    messages.push({role: "assistant", content: historyText});
    trimMessageHistory();
    setReply(shortText, detailedText);
    state = "done";
    safeUnlink(CHAT_REQ);
    safeUnlink(CHAT_RESP);
    safeUnlink(CHAT_STAT);
}

/* ---- Gemini (two-call flow: transcribe, then answer) ----
 * Single-call flow was too flaky on follow-up turns — Gemini would often
 * emit JSON without the outer braces or drop the schema entirely once the
 * conversation had a prior turn. Splitting mirrors the OpenAI flow: call 1
 * (this function) is audio → {transcript}; call 2 (startGeminiAnswer) is
 * history → {short, detailed}. Simpler per-call schema + no transcript-in-
 * response on the answer call makes format compliance much tighter. */

function startGeminiTranscription(prov) {
    if (typeof host_read_file_base64 !== "function") {
        state = "error"; lastError = "no base64 host fn"; return;
    }
    const audioB64 = host_read_file_base64(WAV_PATH);
    if (!audioB64) { state = "error"; lastError = "read wav failed"; return; }
    const body = {
        contents: [{
            role: "user",
            parts: [
                {inline_data: {mime_type: "audio/wav", data: audioB64}},
                {text: "Transcribe this audio verbatim. Return only the spoken " +
                       "text, no translation, no commentary."}
            ]
        }],
        generationConfig: {
            temperature: 0.0,
            maxOutputTokens: 300,
            responseMimeType: "application/json",
            responseSchema: {
                type: "object",
                properties: {transcript: {type: "string"}},
                required: ["transcript"]
            }
        }
    };
    if (!host_write_file(CHAT_REQ, JSON.stringify(body))) {
        state = "error"; lastError = "write stt req"; return;
    }
    host_write_file(STT_STAT, "");
    const url = GEMINI_BASE + "/models/" + prov.model + ":generateContent";
    const ok = host_http_request_background({
        url: url,
        method: "POST",
        headers: [
            "x-goog-api-key: " + prov.key,
            "Content-Type: application/json"
        ],
        body_path: CHAT_REQ,
        response_path: STT_RESP,
        status_path: STT_STAT,
        timeout_seconds: 30
    });
    if (!ok) { state = "error"; lastError = "STT launch failed"; return; }
    state = "transcribing";
}

function pollGeminiTranscription(prov) {
    const stat = readStatus(STT_STAT);
    if (!stat) return;
    if (stat.curl_exit !== 0) {
        setNetworkError(stat.curl_exit);
        safeUnlink(WAV_PATH);
        return;
    }
    if (stat.http_status !== 200) {
        setHttpError(stat.http_status, STT_RESP);
        safeUnlink(WAV_PATH);
        return;
    }
    const resp = host_read_file(STT_RESP);
    if (!resp) { state = "error"; lastError = "no STT body"; return; }
    let parsed;
    try { parsed = JSON.parse(resp); } catch (e) {
        state = "error"; lastError = "bad STT JSON"; return;
    }
    const text = parsed && parsed.candidates && parsed.candidates[0]
        && parsed.candidates[0].content && parsed.candidates[0].content.parts
        && parsed.candidates[0].content.parts[0] && parsed.candidates[0].content.parts[0].text
        ? String(parsed.candidates[0].content.parts[0].text).trim() : "";
    if (!text) { state = "error"; lastError = "(silence)";
                 safeUnlink(WAV_PATH); return; }
    const obj = extractJsonObject(text);
    const transcript = obj && typeof obj.transcript === "string"
        ? obj.transcript.trim()
        : text.replace(/^[\s{"]+|[\s}"]+$/g, "").trim();
    if (!transcript) {
        state = "error"; lastError = "(silence)";
        safeUnlink(WAV_PATH);
        return;
    }
    messages.push({role: "user", content: transcript});
    trimMessageHistory();
    safeUnlink(WAV_PATH);
    safeUnlink(STT_RESP);
    safeUnlink(STT_STAT);
    startGeminiAnswer(prov);
}

function startGeminiAnswer(prov) {
    /* Convert chat history from OpenAI-shape to Gemini-shape. */
    const contents = messages.map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{text: m.content}]
    }));
    const body = {
        contents,
        systemInstruction: {parts: [{text: SYSTEM_PROMPT}]},
        generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 700,
            responseMimeType: "application/json",
            responseSchema: {
                type: "object",
                properties: {
                    short:    {type: "string"},
                    detailed: {type: "string"}
                },
                required: ["short", "detailed"]
            }
        }
    };
    if (!host_write_file(CHAT_REQ, JSON.stringify(body))) {
        state = "error"; lastError = "write chat req"; return;
    }
    host_write_file(CHAT_STAT, "");
    const url = GEMINI_BASE + "/models/" + prov.model + ":generateContent";
    const ok = host_http_request_background({
        url: url,
        method: "POST",
        headers: [
            "x-goog-api-key: " + prov.key,
            "Content-Type: application/json"
        ],
        body_path: CHAT_REQ,
        response_path: CHAT_RESP,
        status_path: CHAT_STAT,
        timeout_seconds: 60
    });
    if (!ok) { state = "error"; lastError = "chat launch failed"; return; }
    state = "thinking";
}

function pollGeminiAnswer() {
    const stat = readStatus(CHAT_STAT);
    if (!stat) return;
    if (stat.curl_exit !== 0) { setNetworkError(stat.curl_exit); return; }
    if (stat.http_status !== 200) {
        setHttpError(stat.http_status, CHAT_RESP);
        return;
    }
    const resp = host_read_file(CHAT_RESP);
    if (!resp) { state = "error"; lastError = "no chat body"; return; }
    let parsed;
    try { parsed = JSON.parse(resp); } catch (e) {
        state = "error"; lastError = "bad chat JSON"; return;
    }
    const text = parsed && parsed.candidates && parsed.candidates[0]
        && parsed.candidates[0].content && parsed.candidates[0].content.parts
        && parsed.candidates[0].content.parts[0] && parsed.candidates[0].content.parts[0].text
        ? String(parsed.candidates[0].content.parts[0].text).trim() : "";
    if (!text) { state = "error"; lastError = "(empty reply)"; return; }
    const obj = extractJsonObject(text);
    let shortText = "", detailedText = "";
    if (obj) {
        shortText    = String(obj.short || "").trim();
        detailedText = String(obj.detailed || "").trim();
    } else {
        detailedText = text.replace(/^[\s{"]+|[\s}"]+$/g, "").trim();
    }
    if (!shortText && !detailedText) {
        state = "error"; lastError = "(empty reply)"; return;
    }
    const historyText = shortText && detailedText
        ? (shortText + "\n\n" + detailedText)
        : (detailedText || shortText);
    messages.push({role: "assistant", content: historyText});
    trimMessageHistory();
    setReply(shortText, detailedText);
    state = "done";
    safeUnlink(CHAT_REQ);
    safeUnlink(CHAT_RESP);
    safeUnlink(CHAT_STAT);
}

function clearConversation() {
    messages = [];
    shortAnswer = "";
    shortLines = [];
    displayLines = [];
    scrollOffset = 0;
    state = "idle";
    lastError = "";
    lastErrorDetail = "";
}

function trimMessageHistory() {
    /* Drop oldest user/assistant pairs until we are within MAX_TURNS.
     * Always pops in pairs so we never leave an orphan assistant reply
     * (which the chat API will reject as malformed history). */
    while (messages.length > MAX_TURNS * 2) {
        messages.shift();
        if (messages.length && messages[0].role === "assistant") {
            messages.shift();
        }
    }
}

function drawHeader() {
    /* Done state has its own header substitute — the inverted short band. */
    if (state === "done") return;

    let label = "AI Manual";
    if (state === "recording") {
        const secs = Math.max(1, Math.floor((frameCount - recStartFrame) / 44));
        label = "Listening " + secs + "s";
    } else if (state === "waiting_record_stop") {
        label = "Saving...";
    } else if (state === "transcribing") {
        label = "Transcribing" + ".".repeat(1 + Math.floor(frameCount / 8) % 3);
    } else if (state === "thinking") {
        label = "Thinking" + ".".repeat(1 + Math.floor(frameCount / 8) % 3);
    } else if (state === "error") {
        label = "Err: " + (lastError || "?");
    } else if (!activeProvider()) {
        label = "Set key in /config";
    } else if (online === false) {
        label = "Offline";
    }
    if (label.length > TEXT_COLS) label = label.substring(0, TEXT_COLS);
    print(2, HEADER_Y, label, 1);
    draw_line(0, 11, 127, 11, 1);
}

function drawShortBand() {
    /* Inverted top band displaying the pinned short answer. Height adapts
     * to how many lines the short wrapped to (1 or 2). Returns the y
     * coordinate where the detail region should start. */
    const lines = shortLines.length ? shortLines : ["(no reply)"];
    const visibleLines = Math.min(lines.length, SHORT_MAX_LINES);
    const bandH = visibleLines * LINE_H + SHORT_PAD * 2;
    fill_rect(0, 0, SCREEN_WIDTH, bandH, 1);
    for (let i = 0; i < visibleLines; i++) {
        /* Black text on white background = inverted. */
        print(2, SHORT_PAD + i * LINE_H, lines[i], 0);
    }
    return bandH + 1;  /* 1px breathing gap before detail */
}

function drawDetail(detailStartY) {
    const lines = displayLines;
    const detailH = HINT_Y - detailStartY - 1;  /* leave 1px above footer */
    const visible = Math.max(1, Math.floor(detailH / LINE_H));
    const maxOffset = Math.max(0, lines.length - visible);
    if (scrollOffset > maxOffset) scrollOffset = maxOffset;
    if (scrollOffset < 0) scrollOffset = 0;
    for (let i = 0; i < visible; i++) {
        const idx = scrollOffset + i;
        if (idx >= lines.length) break;
        print(2, detailStartY + i * LINE_H, lines[idx], 1);
    }
    /* Scroll indicator on the right edge. */
    if (lines.length > visible) {
        const trackTop = detailStartY;
        const trackBottom = detailStartY + visible * LINE_H;
        const trackH = trackBottom - trackTop;
        const knobH = Math.max(4, Math.floor(trackH * visible / lines.length));
        const knobY = trackTop + Math.floor((trackH - knobH) * scrollOffset / Math.max(1, maxOffset));
        draw_line(125, trackTop, 125, trackBottom, 1);
        fill_rect(124, knobY, 3, knobH, 1);
    }
}

function drawBody() {
    if (state === "idle") {
        if (!activeProvider()) {
            const lines = wrapText(
                "Open move.local:7700 in a browser, go to Settings > Assistant, pick a provider and paste its API key.",
                TEXT_COLS);
            for (let i = 0; i < Math.min(lines.length, BODY_ROWS); i++) {
                print(2, BODY_START_Y + i * LINE_H, lines[i], 1);
            }
            return;
        }
        if (online === false) {
            const lines = wrapText(
                "Unavailable. Connect to a Wi-Fi network with internet. Retrying...",
                TEXT_COLS);
            for (let i = 0; i < Math.min(lines.length, BODY_ROWS); i++) {
                print(2, BODY_START_Y + i * LINE_H, lines[i], 1);
            }
            return;
        }
        print(2, BODY_START_Y, "Hold a bottom pad", 1);
        print(2, BODY_START_Y + LINE_H, "to ask a question.", 1);
        if (messages.length > 0) {
            print(2, BODY_START_Y + LINE_H * 3, "Top-right pad:", 1);
            print(2, BODY_START_Y + LINE_H * 4, "clear conversation", 1);
        }
        return;
    }

    if (state === "recording" || state === "waiting_record_stop"
        || state === "transcribing" || state === "thinking") {
        if (state === "recording" || state === "waiting_record_stop") {
            const sec = Math.max(0, Math.floor((frameCount - recStartFrame) / 44));
            print(2, BODY_START_Y, "Speak now... " + sec + "s", 1);
        }
        if (messages.length > 0) {
            const lastMsg = messages[messages.length - 1];
            if (lastMsg.role === "user") {
                const lines = wrapText("> " + lastMsg.content, TEXT_COLS);
                const startRow = (state === "transcribing" || state === "thinking") ? 0 : 2;
                for (let i = 0; i < Math.min(lines.length, BODY_ROWS - startRow); i++) {
                    print(2, BODY_START_Y + (startRow + i) * LINE_H, lines[i], 1);
                }
            }
        }
        return;
    }

    if (state === "done") {
        const detailStart = drawShortBand();
        drawDetail(detailStart);
        return;
    }

    /* error: show the provider's own error message if we have one, falling
     * back to the short label. The header already shows the short label so
     * we don't duplicate it here. */
    if (state === "error") {
        const body = lastErrorDetail || lastError || "";
        const lines = wrapText(body, TEXT_COLS);
        const visible = BODY_ROWS;
        for (let i = 0; i < visible; i++) {
            if (i >= lines.length) break;
            print(2, BODY_START_Y + i * LINE_H, lines[i], 1);
        }
    }
}

function drawSeparator() {
    /* Done state has its own divider (the inverted band). Other states get
     * a thin line above the footer. */
    if (state === "done") return;
    draw_line(0, BODY_END_Y, 127, BODY_END_Y, 1);
}

function drawFooter() {
    let hint;
    if (state === "done") {
        hint = "Jog: scroll  Pad: ask";
    } else if (state === "error") {
        hint = "Pad: retry  Back: exit";
    } else if (state === "idle" && activeProvider()) {
        hint = "Back: exit";
    } else {
        hint = "";
    }
    if (hint) print(2, HINT_Y, hint, 1);
}

globalThis.init = function() {
    state = "idle";
    messages = [];
    lastError = "";
    lastErrorDetail = "";
    shortAnswer = "";
    shortLines = [];
    displayLines = [];
    scrollOffset = 0;
    frameCount = 0;
    configChecked = false;
    online = null;
    probeInFlight = false;
    lastProbeFrame = -9999;
    ensureDir();
    cleanupTransientFiles();
    loadConfig();
    /* Build the rich system prompt once per module load. The manuals are
     * read from disk; if either is missing we silently fall back to the
     * core prompt so the assistant still works on a stripped-down install. */
    SYSTEM_PROMPT = buildSystemPrompt();
    /* Mute the system sampler chatter ("Sample saved" etc.) so the screen
     * reader doesn't speak over the user mid-question. */
    if (typeof host_sampler_set_silent === "function") host_sampler_set_silent(true);
    /* Probe for internet right away so the user sees an "Offline" message
     * before they try to record. */
    startConnectivityProbe();
};

globalThis.tick = function() {
    frameCount++;

    if (state === "waiting_record_stop") {
        if (typeof host_sampler_is_recording === "function") {
            if (!host_sampler_is_recording()) {
                startProviderRequest();
            }
        } else {
            startProviderRequest();
        }
    } else if (state === "transcribing" || state === "thinking") {
        pollProviderRequest();
    }

    /* Drive the connectivity probe state machine. */
    if (probeInFlight) pollConnectivityProbe();
    else if (online === false &&
             (frameCount - lastProbeFrame) > PROBE_RE_INTERVAL_FRAMES) {
        startConnectivityProbe();
    }

    /* Re-check provider config periodically while idle so provider/key
     * swaps in the web UI land without needing to exit the module. */
    if (state === "idle" && !activeProvider() && (frameCount % 44) === 0) {
        loadConfig();
    }

    clear_screen();
    drawHeader();
    drawBody();
    drawSeparator();
    drawFooter();
};

globalThis.onMidiMessageInternal = function(data) {
    const status = data[0] & 0xF0;
    const d1 = data[1];
    const d2 = data[2];

    /* Filter capacitive-touch noise (notes 0-9 from knob touches) */
    if ((status === 0x90 || status === 0x80) && d1 < 16) return;

    if (status === 0x90 && d2 > 0) {
        if (d1 >= PAD_TALK_MIN && d1 <= PAD_TALK_MAX) {
            startRecording();
        } else if (d1 === PAD_CLEAR) {
            clearConversation();
        }
    } else if (status === 0x80 || (status === 0x90 && d2 === 0)) {
        if (d1 >= PAD_TALK_MIN && d1 <= PAD_TALK_MAX) {
            stopRecording();
        }
    } else if (status === 0xB0) {
        if (d1 === CC_BACK && d2 > 0) {
            /* Restore default sampler chatter for the next non-tool user. */
            if (typeof host_sampler_set_silent === "function") host_sampler_set_silent(false);
            host_exit_module();
        } else if (d1 === CC_JOG || d1 === CC_KNOB1) {
            /* Move encoders send 1..63 for clockwise, 65..127 for ccw */
            const delta = d2 < 64 ? d2 : d2 - 128;
            if (delta !== 0) scrollOffset += delta > 0 ? 1 : -1;
        }
    }
};
