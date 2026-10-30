# Voice Visualizer

A real-time voice visualizer for the browser. It transcribes live speech and
shows the parts of the process that are normally hidden: words that aren't
final yet, words the service rewrites, low-confidence phrases, loudness, and
what happens when the mic or network fails.

## Run it

Plain HTML, CSS and JavaScript, with no build step. The microphone only works over
HTTPS or on `localhost`:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000 in Chrome, Edge or Safari. Firefox doesn't
support the Web Speech API; scenarios still work there.

## What's in it

- **Live mode:** microphone loudness (Web Audio) + speech-to-text (Web Speech API).
- **Scenarios:** 8 scripted sessions (revisions, low confidence, network drop,
  mic unplugged, permission denied and more) that run through the same code as
  live audio, for reliable demos.
- **System inspector:** live state-transition log, stats, and `.txt` / `.json` export.

Files: `index.html`, `styles.css`, `app.js` (state machine, engines, rendering),
`scenarios.js` (scripted sessions). Design notes and case-study material are in
[`CASE_STUDY.md`](CASE_STUDY.md).
