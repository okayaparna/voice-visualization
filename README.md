# Voice Studio

An internal tool for tuning the voice "string": the line that moves with an AI
voice and the user's voice. Tune its look and physics against the ElevenLabs
voice API, your microphone, and scripted edge cases.

## Run it

Plain HTML, CSS and JavaScript, with no build step. The microphone only works over
HTTPS or on `localhost`:

```bash
python3 -m http.server 8000
```

Open http://localhost:8000 in Chrome or Safari. Brave blocks speech
recognition, so mic word plucks won't work there.

## Pages

- **`index.html` — Voice Studio**
  - **Voice API:** ElevenLabs text-to-speech with word timestamps, voice and model
    choice, voice settings, response caching, timeouts and error handling. Your API
    key stays in the browser tab.
  - **Microphone:** loudness, plus word plucks via the Web Speech API where available.
  - **Edge cases:** whisper, shouting, long pause, fast talker, background hum,
    interruption, slow first audio, and API failures (invalid key, out of
    credits, rate limit, timeout, offline).
  - **String:** 17 parameters, presets, and "Copy as JSON" for engineering handoff.
  - **Inspector:** time to audio, cache hits, state and request log.
- **`transcript.html` — Transcript lab:** the speech-to-text side, covering partial words,
  revisions, confidence, and network/mic failures.

Design notes and case-study material: [`CASE_STUDY.md`](CASE_STUDY.md).
