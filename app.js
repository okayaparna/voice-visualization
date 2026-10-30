// Voice Visualizer
//
// One controller, two engines. The live engine wraps the microphone (Web Audio
// for loudness) and the browser's speech service (Web Speech API). The
// scenario engine replays scripted events. Both emit the same events, so every
// edge case shown in a scenario is handled by the same code that runs live.

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  const RIBBON_WINDOW_MS = 12000;
  const LEVEL_INTERVAL_MS = 50;
  const SILENCE_HINT_MS = 6000;
  const SPEECH_LEVEL = 0.06;
  const MAX_RETRIES = 3;

  // ---------------------------------------------------------------------------
  // State machine
  // ---------------------------------------------------------------------------

  const STATES = {
    idle: { label: 'Ready', next: ['consent', 'requesting', 'unsupported'] },
    unsupported: { label: 'Live not supported', next: ['idle', 'requesting'] },
    consent: { label: 'Waiting for you', next: ['requesting', 'idle'] },
    requesting: { label: 'Asking for mic', next: ['listening', 'blocked', 'idle'] },
    listening: { label: 'Listening', next: ['paused', 'reconnecting', 'blocked', 'idle'] },
    paused: { label: 'Paused', next: ['listening', 'blocked', 'idle'] },
    reconnecting: { label: 'Reconnecting', next: ['listening', 'blocked', 'paused', 'idle'] },
    blocked: { label: 'Needs attention', next: ['requesting', 'consent', 'idle'] },
  };

  const BLOCKED = {
    denied: {
      title: 'Microphone access is blocked',
      body: 'Your browser is blocking the mic for this page. Click the lock or settings icon in the address bar, set Microphone to Allow, then try again.',
      actions: ['retry', 'scenario'],
    },
    'no-mic': {
      title: 'No microphone found',
      body: 'Connect a microphone or headset, then try again.',
      actions: ['retry', 'scenario'],
    },
    'mic-busy': {
      title: 'Your microphone is busy',
      body: 'Another app may be using it. Close that app, then try again.',
      actions: ['retry', 'scenario'],
    },
    'mic-lost': {
      title: 'Microphone disconnected',
      body: 'Everything transcribed so far is kept below. Reconnect your mic to keep going.',
      actions: ['retry', 'end'],
    },
    network: {
      title: "Can't reach the speech service",
      body: `We tried to reconnect ${MAX_RETRIES} times. Your transcript so far is kept below; nothing said since the drop was transcribed.`,
      actions: ['retry', 'end'],
    },
    service: {
      title: 'Speech service unavailable',
      body: "Your browser's speech recognition is turned off or blocked by a policy on this device.",
      actions: ['scenario', 'end'],
    },
    language: {
      title: 'Language not supported',
      body: "The speech service doesn't support the selected language. Pick another one in Settings and try again.",
      actions: ['retry', 'end'],
    },
  };

  // ---------------------------------------------------------------------------
  // Session data
  // ---------------------------------------------------------------------------

  const settings = loadSettings();
  let session = newSession();
  let engine = null;
  let mode = null; // { kind: 'live' } | { kind: 'scenario', scenario }

  function newSession() {
    return {
      state: 'idle',
      blockedReason: null,
      startedAt: performance.now(),
      segments: [],
      byKey: new Map(),
      gaps: [], // { t0, t1 } while reconnecting
      levels: [], // { t, v, state }
      log: [],
      retries: 0,
      lastSpeechAt: performance.now(),
      speaking: false,
      noSpeechHint: false,
    };
  }

  const now = () => performance.now() - session.startedAt;

  function transition(next, reason) {
    const from = session.state;
    if (from === next) return;
    const allowed = STATES[from].next.includes(next);
    session.log.push({ t: now(), from, to: next, reason, invalid: !allowed });
    if (!allowed) console.warn(`Unexpected transition ${from} → ${next} (${reason})`);
    if (from === 'reconnecting') closeGap();
    if (next === 'reconnecting') session.gaps.push({ t0: now(), t1: null });
    if (next === 'listening') session.lastSpeechAt = performance.now();
    session.state = next;
    renderChrome();
    renderLog();
  }

  function closeGap() {
    const gap = session.gaps[session.gaps.length - 1];
    if (gap && gap.t1 == null) gap.t1 = now();
  }

  // ---------------------------------------------------------------------------
  // Event handling, shared by both engines
  // ---------------------------------------------------------------------------

  function handle(type, payload = {}) {
    switch (type) {
      case 'granted':
        transition('listening', mode.kind === 'live' ? 'mic permission granted' : 'scenario started');
        break;
      case 'level':
        onLevel(payload.v);
        break;
      case 'speak':
        session.speaking = payload.on;
        break;
      case 'partial':
        if (session.state !== 'listening') return;
        upsertSegment(payload.key, payload.text, false);
        break;
      case 'final':
        if (session.state !== 'listening') return;
        upsertSegment(payload.key, payload.text, true, payload.confidence);
        break;
      case 'flush':
        commitInterim('stopped');
        break;
      case 'recovered':
        session.retries = 0;
        transition('listening', 'speech service reconnected');
        renderBanner();
        break;
      case 'error':
        onError(payload.kind);
        break;
      case 'end':
        finishSession('scenario finished');
        break;
    }
  }

  function onLevel(v) {
    const t = now();
    session.levels.push({ t, v, state: session.state });
    if (v > SPEECH_LEVEL) session.lastSpeechAt = performance.now();
  }

  function onError(kind) {
    if (kind === 'no-speech') {
      session.noSpeechHint = true;
      return;
    }
    if (kind === 'network' || kind === 'network-retry') {
      if (session.state === 'listening') {
        commitInterim('network');
        session.retries = 1;
        transition('reconnecting', 'lost connection to speech service');
      } else {
        session.retries = Math.min(session.retries + 1, MAX_RETRIES);
        session.log.push({ t: now(), from: 'reconnecting', to: 'reconnecting', reason: `retry ${session.retries} of ${MAX_RETRIES}` });
        renderLog();
      }
      renderBanner();
      return;
    }
    if (kind === 'network-fatal') kind = 'network';
    commitInterim(kind === 'mic-lost' ? 'mic-lost' : 'stopped');
    session.blockedReason = BLOCKED[kind] ? kind : 'service';
    engine && engine.stop();
    transition('blocked', kind);
    renderBanner();
  }

  // ---------------------------------------------------------------------------
  // Segments
  // ---------------------------------------------------------------------------

  function upsertSegment(key, rawText, isFinal, confidence) {
    const text = rawText.trim();
    if (!text) return;
    let seg = session.byKey.get(key);
    if (!seg) {
      // The service reports a phrase a beat after speech starts.
      seg = {
        id: session.segments.length + 1, key, text: '', isFinal: false,
        confidence: null, t0: Math.max(0, now() - 400), t1: null,
        revisions: 0, interrupted: null, words: null,
      };
      session.segments.push(seg);
      session.byKey.set(key, seg);
    }
    if (seg.isFinal) return;

    const prevWords = seg.text ? seg.text.split(' ') : [];
    const nextWords = text.split(' ');
    const revised = [];
    for (let i = 0; i < Math.min(prevWords.length, nextWords.length); i++) {
      if (prevWords[i].toLowerCase() !== nextWords[i].toLowerCase()) revised.push(i);
    }
    if (revised.length || nextWords.length < prevWords.length) seg.revisions++;

    seg.text = text;
    if (isFinal) {
      seg.isFinal = true;
      seg.t1 = now();
      // Some engines report 0 when they have no confidence score at all.
      seg.confidence = typeof confidence === 'number' && confidence > 0 ? confidence : null;
      seg.words = wordLevels(seg);
    }
    renderSegment(seg, new Set(revised));
    renderStats();
  }

  // Finalizes any phrase still in progress, e.g. when the connection drops.
  function commitInterim(reason) {
    for (const seg of session.segments) {
      if (seg.isFinal) continue;
      seg.isFinal = true;
      seg.t1 = now();
      seg.interrupted = reason;
      seg.words = wordLevels(seg);
      renderSegment(seg, new Set());
    }
    renderStats();
  }

  // Splits the loudness samples heard during a phrase evenly across its words.
  // Speech services don't return word timings, so this is an approximation.
  function wordLevels(seg) {
    const words = seg.text.split(' ');
    const samples = session.levels.filter((l) => l.t >= seg.t0 && l.t <= seg.t1).map((l) => l.v);
    if (!samples.length) return words.map((w) => ({ w, level: null }));
    const per = samples.length / words.length;
    return words.map((w, i) => {
      const chunk = samples.slice(Math.floor(i * per), Math.max(Math.floor((i + 1) * per), Math.floor(i * per) + 1));
      return { w, level: Math.max(...chunk) };
    });
  }

  const isLow = (seg) => seg.confidence != null && seg.confidence < settings.threshold / 100;
  const isCut = (seg) => seg.interrupted === 'network' || seg.interrupted === 'mic-lost';

  // ---------------------------------------------------------------------------
  // Live engine: microphone + Web Speech API
  // ---------------------------------------------------------------------------

  function createLiveEngine(emit) {
    let stream = null;
    let audioCtx = null;
    let analyser = null;
    let levelTimer = null;
    let rec = null;
    let runId = 0;
    let running = false;
    let netError = false;
    let retryTimer = null;
    let recoverTimer = null;
    let retries = 0;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch (err) {
        emit('error', { kind: micErrorKind(err) });
        return;
      }
      stream.getAudioTracks()[0].addEventListener('ended', () => {
        if (running) emit('error', { kind: 'mic-lost' });
      });
      audioCtx = new AudioContext();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      running = true;
      emit('granted');
      startLevels();
      startRecognition();
      window.addEventListener('offline', onOffline);
      window.addEventListener('online', onOnline);
    }

    function startLevels() {
      const buf = new Float32Array(analyser.fftSize);
      levelTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        emit('level', { v: Math.min(1, Math.sqrt(sum / buf.length) * 5) });
      }, LEVEL_INTERVAL_MS);
    }

    function startRecognition() {
      const id = ++runId;
      rec = new SpeechRecognition();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = settings.lang;

      rec.onstart = () => {
        if (!netError) return;
        // Only call it recovered once the connection has held for a moment.
        clearTimeout(recoverTimer);
        recoverTimer = setTimeout(() => {
          if (!netError) return;
          netError = false;
          retries = 0;
          emit('recovered');
        }, 1200);
      };

      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          const key = `${id}:${i}`;
          const alt = r[0];
          if (r.isFinal) emit('final', { key, text: alt.transcript, confidence: alt.confidence });
          else emit('partial', { key, text: alt.transcript });
        }
      };

      rec.onerror = (e) => {
        switch (e.error) {
          case 'aborted':
            return;
          case 'no-speech':
            emit('error', { kind: 'no-speech' });
            return;
          case 'network':
            clearTimeout(recoverTimer);
            emit('error', { kind: netError ? 'network-retry' : 'network' });
            netError = true;
            return;
          case 'not-allowed':
            fail('denied');
            return;
          case 'service-not-allowed':
            fail('service');
            return;
          case 'audio-capture':
            fail('no-mic');
            return;
          case 'language-not-supported':
            fail('language');
            return;
          default:
            fail('service');
        }
      };

      // The service ends sessions on its own (silence, time limits). Restart
      // unless we stopped on purpose; back off if the network is the problem.
      rec.onend = () => {
        if (!running || id !== runId) return;
        // A new run numbers its results from zero, so close out the old phrase.
        emit('flush');
        if (netError) {
          retries++;
          if (retries >= MAX_RETRIES) {
            fail('network-fatal');
            return;
          }
          retryTimer = setTimeout(startRecognition, 1000 * 2 ** (retries - 1));
        } else {
          startRecognition();
        }
      };

      try {
        rec.start();
      } catch (err) {
        fail('service');
      }
    }

    function fail(kind) {
      running = false;
      emit('error', { kind });
    }

    function onOffline() {
      if (!running || netError) return;
      netError = true;
      emit('error', { kind: 'network' });
      rec && rec.abort();
    }

    function onOnline() {
      if (!running || !netError) return;
      clearTimeout(retryTimer);
      startRecognition();
    }

    function pause() {
      running = false;
      clearTimeout(retryTimer);
      clearInterval(levelTimer);
      rec && rec.abort();
      audioCtx && audioCtx.suspend();
    }

    function resume() {
      running = true;
      netError = false;
      retries = 0;
      audioCtx && audioCtx.resume();
      startLevels();
      startRecognition();
    }

    function stop() {
      running = false;
      clearTimeout(retryTimer);
      clearTimeout(recoverTimer);
      clearInterval(levelTimer);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      if (rec) { rec.onend = null; rec.abort(); }
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (audioCtx && audioCtx.state !== 'closed') audioCtx.close();
    }

    // Restarts recognition so a language change applies right away.
    function restart() {
      if (running && rec) rec.abort();
    }

    return { start, pause, resume, stop, restart };
  }

  function micErrorKind(err) {
    switch (err && err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'denied';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'no-mic';
      case 'NotReadableError':
        return 'mic-busy';
      default:
        return 'service';
    }
  }

  // ---------------------------------------------------------------------------
  // Scenario engine: replays a script on the same event interface
  // ---------------------------------------------------------------------------

  function createScenarioEngine(emit, scenario) {
    let timers = [];
    let levelTimer = null;
    let elapsed = 0;
    let resumedAt = 0;
    let next = 0;
    let speaking = false;
    let stopped = false;

    function schedule() {
      resumedAt = performance.now();
      const events = scenario.events;
      for (let i = next; i < events.length; i++) {
        const ev = events[i];
        timers.push(setTimeout(() => {
          next = i + 1;
          fire(ev);
        }, Math.max(0, ev.t - elapsed)));
      }
      levelTimer = setInterval(() => {
        // A rough speech envelope: syllable-like bumps while speaking.
        const t = performance.now() / 1000;
        const v = speaking
          ? 0.22 + 0.3 * Math.abs(Math.sin(t * 7.3)) * (0.6 + 0.4 * Math.random())
          : 0.012 + 0.015 * Math.random();
        emit('level', { v });
      }, LEVEL_INTERVAL_MS);
    }

    function fire(ev) {
      if (stopped) return;
      if (ev.type === 'speak') {
        speaking = ev.on;
        emit('speak', { on: ev.on });
        return;
      }
      if (ev.type === 'error' && ev.kind !== 'network' && ev.kind !== 'network-retry') stop();
      emit(ev.type, ev);
    }

    function clear() {
      timers.forEach(clearTimeout);
      timers = [];
      clearInterval(levelTimer);
    }

    function start() {
      // Mirror the live flow: a short wait while "permission" is requested.
      schedule();
    }

    function pause() {
      elapsed += performance.now() - resumedAt;
      clear();
    }

    function resume() {
      schedule();
    }

    function stop() {
      stopped = true;
      clear();
    }

    return { start, pause, resume, stop, restart() {} };
  }

  // ---------------------------------------------------------------------------
  // User actions
  // ---------------------------------------------------------------------------

  function beginLive() {
    if (!SpeechRecognition || !navigator.mediaDevices) {
      transition('unsupported', 'no Web Speech API in this browser');
      renderBanner();
      return;
    }
    // Explain before the browser's own prompt, so the user knows what they're agreeing to.
    transition('consent', 'user pressed Start');
    renderBanner();
  }

  function requestMic() {
    resetEngine();
    mode = { kind: 'live' };
    transition('requesting', 'user allowed in explainer');
    renderBanner();
    engine = createLiveEngine(handle);
    engine.start();
  }

  function playScenario(id) {
    const scenario = window.SCENARIOS.find((s) => s.id === id);
    if (!scenario) return;
    resetEngine();
    resetTranscript();
    mode = { kind: 'scenario', scenario };
    transition('requesting', `scenario: ${scenario.name}`);
    renderBanner();
    engine = createScenarioEngine(handle, scenario);
    engine.start();
  }

  function pauseSession() {
    commitInterim('stopped');
    engine && engine.pause();
    transition('paused', 'user paused');
    renderBanner();
  }

  function resumeSession() {
    engine && engine.resume();
    transition('listening', 'user resumed');
    renderBanner();
  }

  function finishSession(reason) {
    commitInterim('stopped');
    resetEngine();
    session.blockedReason = null;
    transition('idle', reason);
    renderBanner();
  }

  function retry() {
    if (mode && mode.kind === 'scenario') {
      playScenario(mode.scenario.id);
    } else {
      // Keep the transcript; a new recognition run appends to it.
      resetEngine();
      session.blockedReason = null;
      mode = { kind: 'live' };
      transition('requesting', 'user retried');
      renderBanner();
      engine = createLiveEngine(handle);
      engine.start();
    }
  }

  function resetEngine() {
    if (engine) engine.stop();
    engine = null;
  }

  function resetTranscript() {
    const state = session.state;
    session = newSession();
    session.state = state;
    transcriptEl.innerHTML = '';
    transcriptEl.append(emptyEl);
    emptyEl.hidden = false;
    segEls.clear();
    renderStats();
    renderLog();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  const transcriptEl = $('#transcript');
  const emptyEl = $('#emptyState');
  const bannerEl = $('#banner');
  const hintEl = $('#hint');
  const segEls = new Map();

  function renderChrome() {
    const chip = $('#stateChip');
    const { state } = session;
    chip.dataset.state = state;
    chip.dataset.speaking = String(state === 'listening' && hasPartial());
    chip.textContent = state === 'listening' && hasPartial() ? 'Hearing speech' : STATES[state].label;
    $('#modeLabel').textContent = !mode ? '' : mode.kind === 'live' ? 'Live mic' : `Scenario · ${mode.scenario.name}`;

    const controls = $('#controls');
    controls.innerHTML = '';
    const add = (label, fn, cls = 'btn', disabled = false) => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = label;
      b.disabled = disabled;
      b.addEventListener('click', fn);
      controls.append(b);
    };
    if (state === 'idle' || state === 'unsupported') add('Start listening', beginLive, 'btn primary');
    if (state === 'requesting') add('Waiting for permission…', () => {}, 'btn', true);
    if (state === 'listening' || state === 'reconnecting') add('Pause', pauseSession);
    if (state === 'paused') add('Resume', resumeSession, 'btn primary');
    if (['listening', 'reconnecting', 'paused', 'blocked', 'requesting'].includes(state)) {
      add('End session', () => finishSession('user ended session'));
    }

    const busy = ['requesting', 'listening', 'reconnecting', 'paused', 'consent'].includes(state);
    $('#playScenario').disabled = busy;
    $('#scenarioSelect').disabled = busy;
  }

  const hasPartial = () => session.segments.some((s) => !s.isFinal);

  function renderBanner() {
    const { state } = session;
    let tone = 'info';
    let html = '';

    if (state === 'consent') {
      html = `
        <h2>Before you start</h2>
        <ul>
          <li>Your browser will ask to use your microphone.</li>
          <li>Audio is sent to your browser's speech service (Google in Chrome, Apple in Safari) to be transcribed. This page stores nothing on a server.</li>
          <li>If others are in the conversation, let them know you're transcribing.</li>
        </ul>
        <div class="row">
          <button class="btn primary" data-act="allow">Allow microphone</button>
          <button class="btn ghost" data-act="cancel">Not now</button>
        </div>`;
    } else if (state === 'reconnecting') {
      tone = 'warn';
      html = `
        <h2>Connection lost. Reconnecting (attempt ${Math.max(1, session.retries)} of ${MAX_RETRIES})</h2>
        <p>Anything said while reconnecting won't be transcribed. The gap is marked in the transcript.</p>`;
    } else if (state === 'blocked') {
      tone = 'danger';
      const b = BLOCKED[session.blockedReason] || BLOCKED.service;
      html = `<h2>${b.title}</h2><p>${b.body}</p><div class="row">${b.actions.map(actionButton).join('')}</div>`;
    } else if (state === 'unsupported') {
      tone = 'danger';
      html = `
        <h2>Live transcription needs Chrome, Edge or Safari</h2>
        <p>This browser doesn't support the Web Speech API. You can still explore every behavior with a scenario.</p>
        <div class="row">${actionButton('scenario')}</div>`;
    }

    bannerEl.hidden = !html;
    bannerEl.dataset.tone = tone;
    bannerEl.innerHTML = html;
  }

  function actionButton(act) {
    const labels = { retry: 'Try again', scenario: 'Play a scenario instead', end: 'End session' };
    const cls = act === 'retry' ? 'btn primary' : 'btn ghost';
    return `<button class="${cls}" data-act="${act}">${labels[act]}</button>`;
  }

  bannerEl.addEventListener('click', (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (act === 'allow') requestMic();
    if (act === 'cancel') { transition('idle', 'user declined in explainer'); renderBanner(); }
    if (act === 'retry') retry();
    if (act === 'end') finishSession('user ended session');
    if (act === 'scenario') {
      finishSession('switched to scenario');
      playScenario($('#scenarioSelect').value);
    }
  });

  function renderSegment(seg, revised) {
    emptyEl.hidden = true;
    let el = segEls.get(seg.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'seg';
      segEls.set(seg.id, el);
      transcriptEl.append(el);
    }
    const partial = !seg.isFinal;
    el.hidden = partial && !settings.partial;
    el.className = 'seg' + (partial ? ' partial' : '') + (settings.confidence && isLow(seg) ? ' low' : '');

    const words = seg.words || seg.text.split(' ').map((w) => ({ w, level: null }));
    const peak = sessionPeak();
    const wordHtml = words.map(({ w, level }, i) => {
      let style = '';
      if (settings.loudness && level != null && peak > 0) {
        const r = Math.min(1, level / peak);
        style = ` style="font-weight:${Math.round(320 + r * 430)};opacity:${(0.62 + r * 0.38).toFixed(2)}"`;
      }
      const cls = revised.has(i) ? 'w revised' : 'w';
      return `<span class="${cls}"${style}>${escapeHtml(w)}</span>`;
    }).join(' ');

    let tags = '';
    if (settings.confidence && isLow(seg)) {
      tags += `<span class="tag low" title="The speech service was ${Math.round(seg.confidence * 100)}% confident">Check this · ${Math.round(seg.confidence * 100)}%</span>`;
    }
    if (isCut(seg)) {
      tags += `<span class="tag cut">${seg.interrupted === 'network' ? 'Cut off · connection lost' : 'Cut off · mic disconnected'}</span>`;
    }

    el.innerHTML = `<span class="seg-time">${fmtTime(seg.t0)}</span><span class="seg-text">${wordHtml}${isCut(seg) ? '…' : ''}${tags}</span>`;

    if (isCut(seg) && seg.interrupted === 'network' && !el.nextElementSibling) {
      const gap = document.createElement('p');
      gap.className = 'gap-marker';
      gap.textContent = '— reconnecting, speech here was not transcribed —';
      transcriptEl.append(gap);
    }
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  function rerenderAll() {
    for (const seg of session.segments) renderSegment(seg, new Set());
  }

  function sessionPeak() {
    let peak = 0;
    for (const seg of session.segments) {
      if (!seg.words) continue;
      for (const w of seg.words) if (w.level != null && w.level > peak) peak = w.level;
    }
    return peak;
  }

  function renderStats() {
    const finals = session.segments.filter((s) => s.isFinal);
    $('#statSegments').textContent = finals.length;
    $('#statRevisions').textContent = session.segments.reduce((n, s) => n + s.revisions, 0);
    $('#statLow').textContent = finals.filter(isLow).length;
    $('#statCut').textContent = finals.filter(isCut).length;
  }

  function renderLog() {
    const log = $('#log');
    log.innerHTML = session.log.slice(-40).reverse().map((e) => `
      <li><span class="t">${fmtTime(e.t)}</span><span class="${e.invalid ? 'warn' : ''}">${e.from} → ${e.to}</span><span class="why">${escapeHtml(e.reason || '')}</span></li>
    `).join('');
  }

  // ---------------------------------------------------------------------------
  // Ribbon: scrolling loudness, with transcript and gaps drawn underneath
  // ---------------------------------------------------------------------------

  const canvas = $('#ribbon');
  const ctx2d = canvas.getContext('2d');

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function drawRibbon() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, w, h);

    const tNow = session.state === 'paused' || session.state === 'idle' || session.state === 'blocked'
      ? (session.levels.length ? session.levels[session.levels.length - 1].t : 0)
      : now();
    const tStart = tNow - RIBBON_WINDOW_MS;
    const x = (t) => ((t - tStart) / RIBBON_WINDOW_MS) * w;
    const bandY = h - 10;
    const mid = (h - 16) / 2;

    // Reconnecting gaps
    ctx2d.save();
    ctx2d.fillStyle = css('--warn-soft');
    for (const g of session.gaps) {
      const x0 = x(g.t0);
      const x1 = x(g.t1 ?? tNow);
      if (x1 < 0) continue;
      ctx2d.fillRect(Math.max(0, x0), 0, x1 - Math.max(0, x0), h - 16);
    }
    ctx2d.restore();

    // Centre line
    ctx2d.fillStyle = css('--border');
    ctx2d.fillRect(0, mid, w, 1);

    // Loudness bars
    const colors = {
      listening: css('--accent'),
      reconnecting: css('--warn'),
      blocked: css('--danger'),
    };
    const barW = Math.max(2, (LEVEL_INTERVAL_MS / RIBBON_WINDOW_MS) * w - 1);
    for (let i = session.levels.length - 1; i >= 0; i--) {
      const l = session.levels[i];
      if (l.t < tStart) break;
      const amp = Math.max(1, Math.sqrt(l.v) * mid * 0.95);
      ctx2d.fillStyle = colors[l.state] || css('--idle');
      ctx2d.globalAlpha = l.v > SPEECH_LEVEL ? 0.95 : 0.4;
      ctx2d.fillRect(x(l.t), mid - amp, barW, amp * 2);
    }
    ctx2d.globalAlpha = 1;

    // Phrase band
    for (const seg of session.segments) {
      const t1 = seg.t1 ?? tNow;
      if (t1 < tStart) continue;
      ctx2d.fillStyle = isCut(seg) ? css('--danger') : isLow(seg) && settings.confidence ? css('--warn') : css('--accent');
      ctx2d.globalAlpha = seg.isFinal ? 0.9 : 0.4;
      const x0 = Math.max(0, x(seg.t0));
      ctx2d.beginPath();
      ctx2d.roundRect(x0, bandY, Math.max(3, x(t1) - x0), 5, 3);
      ctx2d.fill();
    }
    ctx2d.globalAlpha = 1;
  }

  // ---------------------------------------------------------------------------
  // Frame loop: ribbon, duration, silence hint
  // ---------------------------------------------------------------------------

  function frame() {
    drawRibbon();
    const active = ['listening', 'reconnecting', 'paused'].includes(session.state);
    if (active || session.segments.length) $('#statDuration').textContent = fmtTime(session.levels.length ? session.levels[session.levels.length - 1].t : 0);

    const quiet = session.state === 'listening' && performance.now() - session.lastSpeechAt > SILENCE_HINT_MS && !hasPartial();
    const showHint = quiet || (session.state === 'listening' && session.noSpeechHint && !hasPartial());
    hintEl.hidden = !showHint;
    if (showHint) hintEl.textContent = "Still listening, but we haven't heard anything for a while. If you're talking, check that the right microphone is selected.";
    if (hasPartial()) session.noSpeechHint = false;

    const chip = $('#stateChip');
    const speaking = session.state === 'listening' && hasPartial();
    if (chip.dataset.speaking !== String(speaking)) renderChrome();

    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------------------
  // Settings, export, helpers
  // ---------------------------------------------------------------------------

  function loadSettings() {
    const defaults = { lang: 'en-US', partial: true, confidence: true, threshold: 75, loudness: true, inspector: true };
    try {
      return { ...defaults, ...JSON.parse(localStorage.getItem('vv-settings') || '{}') };
    } catch (e) {
      return defaults;
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem('vv-settings', JSON.stringify(settings));
    } catch (e) { /* storage unavailable; settings last for this visit */ }
  }

  function bindSettings() {
    const lang = $('#langSelect');
    lang.value = settings.lang;
    lang.addEventListener('change', () => {
      settings.lang = lang.value;
      saveSettings();
      if (engine && mode.kind === 'live') engine.restart();
    });

    const toggles = { optPartial: 'partial', optConfidence: 'confidence', optLoudness: 'loudness', optInspector: 'inspector' };
    for (const [id, key] of Object.entries(toggles)) {
      const el = $('#' + id);
      el.checked = settings[key];
      el.addEventListener('change', () => {
        settings[key] = el.checked;
        saveSettings();
        applySettings();
      });
    }

    const th = $('#optThreshold');
    th.value = settings.threshold;
    th.addEventListener('input', () => {
      settings.threshold = Number(th.value);
      saveSettings();
      applySettings();
    });
    applySettings();
  }

  function applySettings() {
    $('#thresholdValue').textContent = settings.threshold + '%';
    $('#thresholdField').hidden = !settings.confidence;
    $('#inspector').hidden = !settings.inspector;
    rerenderAll();
    renderStats();
  }

  function download(name, type, content) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportTxt() {
    const lines = session.segments.filter((s) => s.isFinal).map((s) => {
      const flags = [isLow(s) ? `low confidence ${Math.round(s.confidence * 100)}%` : '', isCut(s) ? 'cut off' : ''].filter(Boolean);
      return `[${fmtTime(s.t0)}] ${s.text}${flags.length ? `  (${flags.join(', ')})` : ''}`;
    });
    download('transcript.txt', 'text/plain', lines.join('\n') + '\n');
  }

  function exportJson() {
    const data = {
      mode: mode ? (mode.kind === 'live' ? 'live' : `scenario:${mode.scenario.id}`) : null,
      language: settings.lang,
      segments: session.segments,
      gaps: session.gaps,
      transitions: session.log,
    };
    download('session.json', 'application/json', JSON.stringify(data, null, 2));
  }

  function fmtTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  function init() {
    const select = $('#scenarioSelect');
    for (const s of window.SCENARIOS) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      select.append(opt);
    }
    const describe = () => {
      const s = window.SCENARIOS.find((x) => x.id === select.value);
      $('#scenarioDesc').textContent = s ? s.description : '';
    };
    select.addEventListener('change', describe);
    describe();
    $('#playScenario').addEventListener('click', () => playScenario(select.value));
    $('#exportTxt').addEventListener('click', exportTxt);
    $('#exportJson').addEventListener('click', exportJson);
    $('#clearBtn').addEventListener('click', resetTranscript);

    bindSettings();
    renderChrome();
    renderStats();
    requestAnimationFrame(frame);
  }

  init();
})();
