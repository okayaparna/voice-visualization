// Voice Studio
//
// An internal tool for tuning the voice "string": the line that moves with
// Ash's voice and the user's voice. Three sources drive the same pipeline:
// the ElevenLabs text-to-speech API, the microphone, and scripted edge cases.
//
// Pipeline: source level -> noise gate -> attack/release envelope -> string
// energy -> spring physics on a handful of points -> smooth curve.
// Word timings (from ElevenLabs alignment, speech recognition or the script)
// "pluck" the string so it reacts to words, not just loudness.

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const API = 'https://api.elevenlabs.io/v1';
  const TIMEOUT_MS = 15000;
  const STAGE_BG = '#1b1a18';
  const ERROR_GREY = [85, 82, 77];
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  // ---------------------------------------------------------------------------
  // Parameters
  // ---------------------------------------------------------------------------

  const PARAMS = [
    { group: 'Look', key: 'thickness', label: 'Thickness', min: 4, max: 80, step: 1, def: 38 },
    { group: 'Look', key: 'speakColor', label: 'Ash color', type: 'color', def: '#87527a' },
    { group: 'Look', key: 'listenColor', label: 'User color', type: 'color', def: '#8a9e98' },
    { group: 'Look', key: 'span', label: 'Width', min: 0.3, max: 0.95, step: 0.01, def: 0.74 },
    { group: 'Look', key: 'swell', label: 'Swell', min: 0, max: 1, step: 0.01, def: 0.2 },
    { group: 'Shape', key: 'points', label: 'Points', min: 4, max: 16, step: 1, def: 9 },
    { group: 'Shape', key: 'complexity', label: 'Complexity', min: 0.1, max: 2, step: 0.01, def: 0.9 },
    { group: 'Shape', key: 'loop', label: 'Loopiness', min: 0, max: 1.5, step: 0.01, def: 0.55 },
    { group: 'Motion', key: 'idle', label: 'Idle motion', min: 0, max: 0.5, step: 0.01, def: 0.1 },
    { group: 'Motion', key: 'speed', label: 'Speed', min: 0.1, max: 3, step: 0.01, def: 0.9 },
    { group: 'Motion', key: 'tension', label: 'Tension', min: 0.01, max: 0.3, step: 0.005, def: 0.07 },
    { group: 'Motion', key: 'damping', label: 'Damping', min: 0.5, max: 0.98, step: 0.01, def: 0.84 },
    { group: 'Response', key: 'reactivity', label: 'Reactivity', min: 0, max: 3, step: 0.01, def: 1.1 },
    { group: 'Response', key: 'gate', label: 'Noise gate', min: 0, max: 0.3, step: 0.005, def: 0.06 },
    { group: 'Response', key: 'attack', label: 'Attack', min: 0.02, max: 1, step: 0.01, def: 0.45 },
    { group: 'Response', key: 'release', label: 'Release', min: 0.01, max: 0.5, step: 0.01, def: 0.06 },
    { group: 'Response', key: 'pluck', label: 'Word pluck', min: 0, max: 2, step: 0.01, def: 0.6 },
  ];

  const DEFAULTS = Object.fromEntries(PARAMS.map((p) => [p.key, p.def]));

  const LOOKS = {
    'Ash default': {},
    Calm: { idle: 0.06, speed: 0.5, reactivity: 0.7, tension: 0.04, damping: 0.9, loop: 0.3, pluck: 0.2, swell: 0.1 },
    Expressive: { reactivity: 1.8, loop: 1.0, speed: 1.4, pluck: 1.2, complexity: 1.3, swell: 0.4 },
    'Minimal line': { thickness: 10, loop: 0, complexity: 0.5, points: 6, swell: 0, idle: 0.04 },
  };

  const VOICE_PARAMS = [
    { key: 'stability', label: 'Stability', min: 0, max: 1, step: 0.05, def: 0.5 },
    { key: 'similarity_boost', label: 'Similarity', min: 0, max: 1, step: 0.05, def: 0.75 },
    { key: 'speed', label: 'Speed', min: 0.7, max: 1.2, step: 0.05, def: 1.0 },
  ];

  const DEFAULT_VOICES = [
    { voice_id: '21m00Tcm4TlvDq8nTOdx', name: 'Rachel (default)' },
    { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah (default)' },
    { voice_id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam (default)' },
    { voice_id: 'ErXwobaYiN019PkySvjV', name: 'Antoni (default)' },
  ];

  // Each failure has two audiences: the product user, and the team using the studio.
  const ERRORS = {
    'no-key': { title: 'No API key', product: null, team: 'Add an ElevenLabs API key in the Voice API tab.' },
    'invalid-key': { title: 'API key rejected', product: "Ash's voice isn't available right now. You can keep going in text.", team: 'ElevenLabs returned 401. Check the key and that it has text-to-speech access.' },
    quota: { title: 'Out of credits', product: "Ash's voice isn't available right now. You can keep going in text.", team: 'The account has run out of character credits.' },
    'rate-limit': { title: 'Too many requests', product: 'One moment…  (retry quietly, then fall back to text)', team: 'ElevenLabs returned 429: too many requests or concurrent streams.' },
    timeout: { title: 'No audio in time', product: "Ash is taking longer than usual. You can keep going in text.", team: `No response within ${TIMEOUT_MS / 1000}s.` },
    network: { title: "Couldn't reach ElevenLabs", product: "You're offline. Ash will reply in text until you're back.", team: 'The request never reached the API: offline, blocked by an extension, or a CORS failure.' },
    'bad-request': { title: 'Request rejected', product: "Ash's voice isn't available right now. You can keep going in text.", team: 'The API rejected the request (400/422), e.g. text too long or a bad setting.' },
    server: { title: 'ElevenLabs error', product: "Ash's voice isn't available right now. You can keep going in text.", team: 'The API returned a server error (5xx).' },
    decode: { title: "Couldn't play the audio", product: "Ash's voice isn't available right now. You can keep going in text.", team: 'The response arrived but the audio could not be decoded.' },
    'mic-denied': { title: 'Microphone blocked', product: "Ash can't hear you. Allow microphone access in your browser settings.", team: 'getUserMedia was denied.' },
    'mic-missing': { title: 'No microphone', product: "Ash can't hear you. Connect a microphone and try again.", team: 'No input device, or it is in use by another app.' },
  };

  const P = loadParams();
  const voiceSettings = Object.fromEntries(VOICE_PARAMS.map((p) => [p.key, p.def]));

  // ---------------------------------------------------------------------------
  // Session state
  // ---------------------------------------------------------------------------

  const S = {
    state: 'idle',
    detail: '',
    source: null, // 'tts' | 'mic' | 'case' | 'preview'
    raw: 0,
    energy: 0,
    clip: false,
    errorAmt: 0,
    color: hexToRgb(P.speakColor),
    utterances: [], // [{ speaker, words: [{ w, t }] }]
    words: [], // flattened, sorted by time, for plucks
    wordIdx: 0,
    pluckCursor: 0,
    clock: () => 0,
    level: () => 0,
    caseRun: null,
  };

  const metrics = { requests: 0, cacheHits: 0 };

  function setState(state, detail = '') {
    if (S.state !== state || S.detail !== detail) log(`${S.state} → ${state}${detail ? ' · ' + detail : ''}`);
    S.state = state;
    S.detail = detail;
    const pill = $('#statePill');
    pill.dataset.state = state;
    pill.textContent = state[0].toUpperCase() + state.slice(1);
    $('#stateDetail').textContent = detail;
    if (state !== 'error') $('#errorCard').hidden = true;
    document.querySelectorAll('[data-preview]').forEach((b) => {
      b.classList.toggle('active', S.source === 'preview' && b.dataset.preview === state);
    });
  }

  function fail(kind, teamDetail = '') {
    const e = ERRORS[kind] || ERRORS.server;
    stopSources();
    setState('error', e.title);
    log(`${kind}${teamDetail ? ': ' + teamDetail : ''}`, 'err');
    const card = $('#errorCard');
    card.innerHTML = `
      <h3>${escapeHtml(e.title)}</h3>
      ${e.product ? `<p><b>Product:</b> ${escapeHtml(e.product)}</p>` : ''}
      <p class="dev">Team: ${escapeHtml(e.team)}${teamDetail ? '<br>' + escapeHtml(teamDetail) : ''}</p>`;
    card.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Audio
  // ---------------------------------------------------------------------------

  let actx = null;
  let analyser = null;
  let sampleBuf = null;

  function audio() {
    if (!actx) {
      actx = new AudioContext();
      analyser = actx.createAnalyser();
      analyser.fftSize = 1024;
      sampleBuf = new Float32Array(analyser.fftSize);
    }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }

  function analyserLevel() {
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(sampleBuf);
    let sum = 0;
    for (let i = 0; i < sampleBuf.length; i++) sum += sampleBuf[i] * sampleBuf[i];
    return Math.sqrt(sum / sampleBuf.length) * 4;
  }

  // ---------------------------------------------------------------------------
  // Source: ElevenLabs text-to-speech with timestamps
  // ---------------------------------------------------------------------------

  const cache = new Map();
  let inflight = null;
  let ttsNode = null;

  function getKey() {
    return $('#apiKey').value.trim();
  }

  async function connect() {
    const key = getKey();
    if (!key) return fail('no-key');
    saveKey(key);
    setApiStatus('checking', 'Checking key…');
    try {
      const res = await fetch(`${API}/voices`, { headers: { 'xi-api-key': key } });
      if (!res.ok) {
        const d = await readError(res);
        // A key restricted to text-to-speech can't list voices but still works.
        if (res.status === 401 && /permission/i.test(d.status || d.message || '')) {
          setApiStatus('ok', 'Connected · default voices only');
          log('key can’t list voices; using defaults', 'ok');
          return;
        }
        setApiStatus('error', `Key rejected (${res.status})`);
        log(`GET /voices ${res.status} ${d.status || d.message || ''}`, 'err');
        return;
      }
      const data = await res.json();
      const voices = (data.voices || []).map((v) => ({ voice_id: v.voice_id, name: v.name }));
      if (voices.length) fillVoices(voices);
      setApiStatus('ok', `Connected · ${voices.length} voices`);
      log(`GET /voices 200 · ${voices.length} voices`, 'ok');
    } catch (err) {
      setApiStatus('error', 'Could not reach ElevenLabs');
      log(`GET /voices failed: ${err.message}`, 'err');
    }
  }

  async function speak() {
    stopAll();
    const text = $('#ttsText').value.trim();
    if (!text) return;
    const key = getKey();
    if (!key) return fail('no-key');
    saveKey(key);

    const voiceId = $('#voiceSelect').value;
    const body = {
      text,
      model_id: $('#modelSelect').value,
      voice_settings: { ...voiceSettings },
    };
    const cacheKey = JSON.stringify([voiceId, body]);
    const t0 = performance.now();
    setState('thinking', 'waiting for audio');

    let result = cache.get(cacheKey);
    if (result) {
      metrics.cacheHits++;
      log('cache hit · no credits used', 'ok');
    } else {
      metrics.requests++;
      const ctrl = new AbortController();
      inflight = ctrl;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, TIMEOUT_MS);
      log(`POST /text-to-speech/${voiceId.slice(0, 6)}…/with-timestamps · ${text.length} chars`);
      try {
        const res = await fetch(`${API}/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
          method: 'POST',
          headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (inflight !== ctrl) return;
        if (!res.ok) {
          const d = await readError(res);
          return fail(classify(res.status, d), `${res.status} ${d.status || ''} ${d.message || ''}`.trim());
        }
        const json = await res.json();
        if (inflight !== ctrl) return;
        let audioBuf;
        try {
          audioBuf = await audio().decodeAudioData(base64ToBytes(json.audio_base64).buffer);
        } catch (err) {
          return fail('decode', err.message);
        }
        result = { audioBuf, words: wordsFromAlignment(json.alignment || json.normalized_alignment) };
        cache.set(cacheKey, result);
      } catch (err) {
        if (inflight !== ctrl) return; // cancelled by the user
        return fail(timedOut ? 'timeout' : 'network', err.message);
      } finally {
        clearTimeout(timer);
        if (inflight === ctrl) inflight = null;
      }
    }

    const tta = performance.now() - t0;
    $('#mTTA').textContent = `${Math.round(tta)}ms`;
    $('#mLen').textContent = `${result.audioBuf.duration.toFixed(1)}s`;
    log(`audio ready in ${Math.round(tta)}ms · ${result.words.length} words`, 'ok');
    play(result);
  }

  function play({ audioBuf, words }) {
    const ctx = audio();
    const node = ctx.createBufferSource();
    node.buffer = audioBuf;
    node.connect(analyser);
    node.connect(ctx.destination);
    const startAt = ctx.currentTime + 0.05;
    node.start(startAt);
    node.onended = () => {
      if (ttsNode !== node) return;
      ttsNode = null;
      S.source = null;
      setState('idle', 'finished speaking');
    };
    ttsNode = node;
    S.source = 'tts';
    S.clock = () => ctx.currentTime - startAt;
    S.level = analyserLevel;
    setWords([{ speaker: 'Ash', words }]);
    const voiceName = $('#voiceSelect').selectedOptions[0]?.textContent || '';
    setState('speaking', `ElevenLabs · ${voiceName}`);
  }

  function wordsFromAlignment(al) {
    if (!al || !al.characters) return [];
    const words = [];
    let cur = null;
    al.characters.forEach((ch, i) => {
      if (/\s/.test(ch)) { cur = null; return; }
      if (!cur) {
        cur = { w: '', t: al.character_start_times_seconds[i] };
        words.push(cur);
      }
      cur.w += ch;
    });
    return words;
  }

  async function readError(res) {
    try {
      const j = await res.json();
      const d = j.detail;
      if (Array.isArray(d)) return { message: d.map((x) => x.msg).join('; ') };
      if (d && typeof d === 'object') return d;
      return { message: String(d || '') };
    } catch (e) {
      return { message: res.statusText };
    }
  }

  function classify(status, detail) {
    const s = String(detail.status || '').toLowerCase();
    if (s.includes('quota') || status === 402) return 'quota';
    if (status === 401) return 'invalid-key';
    if (status === 429) return 'rate-limit';
    if (status === 400 || status === 422) return 'bad-request';
    return 'server';
  }

  // ---------------------------------------------------------------------------
  // Source: microphone (+ speech recognition for word plucks when available)
  // ---------------------------------------------------------------------------

  let micStream = null;
  let micSrc = null;
  let rec = null;

  async function startMic() {
    stopAll();
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      return fail(err.name === 'NotAllowedError' ? 'mic-denied' : 'mic-missing', err.name);
    }
    micSrc = audio().createMediaStreamSource(micStream);
    micSrc.connect(analyser);
    S.source = 'mic';
    S.level = analyserLevel;
    setWords([]);
    setState('listening', 'microphone');
    $('#micBtn').textContent = 'Stop mic';
    startRecognition();
  }

  function startRecognition() {
    if (!SpeechRecognition) {
      $('#micNote').textContent = 'This browser has no speech recognition, so the string reacts to loudness only.';
      return;
    }
    rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    let lastIndex = -1;
    let lastCount = 0;
    rec.onresult = (e) => {
      const i = e.results.length - 1;
      const words = e.results[i][0].transcript.trim().split(/\s+/).filter(Boolean);
      if (i !== lastIndex) { lastIndex = i; lastCount = 0; }
      for (let n = lastCount; n < words.length; n++) pluck();
      lastCount = Math.max(lastCount, words.length);
      S.utterances = [{ speaker: 'You', words: words.map((w) => ({ w, t: -1 })) }];
      renderCaption(true);
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      $('#micNote').textContent = `Word plucks unavailable (${e.error}); the string reacts to loudness only.`;
      rec = null;
    };
    rec.onend = () => {
      if (S.source === 'mic' && rec) rec.start();
    };
    try {
      rec.start();
      $('#micNote').textContent = 'Recognized words pluck the string.';
    } catch (e) { /* already running */ }
  }

  // ---------------------------------------------------------------------------
  // Source: scripted edge cases
  // ---------------------------------------------------------------------------

  const rand = (i) => { const x = Math.sin(i * 12.9898) * 43758.5453; return x - Math.floor(x); };

  function utter(speaker, text, t0, o = {}) {
    const gap = o.gap ?? 0.3;
    const dur = o.dur ?? 0.24;
    const level = o.level ?? 0.5;
    const words = [];
    let t = t0;
    text.split(' ').forEach((w, i) => {
      if (o.pauseAt === i) t += o.pause;
      words.push({ w, t, dur: dur * (0.8 + 0.4 * rand(i + t0)), level: level * (0.85 + 0.3 * rand(i + 7 + t0)) });
      t += gap;
    });
    return { speaker, words, end: t };
  }

  const apiFailure = (kind, detail, after = 1.2) => () => ({
    utterances: [],
    events: [
      { t: 0, state: 'thinking', detail: 'POST /text-to-speech (simulated)' },
      { t: after, fail: kind, detail: `${detail} (simulated)` },
    ],
  });

  const CASES = [
    {
      group: 'Signals', id: 'calm', name: 'Calm reply', desc: 'Ash speaking at a relaxed pace.',
      build() {
        const a = utter('Ash', "That sounds like a lot to carry. Do you want to talk about what made today feel heavier?", 0.3);
        return { utterances: [a], events: [{ t: 0, state: 'speaking', detail: 'scripted' }, { t: a.end + 0.6, end: true }] };
      },
    },
    {
      group: 'Signals', id: 'whisper', name: 'Whisper', desc: 'Very quiet user. Is it above the noise gate?',
      build() {
        const u = utter('You', "I don't really want anyone else to hear this", 0.3, { level: 0.1 });
        return { utterances: [u], events: [{ t: 0, state: 'listening', detail: 'scripted · quiet' }, { t: u.end + 0.6, end: true }] };
      },
    },
    {
      group: 'Signals', id: 'shout', name: 'Shouting', desc: 'Input clips. The string should stay in frame and not look alarming.',
      build() {
        const u = utter('You', "No that's not what I said at all", 0.3, { level: 1.4, gap: 0.27 });
        return { utterances: [u], events: [{ t: 0, state: 'listening', detail: 'scripted · loud' }, { t: u.end + 0.6, end: true }] };
      },
    },
    {
      group: 'Signals', id: 'pause', name: 'Long pause mid-sentence', desc: 'Ash pauses for 3s. The string should settle, not look broken.',
      build() {
        const a = utter('Ash', 'So what I am hearing is that this week felt heavier than usual', 0.3, { pauseAt: 5, pause: 3 });
        return { utterances: [a], events: [{ t: 0, state: 'speaking', detail: 'scripted · pause' }, { t: a.end + 0.6, end: true }] };
      },
    },
    {
      group: 'Signals', id: 'fast', name: 'Fast talker', desc: 'Rapid words. Do plucks blur into noise?',
      build() {
        const u = utter('You', 'and then I went to work and my manager asked about the deadline and I just completely froze up', 0.3, { gap: 0.13, dur: 0.11, level: 0.6 });
        return { utterances: [u], events: [{ t: 0, state: 'listening', detail: 'scripted · fast' }, { t: u.end + 0.6, end: true }] };
      },
    },
    {
      group: 'Signals', id: 'hum', name: 'Background hum', desc: 'Steady noise, no speech. The gate should keep the string calm.',
      build() {
        return { utterances: [], floor: 0.075, events: [{ t: 0, state: 'listening', detail: 'scripted · fan noise' }, { t: 6, end: true }] };
      },
    },
    {
      group: 'Signals', id: 'interrupt', name: 'User interrupts Ash', desc: 'Ash stops mid-sentence and the string hands over to the user.',
      build() {
        const a = utter('Ash', 'It might help to think about what you would say to a friend who', 0.3);
        a.words = a.words.filter((w) => w.t < 2.3);
        const u = utter('You', 'sorry, can I just say something', 2.4, { level: 0.65 });
        return {
          utterances: [a, u],
          events: [
            { t: 0, state: 'speaking', detail: 'scripted' },
            { t: 2.35, state: 'listening', detail: 'user interrupted · Ash stopped' },
            { t: u.end + 0.6, end: true },
          ],
        };
      },
    },
    {
      group: 'Voice API', id: 'slow', name: 'Slow first audio', desc: '3.5s before audio arrives. What does waiting look like?',
      build() {
        const a = utter('Ash', "I'm here. Take your time.", 3.8);
        return {
          utterances: [a],
          events: [
            { t: 0, state: 'thinking', detail: 'waiting for audio (simulated)' },
            { t: 3.8, state: 'speaking', detail: 'scripted' },
            { t: a.end + 0.6, end: true },
          ],
        };
      },
    },
    { group: 'Voice API', id: 'e-key', name: 'Invalid API key', desc: '401 from the API.', build: apiFailure('invalid-key', '401 invalid_api_key') },
    { group: 'Voice API', id: 'e-quota', name: 'Out of credits', desc: 'Quota exceeded.', build: apiFailure('quota', '401 quota_exceeded') },
    { group: 'Voice API', id: 'e-rate', name: 'Rate limited', desc: '429, too many requests.', build: apiFailure('rate-limit', '429 too_many_concurrent_requests') },
    { group: 'Voice API', id: 'e-timeout', name: 'Timeout', desc: 'No response in time.', build: apiFailure('timeout', 'no response (shortened to 4s for the demo)', 4) },
    { group: 'Voice API', id: 'e-net', name: 'Offline', desc: 'Request never reaches the API.', build: apiFailure('network', 'TypeError: Failed to fetch', 0.8) },
  ];

  function runCase(c) {
    stopAll();
    const run = c.build();
    run.idx = 0;
    run.start = performance.now();
    run.all = run.utterances.flatMap((u) => u.words);
    S.caseRun = run;
    S.source = 'case';
    S.clock = () => (performance.now() - run.start) / 1000;
    S.level = () => caseLevel(run, S.clock());
    setWords(run.utterances);
    log(`edge case: ${c.name}`);
  }

  function caseLevel(run, t) {
    let v = (run.floor ?? 0.015) * (0.7 + 0.3 * Math.random());
    for (const w of run.all) {
      if (t < w.t || t > w.t + w.dur) continue;
      const x = (t - w.t) / w.dur;
      v += w.level * Math.sin(Math.PI * x) * (0.75 + 0.25 * Math.sin(t * 40));
    }
    return v;
  }

  function stepCase() {
    const run = S.caseRun;
    const t = S.clock();
    while (run.idx < run.events.length && run.events[run.idx].t <= t) {
      const ev = run.events[run.idx++];
      if (ev.state) setState(ev.state, ev.detail);
      if (ev.fail) { fail(ev.fail, ev.detail); return; }
      if (ev.end) { stopSources(); setState('idle', 'edge case finished'); return; }
    }
  }

  // ---------------------------------------------------------------------------
  // Source: state preview (synthetic, for looking at each state on its own)
  // ---------------------------------------------------------------------------

  function preview(state) {
    stopAll();
    S.source = 'preview';
    const start = performance.now();
    S.clock = () => (performance.now() - start) / 1000;
    const talking = state === 'speaking' || state === 'listening';
    S.level = () => {
      if (!talking) return 0.01;
      const t = S.clock();
      const syll = Math.max(0, Math.sin(t * 6.5)) * (0.75 + 0.25 * Math.sin(t * 1.3));
      return (state === 'speaking' ? 0.5 : 0.4) * syll;
    };
    if (talking) {
      const words = Array.from({ length: 400 }, (_, i) => ({ w: '', t: 0.1 + i * (2 * Math.PI / 6.5) }));
      S.words = words;
      S.wordIdx = 0;
    }
    setState(state, 'preview');
    if (state === 'error') {
      $('#errorCard').hidden = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Stopping
  // ---------------------------------------------------------------------------

  function stopSources() {
    if (inflight) { const c = inflight; inflight = null; c.abort(); }
    if (ttsNode) { const n = ttsNode; ttsNode = null; try { n.stop(); } catch (e) { /* not started */ } }
    if (rec) { const r = rec; rec = null; r.abort(); }
    if (micSrc) { micSrc.disconnect(); micSrc = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    $('#micBtn').textContent = 'Start mic';
    S.caseRun = null;
    S.source = null;
    S.level = () => 0;
    S.clock = () => 0;
  }

  function stopAll() {
    stopSources();
    setWords([]);
    setState('idle');
  }

  // ---------------------------------------------------------------------------
  // Words and captions
  // ---------------------------------------------------------------------------

  let captionKey = '';

  function setWords(utterances) {
    S.utterances = utterances;
    S.words = utterances.flatMap((u) => u.words).sort((a, b) => a.t - b.t);
    S.wordIdx = 0;
    captionKey = '';
    renderCaption();
  }

  function renderCaption(force) {
    const el = $('#caption');
    if (!S.utterances.length) { el.innerHTML = ''; captionKey = ''; return; }
    const t = S.clock();
    let u = S.utterances[0];
    for (const x of S.utterances) if (x.words.length && x.words[0].t <= t) u = x;
    const on = u.words.filter((w) => w.t <= t).length;
    const key = `${S.utterances.indexOf(u)}:${on}`;
    if (key === captionKey && !force) return;
    captionKey = key;
    el.innerHTML = `<span class="speaker">${u.speaker}</span>` +
      u.words.map((w) => `<span class="wd${w.t <= t ? ' on' : ''}">${escapeHtml(w.w)}</span>`).join(' ');
  }

  // ---------------------------------------------------------------------------
  // The string
  // ---------------------------------------------------------------------------

  const canvas = $('#stringCanvas');
  const ctx = canvas.getContext('2d');
  let pts = [];
  let phase = 0;
  let last = performance.now();

  function ensurePoints() {
    if (pts.length === P.points) return;
    pts = Array.from({ length: P.points }, () => ({ ox: 0, oy: 0, vx: 0, vy: 0 }));
  }

  // Smooth, layered motion; neighbouring points differ more as complexity rises.
  function wobble(i, axis, t) {
    const a = i * P.complexity * 1.7 + axis * 13.1;
    return 0.55 * Math.sin(t * 1.1 + a) + 0.3 * Math.sin(t * 2.3 + a * 1.9 + 1.3) + 0.15 * Math.sin(t * 4.7 + a * 3.1 + 2.1);
  }

  function pluck() {
    if (pts.length < 3) return;
    const H = canvas.clientHeight;
    const i = 1 + (S.pluckCursor++ % (pts.length - 2));
    const dir = Math.random() < 0.5 ? -1 : 1;
    pts[i].vy += dir * P.pluck * H * 0.05;
    pts[i].vx += -dir * P.pluck * H * 0.02 * P.loop;
  }

  function step(dt) {
    // Level -> gate -> envelope
    let raw = S.level();
    S.clip = raw >= 1;
    raw = Math.min(raw, 1);
    S.raw = raw;
    const gated = raw < P.gate ? 0 : (raw - P.gate) / (1 - P.gate);
    const k = gated > S.energy ? P.attack : P.release;
    S.energy += (gated - S.energy) * Math.min(1, k * dt);

    if (S.source === 'case') stepCase();
    if (S.source === 'tts' || S.source === 'case' || S.source === 'preview') {
      const t = S.clock();
      while (S.wordIdx < S.words.length && S.words[S.wordIdx].t <= t) { pluck(); S.wordIdx++; }
      if (S.source !== 'preview') renderCaption();
    }

    // Error blends the string toward a limp, grey line.
    S.errorAmt += ((S.state === 'error' ? 1 : 0) - S.errorAmt) * 0.06 * dt;

    // Colour eases toward whoever is talking.
    const base = hexToRgb(S.state === 'listening' ? P.listenColor : P.speakColor);
    const target = base.map((c, j) => c + (ERROR_GREY[j] - c) * S.errorAmt);
    S.color = S.color.map((c, j) => c + (target[j] - c) * 0.08 * dt);

    // Spring physics
    ensurePoints();
    const H = canvas.clientHeight;
    const n = pts.length;
    phase += 0.016 * dt * P.speed * (1 + S.energy * 0.8);
    const amp = H * 0.34 * Math.min(1.25, P.idle + S.energy * P.reactivity) * (1 - 0.85 * S.errorAmt);
    const now = performance.now() / 1000;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const endF = i === 0 || i === n - 1 ? 0.45 : 1;
      let tx = wobble(i, 1, phase) * amp * P.loop * endF;
      let ty = wobble(i, 0, phase) * amp * endF;
      if (S.state === 'thinking') ty += Math.sin(i * 0.9 - now * 4.5) * H * 0.06;
      ty += S.errorAmt * H * 0.14 * Math.sin((Math.PI * i) / (n - 1));
      p.vx += (tx - p.ox) * P.tension * dt;
      p.vy += (ty - p.oy) * P.tension * dt;
      const damp = Math.pow(P.damping, dt);
      p.vx *= damp;
      p.vy *= damp;
      p.ox += p.vx * dt;
      p.oy += p.vy * dt;
    }
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = STAGE_BG;
    ctx.fillRect(0, 0, W, H);

    const n = pts.length;
    const width = P.thickness * (1 + S.energy * P.swell);
    const x0 = (W * (1 - P.span)) / 2;
    const stepX = (W * P.span) / (n - 1);
    const pad = width / 2 + 4;
    const xy = pts.map((p, i) => [
      x0 + i * stepX + p.ox,
      Math.min(H - pad, Math.max(pad, H / 2 + p.oy)),
    ]);

    // Catmull-Rom through the points, as cubic Béziers.
    ctx.beginPath();
    ctx.moveTo(xy[0][0], xy[0][1]);
    for (let i = 0; i < n - 1; i++) {
      const a = xy[i - 1] || xy[i];
      const b = xy[i];
      const c = xy[i + 1];
      const d = xy[i + 2] || c;
      ctx.bezierCurveTo(
        b[0] + (c[0] - a[0]) / 6, b[1] + (c[1] - a[1]) / 6,
        c[0] - (d[0] - b[0]) / 6, c[1] - (d[1] - b[1]) / 6,
        c[0], c[1],
      );
    }
    const [r, g, b] = S.color.map(Math.round);
    ctx.strokeStyle = `rgb(${r},${g},${b})`;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function frame(ts) {
    const dt = Math.min(3, (ts - last) / (1000 / 60));
    last = ts;
    step(dt);
    draw();
    $('#rawMeter').style.width = `${Math.round(S.raw * 100)}%`;
    $('#energyMeter').style.width = `${Math.round(S.energy * 100)}%`;
    $('#clipBadge').hidden = !S.clip;
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------

  function buildParamControls() {
    const root = $('#paramGroups');
    root.innerHTML = '';
    let group = '';
    for (const p of PARAMS) {
      if (p.group !== group) {
        group = p.group;
        const h = document.createElement('div');
        h.className = 'group-title';
        h.textContent = group;
        root.append(h);
      }
      root.append(sliderRow(p, P[p.key], (v) => {
        P[p.key] = v;
        saveParams();
        if (p.key === 'gate') updateGateMark();
      }));
    }
    updateGateMark();
  }

  function sliderRow(p, value, onChange) {
    const row = document.createElement('label');
    row.className = 'slider';
    const input = document.createElement('input');
    const out = document.createElement('output');
    if (p.type === 'color') {
      input.type = 'color';
      input.value = value;
      out.textContent = value;
      input.addEventListener('input', () => { out.textContent = input.value; onChange(input.value); });
    } else {
      input.type = 'range';
      Object.assign(input, { min: p.min, max: p.max, step: p.step });
      input.value = value;
      out.textContent = fmt(value);
      input.addEventListener('input', () => { const v = Number(input.value); out.textContent = fmt(v); onChange(v); });
    }
    row.innerHTML = `<span>${p.label}</span>`;
    row.append(input, out);
    return row;
  }

  function updateGateMark() {
    $('#gateMark').style.left = `${P.gate * 100}%`;
  }

  function buildLooks() {
    const sel = $('#lookSelect');
    const saved = loadSaved();
    sel.innerHTML = '<option value="">Presets…</option>' +
      Object.keys(LOOKS).map((n) => `<option value="b:${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('') +
      Object.keys(saved).map((n) => `<option value="s:${escapeHtml(n)}">★ ${escapeHtml(n)}</option>`).join('');
  }

  function applyLook(value) {
    if (!value) return;
    const [kind, name] = [value.slice(0, 1), value.slice(2)];
    const look = kind === 'b' ? { ...DEFAULTS, ...LOOKS[name] } : { ...DEFAULTS, ...loadSaved()[name] };
    Object.assign(P, look);
    saveParams();
    buildParamControls();
    log(`preset: ${name}`);
  }

  function buildVoiceControls() {
    const root = $('#voiceSliders');
    for (const p of VOICE_PARAMS) {
      root.append(sliderRow(p, voiceSettings[p.key], (v) => { voiceSettings[p.key] = v; }));
    }
  }

  function buildCases() {
    const root = $('#caseList');
    let group = '';
    for (const c of CASES) {
      if (c.group !== group) {
        group = c.group;
        const h = document.createElement('div');
        h.className = 'case-group';
        h.textContent = group;
        root.append(h);
      }
      const b = document.createElement('button');
      b.className = 'case';
      b.innerHTML = `<b>${escapeHtml(c.name)}</b><span>${escapeHtml(c.desc)}</span>`;
      b.addEventListener('click', () => runCase(c));
      root.append(b);
    }
  }

  function fillVoices(voices) {
    $('#voiceSelect').innerHTML = voices.map((v) => `<option value="${escapeHtml(v.voice_id)}">${escapeHtml(v.name)}</option>`).join('');
  }

  function setApiStatus(status, text) {
    $('#apiStatus').dataset.status = status;
    $('#apiStatusText').textContent = text;
  }

  function bind() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
        document.querySelectorAll('.tab-body').forEach((b) => { b.hidden = b.dataset.body !== tab.dataset.tab; });
      });
    });
    document.querySelectorAll('[data-preview]').forEach((b) => b.addEventListener('click', () => preview(b.dataset.preview)));
    $('#connectBtn').addEventListener('click', connect);
    $('#speakBtn').addEventListener('click', speak);
    $('#stopBtn').addEventListener('click', stopAll);
    $('#micBtn').addEventListener('click', () => (S.source === 'mic' ? stopAll() : startMic()));
    $('#errorCard').addEventListener('click', () => setState('idle'));
    $('#lookSelect').addEventListener('change', (e) => { applyLook(e.target.value); e.target.value = ''; });
    $('#resetParams').addEventListener('click', () => { Object.assign(P, DEFAULTS); saveParams(); buildParamControls(); log('parameters reset'); });
    $('#savePreset').addEventListener('click', () => {
      const name = (prompt('Preset name') || '').trim();
      if (!name) return;
      const saved = loadSaved();
      saved[name] = { ...P };
      try { localStorage.setItem('vs-presets', JSON.stringify(saved)); } catch (e) { /* storage unavailable */ }
      buildLooks();
      log(`saved preset: ${name}`, 'ok');
    });
    $('#copyParams').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(P, null, 2));
        log('parameters copied as JSON', 'ok');
      } catch (e) {
        log('clipboard unavailable', 'err');
      }
    });
    try {
      const k = sessionStorage.getItem('vs-key');
      if (k) $('#apiKey').value = k;
    } catch (e) { /* storage unavailable */ }
  }

  // ---------------------------------------------------------------------------
  // Log, storage, helpers
  // ---------------------------------------------------------------------------

  const logStart = performance.now();

  function log(msg, cls = '') {
    const el = $('#log');
    if (!el) return;
    const li = document.createElement('li');
    const s = ((performance.now() - logStart) / 1000).toFixed(1);
    li.innerHTML = `<span class="t">${s}s</span><span class="${cls}">${escapeHtml(msg)}</span>`;
    el.prepend(li);
    while (el.children.length > 60) el.lastChild.remove();
    $('#mReq').textContent = metrics.requests;
    $('#mCache').textContent = metrics.cacheHits;
  }

  function loadParams() {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('vs-params') || '{}') };
    } catch (e) {
      return { ...DEFAULTS };
    }
  }

  function saveParams() {
    try { localStorage.setItem('vs-params', JSON.stringify(P)); } catch (e) { /* storage unavailable */ }
  }

  function loadSaved() {
    try { return JSON.parse(localStorage.getItem('vs-presets') || '{}'); } catch (e) { return {}; }
  }

  function saveKey(key) {
    try { sessionStorage.setItem('vs-key', key); } catch (e) { /* storage unavailable */ }
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }

  function fmt(v) {
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  fillVoices(DEFAULT_VOICES);
  buildVoiceControls();
  buildParamControls();
  buildLooks();
  buildCases();
  bind();
  setState('idle');
  requestAnimationFrame(frame);
})();
