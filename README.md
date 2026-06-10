# Equal Play — D1 Conversion Pipeline (Demo)

Interactive demo of the **Equal Play** "any input → piano score" conversion
pipeline by **My Andante Limited**. Try it live:

**https://my-andante.github.io/conversion-pipeline-demo/**

## What you can try in the browser

| Lane | Status on this page |
|------|---------------------|
| **MIDI → Score** (.mid/.midi) | ✅ Fully in-browser — drop a MIDI file, get an engraved two-hand piano score with playback and ScoreJSON/MusicXML export |
| **MusicXML → Score** (.xml/.musicxml/.json) | ✅ Fully in-browser |
| **Audio → Score** (.mp3/.wav/.m4a/.aac/.ogg) | ⚠️ Requires the conversion backend (not deployed here) — falls back to a pre-built sample |
| **Sheet → Score (OMR)** (.jpg/.png/.pdf) | ⚠️ Requires the conversion backend — falls back to a pre-built sample |

The Audio and Sheet lanes run heavyweight Python engines (source separation,
automatic music transcription, optical music recognition) on a server; this
static deployment demonstrates their UX flow with sample results. Every
conversion ends at the mandatory **Teacher Review** gate.

## Licences & attribution

- **ScoreJSON** format and converter (`src/ScoreJSON.js`) — proprietary,
  patent-pending. © My Andante Limited. All rights reserved.
- Demo UI, styles, and design tokens — © My Andante Limited. All rights reserved.
- [OpenSheetMusicDisplay](https://github.com/opensheetmusicdisplay/opensheetmusicdisplay) — BSD-3-Clause (score engraving)
- [@tonejs/midi](https://github.com/Tonejs/Midi) — MIT (loaded from CDN; in-browser MIDI parsing)
- [WebAudioFont](https://github.com/surikov/webaudiofont) + GeneralUser GS SoundFont — GPL-3.0 (piano playback; demo only — the production app uses AudioKit)
- [Basic Pitch](https://github.com/spotify/basic-pitch) — Apache-2.0 (referenced by the optional in-browser transcription fallback)

No accounts, no tracking, nothing uploaded anywhere — all in-page processing.
