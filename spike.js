// THROWAWAY SPIKE HARNESS (phase 1, spikes a-d + iPhone storage/photo). Plain ES module, no build, no CDN.
// Holds NO url, token, key or name. URL + token arrive only at runtime (#setup=, setup code, or paste).
// iPhone: home-screen apps do not share storage with Safari, so pairing must happen inside the app.
// Every button appends a record to the log; "Save results" sends the log to the spike backend.

const $ = (id) => document.getElementById(id);
const SS_URL = 'spike.url';
const SS_TOKEN = 'spike.token';
const LS_LAST_LAUNCH = 'spike.lastLaunch'; // non-secret
const LS_MARKER = 'spike.marker'; // non-secret
const SCRIPT_HOST = ['script', 'google', 'com'].join('.');

const MODE = (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true) ? 'app' : 'safari';

// ------------------------------------------------------------------ connection

const conn = { url: sessionStorage.getItem(SS_URL) || '', token: sessionStorage.getItem(SS_TOKEN) || '' };
let setupCode = ''; // raw code from #setup=, kept in memory only so it can be copied into the app

function validUrl(u, suffix = '/exec') {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && x.hostname === SCRIPT_HOST && x.pathname.endsWith(suffix);
  } catch { return false; }
}

function b64urlDecode(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return new TextDecoder().decode(Uint8Array.from(atob(pad), (c) => c.charCodeAt(0)));
}

// Accepts the bare code or a whole link holding #setup=<code>.
function parseSetupCode(raw) {
  let s = String(raw || '').trim();
  const i = s.indexOf('#setup=');
  if (i >= 0) s = s.slice(i + 7);
  const { u, t } = JSON.parse(b64urlDecode(s));
  return { code: s, u: u || '', t: t || '' };
}

function applySetup(raw, method) {
  try {
    const { code, u, t } = parseSetupCode(raw);
    $('connUrl').value = u;
    $('connToken').value = t;
    const ok = useConnection();
    log('S0', 'pairing', { method, ok });
    return ok ? code : '';
  } catch (e) {
    log('S0', 'pairing', { method, ok: false, error: `${e.name}: ${e.message}` });
    setConnStatus('Setup code could not be read. Paste the link and token instead.', true);
    return '';
  }
}

function readSetupHash() {
  const h = location.hash || '';
  if (!h.startsWith('#setup=')) return;
  setupCode = applySetup(h, 'hash');
  history.replaceState(null, '', location.pathname); // never leave the token in the address bar
  if (setupCode && MODE === 'safari') $('safariSetup').hidden = false;
}

async function copySetup() {
  if (!setupCode) return setConnStatus('No setup code. Scan the QR again.', true);
  try {
    await navigator.clipboard.writeText(setupCode);
    log('S0', 'copySetup', { ok: true });
    setConnStatus('Copied. Now Share → Add to Home Screen, then open Phone test.');
  } catch (e) {
    log('S0', 'copySetup', { ok: false, error: `${e.name}: ${e.message}` });
    setConnStatus(`Copy failed: ${e.name}`, true);
  }
}

async function pasteSetup() {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch (e) {
    log('S0', 'pairing', { method: 'clipboard', ok: false, error: `${e.name}: ${e.message}` });
    return setConnStatus('Could not read the clipboard. Paste into the Setup code box instead.', true);
  }
  // Spike only: the code stays on the clipboard so it can be re-pasted after a swipe-away. The real app clears it (01-10).
  applySetup(text, 'clipboard');
}

function useSetupField() {
  if (applySetup($('setupCode').value, 'field')) $('setupCode').value = '';
}

function setConnStatus(msg, bad) {
  const el = $('connStatus');
  el.textContent = msg;
  el.className = bad ? 'status bad' : 'status good';
}

function useConnection() {
  const u = $('connUrl').value.trim();
  const t = $('connToken').value.trim();
  if (!validUrl(u)) { setConnStatus('That link does not look right (must be the /exec link).', true); return false; }
  if (t.length < 32) { setConnStatus('Token too short.', true); return false; }
  conn.url = u; conn.token = t;
  sessionStorage.setItem(SS_URL, u);
  sessionStorage.setItem(SS_TOKEN, t);
  $('connToken').value = '';
  setConnStatus('Connection set. Tap Ping to test.');
  return true;
}

// Simple request: NO headers (text/plain), default credentials. Classifies non-JSON as SERVER_HTML.
async function call(action, payload = {}, opts = {}) {
  const url = opts.url || conn.url;
  const token = opts.token !== undefined ? opts.token : conn.token;
  if (!url) throw new Error('No connection set');
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(url, { method: 'POST', body: JSON.stringify({ token, action, payload }) });
  } catch (err) {
    return { kind: 'NETWORK', ms: Math.round(performance.now() - t0), error: `${err.name}: ${err.message}` };
  }
  const text = await res.text();
  const ms = Math.round(performance.now() - t0);
  const ctype = res.headers.get('content-type');
  let body;
  try { body = JSON.parse(text); } catch {
    return { kind: 'SERVER_HTML', retryable: true, status: res.status, ctype, ms, first300: text.slice(0, 300) };
  }
  return { kind: body.ok ? 'OK' : (body.code || 'ERROR'), status: res.status, ctype, ms, body };
}

// ------------------------------------------------------------------ results log

const records = [];
let savedUpTo = 0;

function log(spike, step, data) {
  const rec = { spike, step, ts: new Date().toISOString(), ua: navigator.userAgent, mode: MODE, data };
  records.push(rec);
  const li = document.createElement('li');
  li.textContent = `${spike} ${step}: ${JSON.stringify(data).slice(0, 400)}`;
  $('logList').prepend(li);
  $('logCount').textContent = `${records.length} results (${records.length - savedUpTo} not saved)`;
  return rec;
}

async function saveResults() {
  const pending = records.slice(savedUpTo);
  if (!pending.length) return setText('saveStatus', 'Nothing new to save.');
  const LIMIT = 150 * 1024;
  const batches = [];
  let cur = []; let size = 0;
  for (const r of pending) {
    const n = JSON.stringify(r).length;
    if (cur.length && size + n > LIMIT) { batches.push(cur); cur = []; size = 0; }
    cur.push(r); size += n;
  }
  if (cur.length) batches.push(cur);
  for (const b of batches) {
    const r = await call('spike.saveResults', { records: b });
    if (r.kind !== 'OK') return setText('saveStatus', `Save failed (${r.kind}). Try again.`);
    savedUpTo += b.length;
  }
  $('logCount').textContent = `${records.length} results (0 not saved)`;
  setText('saveStatus', `Saved ${pending.length} results in ${batches.length} batch(es).`);
}

function setText(id, msg) { $(id).textContent = msg; }

// ------------------------------------------------------------------ IndexedDB

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('spike', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('chunks'); // key [recId, seq]
        d.createObjectStore('recordings', { keyPath: 'id' });
        d.createObjectStore('markers', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function idb(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ------------------------------------------------------------------ S1 mic
// NOTE: spikes/gas/mic.html holds a COPY of TYPES/AUTO/deviceInfo/typeSupport/pickMime/permState and a simpler record.

const TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
const AUTO = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
const FORCED = { mp4: ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'], webm: ['audio/webm;codecs=opus', 'audio/webm'] };
const takes = {}; // label -> { blob, mimeType, ms, chunks, bytes }
let active = null;

const supported = (t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t);

async function deviceInfo() {
  const info = { ua: navigator.userAgent, mode: MODE, standalone: navigator.standalone === true };
  if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
    try { info.uaData = await navigator.userAgentData.getHighEntropyValues(['model', 'platformVersion', 'fullVersionList']); } catch (e) { info.uaDataError = e.message; }
  }
  return info;
}

function typeSupport() {
  const out = {};
  for (const t of TYPES) out[t] = supported(t);
  return out;
}

function pickMime(format = 'auto') {
  return (FORCED[format] || AUTO).find(supported) || '';
}

async function permState() {
  try { return (await navigator.permissions.query({ name: 'microphone' })).state; } catch (e) { return `unknown (${e.name})`; }
}

async function startRecording(label, { onChunk } = {}) {
  if (active) throw new Error('Already recording');
  const format = $('formatSel').value;
  const mimeType = pickMime(format);
  if (format !== 'auto' && !mimeType) {
    log('S1', 'formatUnsupported', { label, format, typeSupport: typeSupport() });
    throw new Error(`${format} is not supported on this phone`);
  }
  const before = await permState();
  const t0 = performance.now();
  const events = [];
  const ev = (name, extra) => events.push({ t: Math.round(performance.now() - t0), ev: name, ...extra });
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    log('S1', 'micError', { label, name: e.name, message: e.message, permBefore: before, getUserMediaMs: Math.round(performance.now() - t0) });
    throw e;
  }
  const getUserMediaMs = Math.round(performance.now() - t0);
  const track = stream.getAudioTracks()[0];
  if (track) for (const n of ['mute', 'unmute', 'ended']) track.addEventListener(n, () => ev(`track.${n}`));
  const rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 });
  const recId = `${label}-${Date.now()}`;
  await idb('recordings', 'readwrite', (s) => s.put({ id: recId, label, mimeType: rec.mimeType || mimeType, startedAt: new Date().toISOString() }));
  const chunks = []; const chunkTimes = [];
  let seq = 0;
  const tStart = performance.now();
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) {
      chunks.push(e.data); chunkTimes.push(Math.round(performance.now() - tStart));
      const n = seq++;
      idb('chunks', 'readwrite', (s) => s.put(e.data, [recId, n])).catch((err) => ev('idbError', { seq: n, message: err && err.message }));
    }
    if (onChunk) onChunk(chunks.length);
  };
  rec.onpause = () => ev('rec.pause');
  rec.onresume = () => ev('rec.resume');
  rec.onerror = (e) => ev('rec.error', { name: e.error && e.error.name, message: e.error && e.error.message });
  const onVis = () => {
    ev(`visibility.${document.visibilityState}`);
    if (document.visibilityState === 'hidden' && rec.state === 'recording') { try { rec.requestData(); } catch (e) { ev('requestDataError', { message: e.message }); } }
  };
  const onHide = () => ev('pagehide');
  const onShow = () => ev('pageshow');
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', onHide);
  window.addEventListener('pageshow', onShow);
  const done = new Promise((resolve) => {
    rec.onstop = async () => {
      ev('rec.stop');
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
      stream.getTracks().forEach((tr) => tr.stop());
      const ms = Math.round(performance.now() - tStart);
      const blob = new Blob(chunks, { type: rec.mimeType || mimeType });
      const bytes = blob.size;
      const gaps = [];
      for (let i = 1; i < chunkTimes.length; i++) { const g = chunkTimes[i] - chunkTimes[i - 1]; if (g > 1500) gaps.push({ at: chunkTimes[i - 1], gapMs: g }); }
      const result = { label, recId, format, requested: mimeType, actualMimeType: rec.mimeType, audioBitsPerSecond: 32000,
        chunks: chunks.length, ms, bytes, bytesPerMin: Math.round(bytes / (ms / 60000)), permBefore: before,
        permAfter: await permState(), getUserMediaMs, finalState: rec.state,
        trackState: track && track.readyState, wakeLock: wakeLock ? 'held' : 'none', gaps, events, chunkTimes };
      takes[label] = { blob, mimeType: rec.mimeType || mimeType, ms, chunks: chunks.length, bytes };
      resolve(result);
    };
  });
  rec.start(1000);
  ev('rec.start', { mimeType: rec.mimeType });
  active = { rec, label, done };
  return active;
}

async function stopRecording(step = 'recording') {
  if (!active) return null;
  const a = active; active = null;
  // inactive here means iOS stopped the recorder itself (lock, call); its onstop already ran.
  const stoppedBy = a.rec.state === 'inactive' ? 'system' : 'button';
  if (stoppedBy === 'button') a.rec.stop();
  const result = { ...(await a.done), stoppedBy };
  log('S1', step, result);
  return result;
}

async function onRecordButton(label, btn) {
  if (active && active.label === label) {
    const r = await stopRecording();
    btn.textContent = btn.dataset.text;
    $('playback').src = URL.createObjectURL(takes[label].blob);
    setText('micStatus', `Stopped. ${r.chunks} chunks, ${(r.bytes / 1024).toFixed(0)} KB, ${r.actualMimeType}. Tap play to check it.`);
    refreshTakeOptions();
    return;
  }
  try {
    await startRecording(label, { onChunk: (n) => setText('micStatus', `Recording "${btn.dataset.text}"... ${n} s`) });
    btn.textContent = 'Stop';
  } catch (e) {
    setText('micStatus', `Mic failed: ${e.name} - ${e.message}`);
  }
}

async function micFacts() {
  const facts = { device: await deviceInfo(), typeSupport: typeSupport(), picked: pickMime(), perm: await permState(),
    mediaRecorder: typeof MediaRecorder !== 'undefined', speechRecognition: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
    clipboardRead: !!(navigator.clipboard && navigator.clipboard.readText), storagePersistApi: !!(navigator.storage && navigator.storage.persist),
    wakeLock: 'wakeLock' in navigator, barcodeDetector: 'BarcodeDetector' in window };
  if (navigator.storage) {
    try { facts.storagePersisted = await navigator.storage.persisted(); } catch (e) { facts.storagePersistedError = e.message; }
    try { facts.storageEstimate = await navigator.storage.estimate(); } catch (e) { facts.storageEstimateError = e.message; }
  }
  log('S1', 'facts', facts);
  setText('micStatus', `Phone info saved. Auto format: ${facts.picked || 'none'}`);
}

// 60 s timed test. Lock: press the side button, wait, unlock. Call: have someone ring the phone, or switch apps.
async function interruptTest(step, prompt) {
  setText('micStatus', prompt);
  try { await startRecording(step); } catch (e) { return setText('micStatus', `Mic failed: ${e.name}`); }
  await new Promise((r) => setTimeout(r, 60000));
  const r = await stopRecording(step);
  if (!r) return;
  refreshTakeOptions();
  $('playback').src = URL.createObjectURL(takes[step].blob);
  const early = r.stoppedBy === 'system' || r.events.some((e) => e.ev === 'track.ended');
  setText('micStatus', `${step}: ${r.chunks} chunks, ${(r.ms / 1000).toFixed(0)} s, ${r.gaps.length} gap(s)${early ? ', stopped early' : ''}. Play it back.`);
}

async function recoverLast() {
  const all = await idb('recordings', 'readonly', (s) => s.getAll());
  if (!all || !all.length) return setText('micStatus', 'Nothing saved on the phone yet.');
  all.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const meta = all[all.length - 1];
  const keys = await idb('chunks', 'readonly', (s) => s.getAllKeys(IDBKeyRange.bound([meta.id, 0], [meta.id, Infinity])));
  const parts = await idb('chunks', 'readonly', (s) => s.getAll(IDBKeyRange.bound([meta.id, 0], [meta.id, Infinity])));
  const blob = new Blob(parts || [], { type: meta.mimeType });
  const audio = $('playback');
  const playable = await new Promise((resolve) => {
    const tid = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 5000);
    audio.onloadedmetadata = () => { clearTimeout(tid); resolve({ ok: true, duration: audio.duration }); };
    audio.onerror = () => { clearTimeout(tid); resolve({ ok: false, error: audio.error && audio.error.code }); };
    audio.src = URL.createObjectURL(blob);
  });
  takes.recovered = { blob, mimeType: meta.mimeType, ms: 0, chunks: (keys || []).length, bytes: blob.size };
  refreshTakeOptions();
  log('S1', 'recover', { recId: meta.id, label: meta.label, mimeType: meta.mimeType, chunks: (keys || []).length, bytes: blob.size, playable });
  setText('micStatus', `Recovered "${meta.label}": ${(keys || []).length} chunks, ${(blob.size / 1024).toFixed(0)} KB, playable: ${playable.ok}.`);
}

let wakeLock = null;
let wakeWanted = false;
async function acquireWake() {
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    log('S1', 'wakeLock', { request: 'ok' });
    wakeLock.addEventListener('release', () => { log('S1', 'wakeLock', { released: true, visibility: document.visibilityState }); wakeLock = null; });
  } catch (e) {
    log('S1', 'wakeLock', { request: 'error', name: e.name, message: e.message });
  }
}

async function toggleWake(btn) {
  if (!('wakeLock' in navigator)) { log('S1', 'wakeLock', { api: false }); return setText('micStatus', 'Keep-awake is not available here.'); }
  wakeWanted = !wakeWanted;
  if (wakeWanted) await acquireWake(); else if (wakeLock) await wakeLock.release();
  btn.textContent = `Keep screen awake: ${wakeWanted ? (wakeLock ? 'on' : 'failed') : 'off'}`;
}

async function logLaunch() {
  let last = null;
  try { last = Number(localStorage.getItem(LS_LAST_LAUNCH)) || null; localStorage.setItem(LS_LAST_LAUNCH, String(Date.now())); } catch { /* private mode */ }
  log('S1', 'launch', { perm: await permState(), msSinceLastLaunch: last ? Date.now() - last : null });
}

// ------------------------------------------------------------------ S2 send to Gemini

function refreshTakeOptions() {
  const sel = $('takeSel');
  sel.innerHTML = '';
  for (const label of Object.keys(takes)) {
    const o = document.createElement('option');
    o.value = label; o.textContent = `${label} (${(takes[label].bytes / 1024).toFixed(0)} KB, ${takes[label].mimeType})`;
    sel.appendChild(o);
  }
}

async function blobToB64(blob) {
  const u8 = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  const STEP = 0x8000;
  for (let i = 0; i < u8.length; i += STEP) s += String.fromCharCode.apply(null, u8.subarray(i, i + STEP));
  return btoa(s);
}

async function sendToGemini(label, key) {
  const take = takes[label];
  if (!take) return setText('geminiStatus', 'Record a take first.');
  const model = $('modelSel').value;
  const variant = Number($('variantSel').value);
  const thinking = $('thinkingSel').value || undefined;
  setText('geminiStatus', `Sending ${label} to ${model} (variant ${variant})... this can take up to a minute.`);
  const b64 = await blobToB64(take.blob);
  const r = await call('spike.gemini', { b64, mime: take.mimeType, label, model, variant, thinking, key });
  const d = r.body && r.body.data;
  log('S2', key === 'live' ? 'philippinesKeyCheck' : 'send', { label, mime: take.mimeType, model, variant, thinking: thinking || null, key: key || 'dev',
    clientMs: r.ms, kind: r.kind, status: d && d.status, fetchMs: d && d.fetchMs, totalMs: d && d.totalMs,
    parsedOk: d && d.parsedOk, finishReason: d && d.finishReason, fileId: d && d.fileId, error: r.body && r.body.message, first300: r.first300 });
  if (d) {
    setText('geminiStatus', `HTTP ${d.status} - Gemini ${d.fetchMs} ms, total ${d.totalMs} ms, phone ${r.ms} ms, JSON OK: ${d.parsedOk}`);
    $('geminiOut').textContent = JSON.stringify(d.result || d.errorFirst2k || d.fetchException || d, null, 2);
  } else {
    setText('geminiStatus', `Failed: ${r.kind} ${r.body ? r.body.message : r.error || ''}`);
  }
}

// ------------------------------------------------------------------ S3 keyboard dictation

const FIELDS = [['amTask', 'Morning Task'], ['amDetails', 'Morning Details'], ['pmTask', 'Afternoon Task'], ['pmDetails', 'Afternoon Details']];

function setupVoiceTyping() {
  for (const [id] of FIELDS) {
    const ta = $(id);
    let focusAt = 0;
    ta.addEventListener('focus', () => { focusAt = performance.now(); });
    ta.addEventListener('blur', () => {
      if (focusAt) log('S3', 'fieldTime', { field: id, ms: Math.round(performance.now() - focusAt), chars: ta.value.length, text: ta.value });
      focusAt = 0;
    });
    $(`${id}Dictate`).addEventListener('click', () => dictate(id));
  }
}

function dictate(id) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { log('S3', 'webSpeech', { available: false }); return setText('s3Status', 'Safari speech is not available here.'); }
  const r = new SR();
  r.lang = 'en-PH';
  r.interimResults = true;
  const t0 = performance.now();
  let finalText = '';
  r.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      if (ev.results[i].isFinal) finalText += ev.results[i][0].transcript; else interim += ev.results[i][0].transcript;
    }
    $(id).value = (finalText + interim).trim();
  };
  r.onerror = (ev) => log('S3', 'dictateError', { field: id, error: ev.error, message: ev.message, ms: Math.round(performance.now() - t0) });
  r.onend = () => { log('S3', 'dictate', { field: id, finalText, endMs: Math.round(performance.now() - t0) }); setText('s3Status', 'Dictation stopped.'); };
  try { r.start(); } catch (e) { log('S3', 'dictateError', { field: id, error: e.name, message: e.message }); return setText('s3Status', `Dictate failed: ${e.name}`); }
  setText('s3Status', 'Listening (en-PH)... speak now.');
}

async function speechAvailability() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const out = { hasSR: !!SR, hasAvailable: !!(SR && SR.available) };
  if (SR && SR.available) {
    try { out.available = await SR.available({ langs: ['en-PH'], processLocally: true }); } catch (e) { out.error = `${e.name}: ${e.message}`; }
  }
  log('S3', 'speechAvailable', out);
  setText('s3Status', `Safari speech: ${out.hasSR ? 'present' : 'missing'}.`);
}

let dayStart = 0;
function stopwatch() {
  const btn = $('dayTimer');
  if (!dayStart) { dayStart = performance.now(); btn.textContent = 'Stop full-day timer'; return; }
  const ms = Math.round(performance.now() - dayStart);
  dayStart = 0; btn.textContent = 'Start full-day timer';
  log('S3', 'fullDayTime', { ms });
  setText('s3Status', `Full day took ${(ms / 1000).toFixed(0)} s.`);
}

function saveChecks() {
  log('S3', 'checks', { keyboardMicAll4: $('chkKbMic').checked, punctuationOk: $('chkPunct').checked,
    airplaneOk: $('chkAirplane').checked, worksInApp: $('chkInApp').checked, dictationLanguage: $('dictLang').value });
  setText('s3Status', 'Checks added to results.');
}

// ------------------------------------------------------------------ S4 transport

function randomB64(mb) {
  const raw = new Uint8Array(Math.floor(mb * 1024 * 1024 * 0.75));
  for (let i = 0; i < raw.length; i += 65536) crypto.getRandomValues(raw.subarray(i, i + 65536));
  let s = '';
  for (let i = 0; i < raw.length; i += 0x8000) s += String.fromCharCode.apply(null, raw.subarray(i, i + 0x8000));
  return btoa(s);
}

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const network = () => $('networkSel').value;

async function sizeTest(mb) {
  setText('s4Status', `Sending ${mb} MB...`);
  const b64 = randomB64(mb);
  const want = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(b64)));
  const r = await call('spike.echo', { b64 });
  const d = r.body && r.body.data;
  const rec = { mb, network: network(), chars: b64.length, kind: r.kind, status: r.status, ms: r.ms,
    match: !!(d && d.sha256 === want), receivedChars: d && d.receivedChars, error: r.error, first300: r.first300 };
  log('S4', 'size', rec);
  setText('s4Status', `${mb} MB: ${rec.kind}, ${rec.ms} ms, hash match: ${rec.match}`);
}

async function allSizes() { for (const mb of [0.1, 1.6, 2, 7, 12]) await sizeTest(mb); }

async function wrongToken() {
  const r = await call('ping', {}, { token: '0'.repeat(64) });
  log('S4', 'wrongToken', { network: network(), kind: r.kind, status: r.status, ctype: r.ctype, ms: r.ms, expectAUTH: r.kind === 'AUTH' });
  setText('s4Status', `Wrong token -> ${r.kind} (expected AUTH)`);
}

async function throwUncaught() {
  const r = await call('spike.throwUncaught');
  log('S4', 'throwUncaught', { network: network(), kind: r.kind, status: r.status, ctype: r.ctype, ms: r.ms, first300: r.first300, isServerHtml: r.kind === 'SERVER_HTML' });
  setText('s4Status', `Uncaught error -> ${r.kind} (expected SERVER_HTML)`);
}

async function devUrlTest() {
  const u = $('devUrl').value.trim();
  if (!validUrl(u, '/dev')) return setText('s4Status', 'Paste the /dev link first.');
  const r = await call('ping', {}, { url: u });
  log('S4', 'devUrl', { network: network(), kind: r.kind, status: r.status, ctype: r.ctype, ms: r.ms, first300: r.first300, error: r.error });
  setText('s4Status', `/dev link -> ${r.kind}`);
}

async function pingTimes() {
  const times = [];
  for (let i = 0; i < 5; i++) { const r = await call('ping'); times.push({ n: i + 1, kind: r.kind, ms: r.ms }); }
  log('S4', 'pingX5', { network: network(), times, coldMs: times[0].ms });
  setText('s4Status', `Ping x5: ${times.map((t) => t.ms).join(', ')} ms`);
}

async function ping() {
  const r = await call('ping');
  const d = r.body && r.body.data;
  log('S4', 'ping', { kind: r.kind, ms: r.ms, tz: d && d.tz });
  setText('connStatus', d ? `Connected. Owner: ${d.owner}, time zone: ${d.tz} (${r.ms} ms)` : `Ping failed: ${r.kind}`);
}

// ------------------------------------------------------------------ S6 storage

async function storageFacts() {
  const out = {};
  if (!navigator.storage) return { api: false };
  try { out.persisted = await navigator.storage.persisted(); } catch (e) { out.persistedError = e.message; }
  try { const est = await navigator.storage.estimate(); out.usage = est.usage; out.quota = est.quota; } catch (e) { out.estimateError = e.message; }
  return out;
}

async function persistAsk() {
  let granted = null; let error;
  try { granted = await navigator.storage.persist(); } catch (e) { error = `${e.name}: ${e.message}`; }
  const facts = await storageFacts();
  log('S6', 'persist', { granted, error, ...facts });
  setText('s6Status', `Keep data: ${granted === null ? `error ${error}` : granted ? 'yes' : 'no'}. Persisted now: ${facts.persisted}`);
}

async function writeMarker() {
  const raw = new Uint8Array(1024 * 1024);
  for (let i = 0; i < raw.length; i += 65536) crypto.getRandomValues(raw.subarray(i, i + 65536));
  const writtenAt = new Date().toISOString();
  await idb('markers', 'readwrite', (s) => s.put({ id: 'marker', writtenAt, mode: MODE, blob: new Blob([raw]) }));
  let ls = true;
  try { localStorage.setItem(LS_MARKER, writtenAt); } catch { ls = false; }
  log('S6', 'write', { writtenAt, idbBytes: raw.length, lsWritten: ls });
  setText('s6Status', 'Test data written. Now swipe the app away and open it again.');
}

async function checkMarker() {
  const m = await idb('markers', 'readonly', (s) => s.get('marker'));
  let lsVal = null;
  try { lsVal = localStorage.getItem(LS_MARKER); } catch { /* blocked */ }
  const facts = await storageFacts();
  const out = { idbFound: !!m, idbBytes: m && m.blob ? m.blob.size : 0, idbWrittenIn: m && m.mode, lsFound: !!lsVal,
    ageMinutes: m ? Math.round((Date.now() - Date.parse(m.writtenAt)) / 60000) : null, persisted: facts.persisted, usage: facts.usage };
  log('S6', 'check', out);
  setText('s6Status', `IndexedDB: ${out.idbFound ? `found (${out.ageMinutes} min old)` : 'not found'}; local: ${out.lsFound ? 'found' : 'not found'}.`);
}

// ------------------------------------------------------------------ S7 photo (stays on the phone)

async function decodeImage(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall back */ }
  }
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode();
  return img;
}

async function onPhoto(input, source) {
  const file = input.files && input.files[0];
  if (!file) return;
  const info = { source, type: file.type, nameExt: (file.name.split('.').pop() || '').toLowerCase(), bytes: file.size, lastModified: file.lastModified };
  const t0 = performance.now();
  try {
    const bmp = await decodeImage(file);
    const sw = bmp.width || bmp.naturalWidth; const sh = bmp.height || bmp.naturalHeight;
    const scale = Math.min(1, 1600 / Math.max(sw, sh));
    const w = Math.round(sw * scale); const h = Math.round(sh * scale);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
    Object.assign(info, { outType: out && out.type, outBytes: out && out.size, w, h, srcW: sw, srcH: sh, decodeMs: Math.round(performance.now() - t0) });
    if (out) $('photoPreview').src = URL.createObjectURL(out);
    setText('s7Status', `${info.type || 'unknown type'} ${(info.bytes / 1024).toFixed(0)} KB → JPEG ${w}×${h}, ${(info.outBytes / 1024).toFixed(0)} KB.`);
  } catch (e) {
    info.error = `${e.name}: ${e.message}`;
    setText('s7Status', `Photo failed: ${info.error}`);
  }
  log('S7', 'photo', info);
  input.value = '';
}

function savePhotoChecks() {
  log('S7', 'checks', { upright: $('chkUpright').checked, coloursOk: $('chkColours').checked });
  setText('s7Status', 'Photo checks added to results.');
}

// ------------------------------------------------------------------ wiring

function on(id, fn) {
  $(id).addEventListener('click', async (ev) => {
    const btn = ev.currentTarget; btn.disabled = true;
    try { await fn(btn); } catch (e) { log('ERR', id, { name: e.name, message: e.message }); } finally { btn.disabled = false; }
  });
}

function init() {
  const banner = $('modeBanner');
  banner.textContent = `Running in: ${MODE === 'app' ? 'home-screen app' : 'Safari tab'}`;
  banner.className = `mode ${MODE}`;
  on('copySetup', copySetup);
  on('pasteSetup', pasteSetup);
  on('useSetup', useSetupField);
  on('connUse', useConnection);
  on('connPing', ping);
  on('saveResults', saveResults);
  on('micFacts', micFacts);
  on('wakeToggle', toggleWake);
  for (const id of ['rec1min', 'rec5min', 'recNatural']) {
    const btn = $(id); btn.dataset.text = btn.textContent;
    btn.addEventListener('click', () => onRecordButton(btn.dataset.label, btn));
  }
  on('lockTest', () => interruptTest('lockScreen60s', 'Recording 60 s. Lock the phone now (side button), wait 20 s, then unlock.'));
  on('callTest', () => interruptTest('callSwitch60s', 'Recording 60 s. Have someone call this phone, or switch to another app for 20 s, then come back.'));
  on('recoverLast', recoverLast);
  on('sendGemini', () => sendToGemini($('takeSel').value));
  on('phKeyCheck', () => sendToGemini('oneMin', 'live'));
  setupVoiceTyping();
  on('speechAvail', speechAvailability);
  $('dayTimer').addEventListener('click', stopwatch);
  on('saveChecks', saveChecks);
  for (const btn of document.querySelectorAll('[data-mb]')) on(btn.id, () => sizeTest(Number(btn.dataset.mb)));
  on('allSizes', allSizes);
  on('wrongToken', wrongToken);
  on('throwUncaught', throwUncaught);
  on('devTest', devUrlTest);
  on('pingX5', pingTimes);
  on('persistAsk', persistAsk);
  on('writeMarker', writeMarker);
  on('checkMarker', checkMarker);
  $('photoCam').addEventListener('change', () => onPhoto($('photoCam'), 'camera'));
  $('photoLib').addEventListener('change', () => onPhoto($('photoLib'), 'library'));
  on('savePhotoChecks', savePhotoChecks);
  document.addEventListener('visibilitychange', () => { if (wakeWanted && !wakeLock && document.visibilityState === 'visible') acquireWake(); });
  readSetupHash();
  if (conn.url && !setupCode) setConnStatus('Connection remembered for this session. Tap Ping to test.');
  logLaunch();
}

init();
