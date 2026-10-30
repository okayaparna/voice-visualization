// Scripted sessions. Each scenario is a list of timed events that go through
// the same controller as live audio, so edge cases can be demoed on demand.
//
// Event types: granted, speak {on}, partial {key, text}, final {key, text,
// confidence}, error {kind}, recovered, end.

(function () {
  'use strict';

  // Builds the events for one spoken phrase: words arrive as growing partial
  // results, optional revisions rewrite earlier words, then a final result.
  function phrase(t, key, text, opts = {}) {
    const { confidence = 0.93, wordMs = 260, revisions = [], finalText = text, cutAfter } = opts;
    const words = text.split(' ');
    const events = [{ t, type: 'speak', on: true }];
    let clock = t;
    const limit = cutAfter ?? words.length;
    for (let i = 1; i <= limit; i++) {
      clock += wordMs;
      events.push({ t: clock, type: 'partial', key, text: words.slice(0, i).join(' ') });
      for (const r of revisions) {
        if (r.atWord === i) {
          clock += 180;
          events.push({ t: clock, type: 'partial', key, text: r.text });
        }
      }
    }
    if (cutAfter != null) return { events, end: clock };
    clock += 380;
    events.push({ t: clock, type: 'speak', on: false });
    clock += 220;
    events.push({ t: clock, type: 'final', key, text: finalText, confidence });
    return { events, end: clock };
  }

  // Lays phrases out back to back with pauses between them.
  function sequence(start, items) {
    const events = [];
    let t = start;
    for (const item of items) {
      if (item.pause) { t += item.pause; continue; }
      if (item.event) { events.push({ t, ...item.event }); continue; }
      const p = phrase(t, item.key, item.text, item);
      events.push(...p.events);
      t = p.end;
    }
    return { events, end: t };
  }

  function build(items) {
    const s = sequence(400, items);
    return [{ t: 0, type: 'granted' }, ...s.events, { t: s.end + 900, type: 'end' }];
  }

  const scenarios = [
    {
      id: 'happy',
      name: 'Happy path',
      description: 'Clear speech in a quiet room. Words appear as they are heard, then settle into final phrases.',
      events: build([
        { key: 'a', text: 'Okay so this is the first thing I want to talk about today' },
        { pause: 700 },
        { key: 'b', text: 'the visualizer should feel calm even when speech is messy' },
      ]),
    },
    {
      id: 'revisions',
      name: 'Self-correcting transcript',
      description: 'The speech service revises earlier words as it hears more. Rewritten words flash so the change is noticeable but not alarming.',
      events: build([
        {
          key: 'a', text: 'It is hard to wreck a nice beach',
          revisions: [{ atWord: 8, text: 'It is hard to recognize speech' }],
          finalText: 'It is hard to recognize speech',
        },
        { pause: 600 },
        {
          key: 'b', text: 'especially when there are four candles',
          revisions: [{ atWord: 6, text: 'especially when there are fork handles' }],
          finalText: 'especially when there are fork handles', confidence: 0.81,
        },
      ]),
    },
    {
      id: 'low',
      name: 'Low confidence',
      description: 'A mumbled phrase comes back with low confidence. It is marked rather than hidden, so the reader knows what to double-check.',
      events: build([
        { key: 'a', text: 'Let me read out the order number' },
        { pause: 500 },
        { key: 'b', text: 'it is four seven nine bee tee', confidence: 0.46, wordMs: 340 },
        { pause: 500 },
        { key: 'c', text: 'and the delivery window is after six' },
      ]),
    },
    {
      id: 'network',
      name: 'Network drop',
      description: 'The connection to the speech service drops mid-sentence. The unfinished phrase is kept and marked as cut off, the app reconnects, and the gap is shown honestly.',
      events: (() => {
        const first = sequence(400, [{ key: 'a', text: 'We were halfway through planning the launch' }]);
        const cut = phrase(first.end + 600, 'b', 'and then the most important decision was', { cutAfter: 5 });
        const tDrop = cut.end + 150;
        const after = sequence(tDrop + 3200, [
          { key: 'c', text: 'sorry I think we lost connection for a second' },
          { pause: 500 },
          { key: 'd', text: 'the decision was to ship the smaller version first' },
        ]);
        return [
          { t: 0, type: 'granted' },
          ...first.events, ...cut.events,
          { t: tDrop, type: 'error', kind: 'network' },
          { t: tDrop + 1400, type: 'speak', on: true },
          { t: tDrop + 2600, type: 'speak', on: false },
          { t: tDrop + 3000, type: 'recovered' },
          ...after.events,
          { t: after.end + 900, type: 'end' },
        ];
      })(),
    },
    {
      id: 'reconnect-fail',
      name: 'Network fails for good',
      description: 'Reconnecting fails three times. The app stops retrying, keeps the transcript and says what happened.',
      events: (() => {
        const first = sequence(400, [{ key: 'a', text: 'This next part is the most important bit' }]);
        const t = first.end + 400;
        return [
          { t: 0, type: 'granted' }, ...first.events,
          { t, type: 'error', kind: 'network' },
          { t: t + 1500, type: 'error', kind: 'network-retry' },
          { t: t + 3500, type: 'error', kind: 'network-retry' },
          { t: t + 6000, type: 'error', kind: 'network-fatal' },
        ];
      })(),
    },
    {
      id: 'mic-lost',
      name: 'Mic unplugged',
      description: 'The headset is unplugged mid-phrase. Everything so far is kept and the user is asked to reconnect.',
      events: (() => {
        const first = sequence(400, [{ key: 'a', text: 'I will switch to my headset in a moment' }]);
        const cut = phrase(first.end + 500, 'b', 'okay can you hear me now', { cutAfter: 3 });
        return [
          { t: 0, type: 'granted' }, ...first.events, ...cut.events,
          { t: cut.end + 120, type: 'error', kind: 'mic-lost' },
        ];
      })(),
    },
    {
      id: 'denied',
      name: 'Permission denied',
      description: 'The user, or their browser settings, blocks the microphone. The app explains how to fix it instead of failing silently.',
      events: [{ t: 900, type: 'error', kind: 'denied' }],
    },
    {
      id: 'silence',
      name: 'Long silence',
      description: 'The mic is on but nothing is heard for a while. After 6 seconds a gentle hint suggests checking the mic, without interrupting.',
      events: build([
        { key: 'a', text: 'Give me a second to find my notes' },
        { pause: 9000 },
        { key: 'b', text: 'okay found them' },
      ]),
    },
  ];

  window.SCENARIOS = scenarios;
})();
