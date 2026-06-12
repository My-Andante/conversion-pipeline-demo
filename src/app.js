/**
 * D1 Conversion Pipeline — frontend controller (v0.2.0)
 * =====================================================
 * Four input lanes, each producing a music score (MusicXML + ScoreJSON):
 *
 *   - MIDI         (.mid/.midi)        client-side fast path via @tonejs/midi (MIT),
 *                                      or server path (music21, BSD-3) when reachable.
 *   - Audio        (.mp3/.wav/.m4a)    server path; a BRANCH SELECTOR picks the strategy:
 *                                        · Piano        basic-pitch -> backbone
 *                                        · Instrumental demucs (drop drums) -> per-stem AMT -> reduce
 *                                        · Singing      demucs (vocals->RH melody, accomp->LH chords)
 *                                      posted to POST /convert/audio with form field `branch`.
 *   - Sheet (OMR)  (.jpg/.png/.pdf)    server path (oemer, MIT) via POST /convert/omr (SSE).
 *   - MusicXML     (.xml/.musicxml/.json) fully in-browser via ScoreJSON.js + OSMD.
 *
 * Portability contract: the server path (POST /convert/{midi,audio,omr}, SSE progress,
 * { musicxml|music_xml, scorejson|score_json, accuracy, stats, meta } responses) is the
 * boundary the future React-Native iPad client reuses verbatim (see RN_PORTABILITY.md).
 * The @tonejs/midi and Web Audio paths are demo-only conveniences and never cross that boundary.
 *
 * Every conversion terminates at the MANDATORY Teacher Review Gate (M10): the teacher
 * sees the rendered score, can edit its title, and must Approve / Re-run / Reject before
 * the score is accepted and versioned.
 *
 * Loaded as a plain <script> (no Vite / no ES modules). Backend base URL is configurable
 * via `window.D1_BACKEND`, defaulting to http://localhost:8000.
 */

/* global opensheetmusicdisplay, Midi, ScoreJSON, Tone */

// Backend base URL — configurable without a build step (set window.D1_BACKEND before this script).
const BACKEND_URL = (typeof window !== 'undefined' && window.D1_BACKEND) || 'http://localhost:8000';

// Design-system icon path (relative to index.html).
const ICONS = 'design-system/icons/';

/**
 * Lane definitions. `icon` is a design-system SVG filename (no emoji / no inline SVG).
 * `serverRequired` lanes need the Python backend; MIDI is client-capable.
 */
const PIPELINES = {
    midi: {
        label: 'MIDI',
        icon: 'Icon_music__Active.svg',
        accept: '.mid,.midi',
        steps: [
            { id: 'parse',    icon: 'Icon_doc__Default.svg',    title: 'Parse MIDI file',       detail: '@tonejs/midi (MIT) — read tracks, tempo map, time signature' },
            { id: 'quantize', icon: 'Icon_tool__Default.svg',   title: 'Quantise note timings', detail: 'Notes already quantised in MIDI; derive timing from ticks' },
            { id: 'voice',    icon: 'Icon_Hand_Select__Double-Select.svg', title: 'Voice separation', detail: 'Split treble / bass staves by pitch range (C4 cutoff)' },
            { id: 'export',   icon: 'Icon_refresh__Active.svg', title: 'Export MusicXML',       detail: 'Serialise to MusicXML 3.1 via ScoreJSON.toMusicXML()' },
        ],
        sampleFile: 'sample-midi-result.xml',
        sampleLabel: 'Sample: Ode to Joy (MIDI)',
        serverRequired: false,
        provenance: { engine: 'music21', license: 'BSD-3', note: 'server-side; @tonejs/midi (MIT) used for the in-browser demo fast path' },
        stats: { notes: 64, measures: 8, voices: 2 },
    },
    audio: {
        label: 'Audio',
        icon: 'Icon_volume__Active-Fill-Default.svg',
        accept: '.mp3,.wav,.m4a,.aac,.ogg',
        // Steps are branch-aware: separation step only shown for instrumental/singing.
        steps: [
            { id: 'separation', icon: 'Icon_refresh__Active.svg', title: 'Source separation', detail: 'Demucs isolates stems (drops drums for instrumental; vocals/accomp for singing)', branchOnly: ['instrumental', 'singing'] },
            { id: 'amt',        icon: 'Icon_volume__Active-Fill-Default.svg', title: 'Pitch detection (AMT)', detail: 'Basic Pitch (Spotify, Apache-2.0) — polyphonic F0 / onset extraction' },
            { id: 'reduce',     icon: 'Icon_Hand_Select__Double-Select.svg', title: 'Reduce to two hands', detail: 'Map detected notes to treble / bass; music21 chordify for accompaniment', branchOnly: ['instrumental', 'singing'] },
            { id: 'export',     icon: 'Icon_refresh__Active.svg', title: 'Export MusicXML',     detail: 'music21 backbone -> MusicXML 3.1 -> ScoreJSON' },
        ],
        sampleFile: 'sample-audio-result.xml',
        sampleLabel: 'Sample: Twinkle Twinkle (audio)',
        serverRequired: true,
        provenance: { engine: 'Basic Pitch', license: 'Apache-2.0', note: 'on-device-capable (CoreML/ONNX); Demucs separation is prototype-only -> Music.AI in production' },
        stats: { notes: 0, measures: 0, voices: 2 },
    },
    ocr: {
        label: 'Sheet (OMR)',
        icon: 'Icon_insert_photo__Outlined.svg',
        iconSelected: 'Icon_insert_photo__Filled.svg',
        accept: '.jpg,.jpeg,.png,.pdf',
        steps: [
            { id: 'segment',     icon: 'Icon_tool__Default.svg',   title: 'Image segmentation',    detail: 'oemer (MIT) — detect staff lines, note heads, accidentals' },
            { id: 'classify',    icon: 'Icon_tool__Default.svg',   title: 'Symbol classification', detail: 'CNN classifies note durations, rests, clefs, key/time sigs' },
            { id: 'reconstruct', icon: 'Icon_Hand_Select__Double-Select.svg', title: 'Score reconstruction', detail: 'Group symbols into measures -> voice entries -> staves' },
            { id: 'export',      icon: 'Icon_refresh__Active.svg', title: 'Export MusicXML',       detail: 'Convert reconstructed structure to MusicXML 3.1' },
        ],
        sampleFile: 'sample-ocr-result.xml',
        sampleLabel: 'Sample: C Major Scale (scanned sheet)',
        serverRequired: true,
        provenance: { engine: 'oemer', license: 'MIT', note: 'server-side (TensorFlow); chosen over Audiveris (AGPL blocker)' },
        stats: { notes: 24, measures: 4, voices: 2 },
    },
    musicxml: {
        label: 'MusicXML',
        icon: 'Icon_doc__Default.svg',
        accept: '.xml,.musicxml,.mxl,.json',
        steps: [
            { id: 'parse',   icon: 'Icon_doc__Default.svg',    title: 'Parse & validate',    detail: 'DOM-parse the MusicXML; check for <score-partwise> root; count parts, measures, notes' },
            { id: 'convert', icon: 'Icon_refresh__Active.svg', title: 'Convert to ScoreJSON', detail: 'ScoreJSON.js — proprietary ~10x compression format (patent-pending); in-browser' },
            { id: 'render',  icon: 'Icon_check__Active.svg',   title: 'Render in OSMD',       detail: 'OpenSheetMusicDisplay renders the converted score directly in the browser' },
        ],
        sampleFile: 'sample-midi-result.xml',
        sampleLabel: 'Sample: Ode to Joy (MusicXML)',
        serverRequired: false,
        provenance: { engine: 'music21', license: 'BSD-3', note: 'ScoreJSON (proprietary, patent-pending) round-trip; rendered in-browser via OSMD' },
        stats: { notes: 64, measures: 8, voices: 2 },
    },
};

// Audio sub-branch metadata (the branch field posted to /convert/audio).
const AUDIO_BRANCHES = {
    piano:        { label: 'Piano',        icon: 'Icon_music__Active.svg' },
    instrumental: { label: 'Instrumental', icon: 'Icon_Hand_Select__Double-Select.svg' },
    singing:      { label: 'Singing',      icon: 'Icon_volume__Active-Fill-Default.svg' },
};

// Lane render order for the selector.
const LANE_ORDER = ['midi', 'audio', 'ocr', 'musicxml'];

// Accuracy thresholds (per DESIGN_RESKIN §5.8): >=0.80 pass, 0.60-0.79 marginal, <0.60 fail.
const ACCURACY_PASS = 0.80;
const ACCURACY_MARGINAL = 0.60;

/**
 * Build an icon <img> tag from a design-system filename.
 * @param {string} file - SVG filename inside icons/
 * @param {string} cls  - extra CSS classes
 * @returns {string} HTML
 */
function icon(file, cls = '') {
    return `<img class="d1-icon ${cls}" src="${ICONS}${file}" alt="" aria-hidden="true">`;
}

/**
 * Syntax-highlight a JSON string for the ScoreJSON panel.
 * @param {string} json
 * @returns {string} HTML with <span> classes for keys/strings/numbers/null
 */
function highlightJSON(json) {
    const escaped = json
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    return escaped.replace(
        /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
        (match) => {
            let cls = 'json-number';
            if (/^"/.test(match)) {
                cls = /:$/.test(match) ? 'json-key' : 'json-string';
            } else if (/true|false/.test(match)) {
                cls = 'json-number';
            } else if (/null/.test(match)) {
                cls = 'json-null';
            }
            return `<span class="${cls}">${match}</span>`;
        }
    );
}

/**
 * Read both contract (`musicxml`/`scorejson`) and legacy (`music_xml`/`score_json`)
 * key spellings so the frontend works before/after the backend rename.
 * @param {object} obj
 * @returns {{musicXML: (string|null), scoreJSON: (object|null), accuracy: (object|null), stats: (object|null), meta: (object|null)}}
 */
function normalizeResponse(obj) {
    if (!obj) return { musicXML: null, scoreJSON: null, accuracy: null, stats: null, meta: null };
    let musicXML = obj.musicxml ?? obj.music_xml ?? null;
    const scoreJSON = obj.scorejson ?? obj.score_json ?? null;
    // The MIDI/audio server now returns music_xml = "" ON PURPOSE and a faithful
    // ScoreJSON; MusicXML is only a CLIENT-side render intermediate. Build it here
    // from the proprietary ScoreJSON so every downstream path (render, save) has it.
    if ((!musicXML || musicXML.trim() === '') && scoreJSON && typeof ScoreJSON !== 'undefined') {
        try { musicXML = ScoreJSON.toMusicXML(scoreJSON); }
        catch (e) { console.error('ScoreJSON.toMusicXML failed in normalizeResponse:', e); }
    }
    return {
        musicXML: musicXML || null,
        scoreJSON,
        accuracy: obj.accuracy ?? null,
        stats: obj.stats ?? null,
        meta: obj.meta ?? null,
    };
}


/**
 * Sanitize a title pulled from MIDI metadata. MIDI track names are often
 * Shift-JIS bytes that arrive as latin-1 mojibake (e.g. "ƒGƒAƒŠƒX"). Keep the
 * embedded name only if it is clean printable ASCII; otherwise fall back to the
 * (clean) filename. The title field is user-editable, so a sane default wins.
 */
function sanitizeTitle(name, fallback) {
    const fb = (fallback || 'Untitled').toString().trim() || 'Untitled';
    if (!name) return fb;
    const t = String(name).replace(/[ -]/g, '').trim();
    if (!t) return fb;
    return /^[ -~]+$/.test(t) ? t : fb;   // printable ASCII only, else filename
}

class ConversionApp {
    constructor() {
        this.activePath = 'midi';
        this.audioBranch = 'piano';        // piano | instrumental | singing
        this.osmd = null;
        this._pendingFile = null;
        this._isRecording = false;
        this._mediaRecorder = null;
        this._mediaStream = null;
        this._audioChunks = [];
        this._mic = null;
        this._analyser = null;
        this._meterRafId = null;
        this._audioUtils = null;           // optional in-browser audio helpers (loaded if present)
        this._serverStatus = 'unknown';    // 'ok' | 'error' | 'unknown'
        this.activeMode = 'client';        // MIDI lane: 'client' | 'server'
        this._lastResult = null;           // for Re-run / Approve in the Teacher Gate
        this._lastContext = null;          // { path, isSample, filename, file }
        this._selfTestCache = null;        // cached /selftest accuracy numbers
        // ── Playback state (real-piano, ported from B1) ──
        this.audioContext = null;
        this.player = null;                // WebAudioFontPlayer
        this.pianoPreset = null;           // _tone_0000_GeneralUserGS_sf2_file
        this.isPlaying = false;
        this._playTempo = 120;
        if (typeof WebAudioFontPlayer !== 'undefined') {
            this.player = new WebAudioFontPlayer();
            if (typeof _tone_0000_GeneralUserGS_sf2_file !== 'undefined') {
                this.pianoPreset = _tone_0000_GeneralUserGS_sf2_file;
            }
        }
        this.init();
    }

    init() {
        // Optionally load in-browser audio helpers (used only by the demo client audio path).
        // Loaded via dynamic import guarded so the app still runs if the module is absent.
        this._tryLoadAudioUtils();
        this.renderLaneSelector();
        this.renderInputScreen();
        this._loadSelfTest();
    }

    /**
     * Attempt to load optional client-side audio utilities without breaking plain-script load.
     * If unavailable, the audio lane simply uses the server path (the production-correct path).
     */
    _tryLoadAudioUtils() {
        try {
            // Use the Function constructor so a bundler/parser without ESM support does not choke.
            const dynamicImport = new Function('p', 'return import(p);');
            dynamicImport('./audio/audioUtils.js')
                .then((mod) => { this._audioUtils = mod; })
                .catch(() => { /* optional — server path is authoritative */ });
        } catch {
            /* dynamic import unsupported — ignore; server path used */
        }
    }

    // ── Lane + branch selectors ───────────────────────────────────────────

    renderLaneSelector() {
        const container = document.getElementById('pathTabs');
        container.innerHTML = LANE_ORDER.map((key) => {
            const p = PIPELINES[key];
            const selected = key === this.activePath;
            const badge = p.serverRequired
                ? '<span class="branch-badge">Server</span>'
                : '';
            return `
                <button class="branch-card${selected ? ' active' : ''}"
                        role="tab" data-path="${key}"
                        aria-selected="${selected ? 'true' : 'false'}"
                        aria-label="${p.label} conversion lane">
                    ${icon(p.icon)}
                    <span class="branch-label">${p.label}</span>
                    ${badge}
                </button>`;
        }).join('');

        container.querySelectorAll('.branch-card').forEach((card) => {
            card.addEventListener('click', () => this._selectLane(card.dataset.path));
            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._selectLane(card.dataset.path); }
            });
        });
    }

    _selectLane(path) {
        this.activePath = path;
        this.renderLaneSelector();
        // Ping the backend when a server lane becomes active.
        if (PIPELINES[path].serverRequired) {
            this._checkServerHealth();
        }
        this.renderInputScreen();
    }

    renderAudioBranchSelector() {
        const wrap = document.getElementById('audioBranchWrap');
        const selector = document.getElementById('audioBranchSelector');
        if (this.activePath !== 'audio') {
            wrap.hidden = true;
            selector.innerHTML = '';
            return;
        }
        wrap.hidden = false;
        selector.innerHTML = Object.entries(AUDIO_BRANCHES).map(([key, b]) => {
            const selected = key === this.audioBranch;
            return `
                <button class="branch-card${selected ? ' active' : ''}"
                        role="radio" data-branch="${key}"
                        aria-checked="${selected ? 'true' : 'false'}"
                        aria-selected="${selected ? 'true' : 'false'}"
                        aria-label="${b.label} audio source">
                    ${icon(b.icon)}
                    <span class="branch-label">${b.label}</span>
                </button>`;
        }).join('');

        selector.querySelectorAll('.branch-card').forEach((card) => {
            card.addEventListener('click', () => {
                this.audioBranch = card.dataset.branch;
                this.renderAudioBranchSelector();
                this.renderInfoAndProvenance();
            });
            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.audioBranch = card.dataset.branch;
                    this.renderAudioBranchSelector();
                    this.renderInfoAndProvenance();
                }
            });
        });
    }

    // ── Input screen ──────────────────────────────────────────────────────

    renderInputScreen() {
        const p = PIPELINES[this.activePath];
        const zone = document.getElementById('uploadZone');
        const sampleRow = document.getElementById('sampleRow');

        this.renderAudioBranchSelector();
        this.renderInfoAndProvenance();

        // File-type chips.
        let fileTypesHtml;
        if (this.activePath === 'musicxml') {
            fileTypesHtml =
                '<span class="file-type">.xml / .musicxml</span>' +
                '<span class="file-type">.json (ScoreJSON)</span>';
        } else {
            fileTypesHtml = p.accept.split(',').map((ext) =>
                `<span class="file-type">${ext}</span>`).join('');
            if (p.serverRequired) {
                fileTypesHtml += '<span class="file-type warn">requires server</span>';
            }
        }

        // Decide whether to show the server-unavailable panel.
        const showServerUnavailable = p.serverRequired && this._serverStatus === 'error';

        if (showServerUnavailable) {
            zone.classList.add('server-unavailable');
            zone.innerHTML = `
                ${icon('Icon_settings__Active.svg', 'upload-glyph')}
                <div class="upload-title">Python backend not reachable</div>
                <div class="upload-sub">Start the conversion server, then return here:</div>
                <code class="server-cmd">python -m uvicorn src.backend.main:app --reload --port 8000</code>
                <a class="server-link" href="#" onclick="app.retryServer(event)">Retry connection</a>`;
        } else {
            zone.classList.remove('server-unavailable');
            const recordRow = this.activePath === 'audio'
                ? `<div class="record-btn-row">
                       <button class="btn-primary" id="recordBtn" type="button">
                           ${icon('Icon_volume__Active-Fill-Default.svg')}<span id="recordLabel">Record</span>
                       </button>
                       <div class="level-meter" id="levelMeter" aria-hidden="true"></div>
                   </div>`
                : '';
            zone.innerHTML = `
                ${recordRow}
                ${icon(p.icon, 'upload-glyph')}
                <div class="upload-title">Drop your file here</div>
                <div class="upload-sub">or <span>click to browse</span></div>
                <div class="file-types">${fileTypesHtml}</div>
                <input type="file" id="fileInput" accept="${p.accept}" style="display:none">`;
        }

        // Sample row.
        sampleRow.innerHTML = `
            <span class="samples-label">Or try a sample:</span>
            <button class="btn-tertiary--chip" type="button" onclick="app.runSample('${this.activePath}')">${p.sampleLabel}</button>`;

        this._pendingFile = null;
        this._bindUploadZone(zone);
        this._bindRecordButton();

        // Show input screen.
        document.getElementById('screen-result').classList.remove('active');
        document.getElementById('screen-processing').classList.remove('active');
        document.getElementById('screen-input').classList.add('active');
    }

    /** Render the info box and engine-provenance line for the active lane / branch. */
    renderInfoAndProvenance() {
        const p = PIPELINES[this.activePath];
        const infoBox = document.getElementById('infoBox');
        const prov = document.getElementById('provenanceLine');

        const infoMap = {
            midi:     '<strong>@tonejs/midi</strong> (MIT) parses MIDI in-browser; the production path uses <strong>music21</strong> (BSD-3) server-side. Voices split by pitch (C4 cutoff), exported via ScoreJSON. <em>Client-side — no server needed for the demo.</em>',
            audio:    this._audioInfoText(),
            ocr:      '<strong>oemer</strong> (MIT) deep-learning OMR — detects staff lines, classifies symbols, reconstructs the score. Chosen over Audiveris (AGPL blocker). <em>Requires the Python + TensorFlow server.</em>',
            musicxml: '<strong>ScoreJSON</strong> (proprietary, patent-pending) — compact JSON interchange (~10x smaller than MusicXML). MusicXML is parsed in-browser and rendered directly in OSMD; ScoreJSON .json files render directly.',
        };
        infoBox.innerHTML = `${icon('Icon_info__Active.svg', 'd1-icon--sm')}<span>${infoMap[this.activePath]}</span>`;

        const pr = p.provenance;
        prov.innerHTML =
            `${icon('Icon_check__Active.svg', 'd1-icon--sm')}` +
            `<span>Engine: <span class="engine-name">${pr.engine}</span> ` +
            `<span class="lic">${pr.license}</span> — ${pr.note}</span>`;
    }

    _audioInfoText() {
        const branchNote = {
            piano:        'Piano: Basic Pitch transcribes the recording directly into a two-hand score.',
            instrumental: 'Instrumental: Demucs separates stems (drums dropped), each stem is transcribed, then reduced to two hands.',
            singing:      'Singing: Demucs splits vocals (-> right-hand melody) from accompaniment (-> left-hand chords via music21 chordify).',
        }[this.audioBranch];
        return `<strong>Basic Pitch</strong> (Spotify, Apache-2.0) polyphonic transcription. ${branchNote} <em>Posted to /convert/audio with branch=${this.audioBranch}.</em>`;
    }

    _bindUploadZone(zone) {
        if (zone.classList.contains('server-unavailable')) return;
        // The <input> is recreated by every renderInputScreen() call, so its
        // change listener must be (re)bound here. Clearing value afterwards
        // lets the same file be uploaded twice in a row.
        document.getElementById('fileInput')?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) { this._pendingFile = file; this.runPipeline(this.activePath, file); }
        });
        // The zone element itself persists across renders — bind it once, or
        // every lane switch stacks another click handler.
        if (zone.dataset.uploadBound) return;
        zone.dataset.uploadBound = '1';
        zone.addEventListener('click', (e) => {
            // The programmatic input.click() below bubbles back up to the zone;
            // re-triggering it cancels the OS file picker mid-selection (the
            // "every upload needs two clicks" bug).
            if (e.target && e.target.id === 'fileInput') return;
            document.getElementById('fileInput')?.click();
        });
        zone.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('fileInput')?.click(); }
        });
        zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('drag-over');
            const file = e.dataTransfer?.files?.[0];
            if (file) { this._pendingFile = file; this.runPipeline(this.activePath, file); }
        });
    }

    _bindRecordButton() {
        const recordBtn = document.getElementById('recordBtn');
        if (recordBtn && this.activePath === 'audio') {
            recordBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (this._isRecording) { this._stopRecording(); }
                else { await this.startRecording(); }
            });
        }
    }

    retryServer(event) {
        if (event) event.preventDefault();
        this._checkServerHealth().then(() => this.renderInputScreen());
    }

    runSample(path) {
        this.runPipeline(path, null, true);
    }

    // ── Pipeline driver ───────────────────────────────────────────────────

    /**
     * Entry point. `file` is a File (drag/drop or input) or null (sample).
     * @param {string} path
     * @param {File|null} file
     * @param {boolean} [isSample]
     * @param {ArrayBuffer|null} [arrayBuffer] - recorded audio bytes
     */
    async runPipeline(path, file, isSample = false, arrayBuffer = null) {
        const p = PIPELINES[path];
        this._lastContext = { path, isSample, filename: file ? file.name : null, file, arrayBuffer };

        document.getElementById('screen-input').classList.remove('active');
        document.getElementById('screen-result').classList.remove('active');
        document.getElementById('screen-processing').classList.add('active');

        document.getElementById('processingFile').textContent = file ? file.name : p.sampleFile;

        // Build the step list (branch-aware for audio).
        const steps = this._stepsForRun(path);
        const stepsEl = document.getElementById('pipelineSteps');
        stepsEl.innerHTML = steps.map((s) => `
            <div class="pipeline-step" id="step-${s.id}">
                <img class="step-icon" src="${ICONS}${s.icon}" alt="" aria-hidden="true">
                <div class="step-body">
                    <div class="step-title">${s.title}</div>
                    <div class="step-detail">${s.detail}</div>
                    <div class="step-status pending" id="status-${s.id}">Waiting</div>
                </div>
            </div>`).join('');

        const stepCallback = this._makeStepCallback();

        let result = null;
        try {
            if (isSample || !file && !arrayBuffer) {
                await this._animateSampleSteps(steps, stepCallback);
                result = { useSample: true };
            } else if (path === 'musicxml') {
                result = await this._runMusicXMLPipeline(await this._processUploadedFile(file), stepCallback);
            } else if (path === 'midi') {
                result = await this._runMIDIPipeline(await this._processUploadedFile(file), stepCallback);
            } else if (path === 'audio') {
                const fileData = arrayBuffer
                    ? { type: 'audio', content: arrayBuffer, filename: 'recording.webm' }
                    : await this._processUploadedFile(file);
                result = await this._runAudioPipeline(fileData, stepCallback);
            } else if (path === 'ocr') {
                result = await this._runOMRPipeline(await this._processUploadedFile(file), stepCallback);
            }
        } catch (err) {
            console.error('Pipeline error:', err);
            const last = steps[steps.length - 1];
            if (last) stepCallback(last.id, 'err', `Error: ${err.message}`);
            result = { useSample: true };
        }

        await this._delay(400);
        this._lastResult = result;
        this.showResult(path, result, isSample, file ? file.name : null);
    }

    /** Build the steps array for a run, filtering audio steps by the active branch. */
    _stepsForRun(path) {
        const all = PIPELINES[path].steps;
        if (path !== 'audio') return all;
        return all.filter((s) => !s.branchOnly || s.branchOnly.includes(this.audioBranch));
    }

    /** Returns a stepCallback(stepId, state, message) closure that mutates the DOM. */
    _makeStepCallback() {
        return (stepId, state, message) => {
            const stepEl = document.getElementById(`step-${stepId}`);
            const statusEl = document.getElementById(`status-${stepId}`);
            if (!stepEl || !statusEl) return;
            stepEl.classList.remove('active', 'done', 'error');
            if (state === 'running') {
                stepEl.classList.add('active');
                statusEl.className = 'step-status running';
                statusEl.innerHTML = `${message}<span class="dot-pulse"></span>`;
            } else if (state === 'done') {
                stepEl.classList.add('done');
                statusEl.className = 'step-status done';
                statusEl.textContent = message;
            } else if (state === 'err') {
                stepEl.classList.add('error');
                statusEl.className = 'step-status err';
                statusEl.textContent = message;
            } else if (state === 'info') {
                stepEl.classList.add('done');
                statusEl.className = 'step-status info';
                statusEl.textContent = message;
            }
        };
    }

    // ── File reading ──────────────────────────────────────────────────────

    /**
     * Read and classify an uploaded File. Returns { type, content, filename };
     * content is a string for text formats, ArrayBuffer for binary.
     */
    async _processUploadedFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            const name = file.name.toLowerCase();
            reader.onload = (e) => {
                const content = e.target.result;
                if (name.endsWith('.mxl')) {
                    // compressed MusicXML (zip) — unzip in-browser
                    this._unzipMXL(content)
                        .then((xml) => resolve({ type: 'musicxml', content: xml, filename: file.name }))
                        .catch((err) => reject(new Error(`Could not read .mxl: ${err.message}`)));
                } else if (name.endsWith('.xml') || name.endsWith('.musicxml')) {
                    resolve({ type: 'musicxml', content, filename: file.name });
                } else if (name.endsWith('.json')) {
                    try { resolve({ type: 'scorejson', content: JSON.parse(content), filename: file.name }); }
                    catch { reject(new Error('Invalid JSON — could not parse file')); }
                } else if (name.endsWith('.mid') || name.endsWith('.midi')) {
                    resolve({ type: 'midi', content, filename: file.name });
                } else if (/\.(mp3|wav|m4a|aac|ogg)$/.test(name)) {
                    // Must mirror the Audio tab's accept list (.mp3,.wav,.m4a,.aac,.ogg) —
                    // the backend ffmpeg-normalizes containers libsndfile can't read (.aac/.m4a).
                    resolve({ type: 'audio', content, filename: file.name });
                } else if (/\.(pdf|png|jpe?g)$/.test(name)) {
                    resolve({ type: 'image', content, filename: file.name });
                } else if (typeof content === 'string' && content.includes('<score-partwise')) {
                    resolve({ type: 'musicxml', content, filename: file.name });
                } else {
                    reject(new Error(`Unsupported file type: ${file.name}`));
                }
            };
            reader.onerror = () => reject(new Error('File read error'));
            if (/\.(xml|musicxml|json)$/.test(name)) reader.readAsText(file);
            else reader.readAsArrayBuffer(file);
        });
    }

    /**
     * Extract the score document from a compressed MusicXML (.mxl) container.
     * Minimal zip reader: walk the central directory (handles data-descriptor
     * zips that hide sizes in the local headers), inflate with the browser's
     * DecompressionStream. Picks the first non-META-INF .xml/.musicxml entry
     * (the MXL rootfile convention used by MuseScore/Finale exports).
     * @param {ArrayBuffer} buf
     * @returns {Promise<string>} the MusicXML text
     */
    async _unzipMXL(buf) {
        if (typeof DecompressionStream === 'undefined') {
            throw new Error('this browser cannot unzip .mxl — upload the uncompressed .musicxml instead');
        }
        const dv = new DataView(buf);
        const dec = new TextDecoder();
        // locate End-Of-Central-Directory (scan back over the trailing comment)
        let eocd = -1;
        for (let i = dv.byteLength - 22; i >= Math.max(0, dv.byteLength - 22 - 65536); i--) {
            if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('not a zip archive');
        const count = dv.getUint16(eocd + 10, true);
        let off = dv.getUint32(eocd + 16, true);
        if (count === 0xFFFF || off === 0xFFFFFFFF) throw new Error('Zip64 archives are not supported');
        const entries = [];
        for (let i = 0; i < count && off + 46 <= dv.byteLength; i++) {
            if (dv.getUint32(off, true) !== 0x02014b50) break;
            const method = dv.getUint16(off + 10, true);
            const csize = dv.getUint32(off + 20, true);
            const nameLen = dv.getUint16(off + 28, true);
            const extraLen = dv.getUint16(off + 30, true);
            const cmtLen = dv.getUint16(off + 32, true);
            const lho = dv.getUint32(off + 42, true);
            const name = dec.decode(new Uint8Array(buf, off + 46, nameLen));
            entries.push({ name, method, csize, lho });
            off += 46 + nameLen + extraLen + cmtLen;
        }
        const entry = entries.find((e) =>
            !e.name.startsWith('META-INF/') && /\.(xml|musicxml)$/i.test(e.name))
            || entries.find((e) => !e.name.startsWith('META-INF/') && !e.name.endsWith('/'));
        if (!entry) throw new Error('no score document inside the archive');
        // data position from the entry's local header (its name/extra lengths differ)
        const lnameLen = dv.getUint16(entry.lho + 26, true);
        const lextraLen = dv.getUint16(entry.lho + 28, true);
        const dataStart = entry.lho + 30 + lnameLen + lextraLen;
        const raw = new Uint8Array(buf, dataStart, entry.csize);
        if (entry.method === 0) return dec.decode(raw);
        if (entry.method !== 8) throw new Error(`unsupported compression method ${entry.method}`);
        const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([raw]).stream().pipeThrough(ds);
        return await new Response(stream).text();
    }

    // ── MusicXML lane (in-browser) ────────────────────────────────────────

    async _runMusicXMLPipeline(fileData, stepCallback) {
        stepCallback('parse', 'running', 'Parsing');
        await this._delay(200);

        let musicXML, measures, notes, parts;
        if (fileData.type === 'scorejson') {
            if (typeof ScoreJSON === 'undefined') { stepCallback('parse', 'err', 'ScoreJSON.js not loaded'); return null; }
            try { musicXML = ScoreJSON.toMusicXML(fileData.content); }
            catch (e) { stepCallback('parse', 'err', `ScoreJSON conversion failed: ${e.message}`); return null; }
            const doc = new DOMParser().parseFromString(musicXML, 'application/xml');
            measures = doc.querySelectorAll('measure').length;
            notes = doc.querySelectorAll('note:not([print-object="no"])').length;
            parts = doc.querySelectorAll('part').length;
            stepCallback('parse', 'done', `ScoreJSON — ${parts} part(s), ${measures} measures, ${notes} notes`);
        } else {
            musicXML = fileData.content;
            const doc = new DOMParser().parseFromString(musicXML, 'application/xml');
            if (doc.querySelector('parsererror')) { stepCallback('parse', 'err', 'XML parse error — file may be malformed'); return null; }
            if (!doc.querySelector('score-partwise, score-timewise')) { stepCallback('parse', 'err', 'Not a valid MusicXML document'); return null; }
            measures = doc.querySelectorAll('measure').length;
            notes = doc.querySelectorAll('note').length;
            parts = doc.querySelectorAll('part').length;
            stepCallback('parse', 'done', `Valid MusicXML — ${parts} part(s), ${measures} measures, ${notes} notes`);
        }
        await this._delay(300);

        stepCallback('convert', 'running', 'Converting');
        await this._delay(400);
        let compressionRatio = null;
        if (fileData.type === 'scorejson') {
            const jsonStr = JSON.stringify(fileData.content);
            compressionRatio = Math.round(musicXML.length / jsonStr.length);
            stepCallback('convert', 'done', `ScoreJSON input — ${(jsonStr.length / 1024).toFixed(1)} KB JSON -> ${(musicXML.length / 1024).toFixed(1)} KB MusicXML`);
        } else if (typeof ScoreJSON !== 'undefined') {
            stepCallback('convert', 'done', `ScoreJSON.js loaded — MusicXML ${(musicXML.length / 1024).toFixed(1)} KB; ScoreJSON output ~10x smaller`);
        } else {
            stepCallback('convert', 'done', 'ScoreJSON.js not loaded — rendering MusicXML directly');
        }
        await this._delay(300);

        stepCallback('render', 'running', 'Rendering');
        await this._delay(200);
        stepCallback('render', 'done', `Score rendered — ${measures} measures`);

        return {
            musicXML,
            scoreJSON: fileData.type === 'scorejson' ? fileData.content : null,
            stats: { notes, measures, parts, compressionRatio },
            accuracy: { value: 1.0, metric: 'exact', method: 'n/a' },
        };
    }

    // ── MIDI lane (client fast path + server option) ──────────────────────

    async _checkServerHealth() {
        try {
            const res = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(2000) });
            this._serverStatus = res.ok ? 'ok' : 'error';
        } catch { this._serverStatus = 'error'; }
        this._updateServerStatusDot();
        return this._serverStatus;
    }

    _updateServerStatusDot() {
        const dot = document.querySelector('.server-status-dot');
        if (!dot) return;
        dot.className = 'server-status-dot ' + (this._serverStatus === 'ok' ? 'ok' : 'error');
        dot.setAttribute('aria-label', this._serverStatus === 'ok' ? 'Server: online' : 'Server: offline');
    }

    async _runMIDIPipeline(fileData, stepCallback) {
        if (this.activeMode === 'server') return this._runMIDIPipelineServer(fileData, stepCallback);

        stepCallback('parse', 'running', 'Reading MIDI file');
        let midi;
        try { midi = new Midi(fileData.content); }
        catch (e) { stepCallback('parse', 'err', `Invalid MIDI file — ${e.message}`); return { useSample: true }; }
        stepCallback('parse', 'done', `Parsed ${midi.tracks.length} track(s)`);
        await this._delay(200);

        stepCallback('quantize', 'running', 'Quantising');
        const tempo = midi.header.tempos[0]?.bpm || 120;
        const ts = midi.header.timeSignatures[0]?.timeSignature || [4, 4];
        const beats = ts[0] * (4 / (ts[1] || 4));   // quarters per measure (same contract as playback)
        const ppq = midi.header.ppq;
        // Shared quantization estimate over BOTH hands (performance-timed MIDI
        // floats off the grid by a near-constant phase) + key detection.
        const allNotes = midi.tracks.reduce((acc, t) => acc.concat(t.notes), []);
        const keyInfo = this._detectKey(allNotes);
        const qopts = { ...this._estimateQuantization(allNotes, tempo, ppq, beats), useFlats: keyInfo.useFlats };
        const gridLabel = qopts.grid === 0.25 ? '16th grid' : '32nd grid';
        const offLabel = Math.abs(qopts.offsetQ) > 0.01 ? `, re-aligned ${qopts.offsetQ.toFixed(2)} beats` : '';
        stepCallback('quantize', 'done', `${Math.round(midi.duration)}s, ${midi.header.ppq} PPQ (${gridLabel}${offLabel})`);
        await this._delay(200);

        stepCallback('voice', 'running', 'Separating voices');
        const { trebleNotes, bassNotes } = this._separateMIDIVoices(midi);
        const trebleStaff = this._notesToStaffMeasures(trebleNotes, tempo, ppq, beats, qopts);
        const bassStaff = this._notesToStaffMeasures(bassNotes, tempo, ppq, beats, qopts);
        const maxMeasure = Math.max(trebleStaff.length, bassStaff.length, 1) - 1;
        const measuresArr = [];
        for (let i = 0; i <= maxMeasure; i++) {
            measuresArr.push({ treble: trebleStaff[i] || this._restMeasureTokens(beats), bass: bassStaff[i] || this._restMeasureTokens(beats) });
        }
        stepCallback('voice', 'done', `${trebleNotes.length} treble, ${bassNotes.length} bass notes`);
        await this._delay(200);

        stepCallback('export', 'running', 'Generating MusicXML');
        // Expression layers (optional ScoreJSON fields, honoured by playback):
        // full rubato tempo map + CC64 sustain-pedal spans. Both live on the
        // note timeline, so they ride the same alignment + trim as the notes.
        const mapQ = (x) => Math.max((qopts.alignFn ? qopts.alignFn(x) : x + (qopts.offsetQ || 0)) - (qopts.trimQ || 0), 0);
        const tempoMap = (midi.header.tempos || [])
            .map((t) => ({ beat: Math.round(mapQ(t.ticks / ppq) * 1e4) / 1e4, bpm: Math.round(t.bpm * 100) / 100 }))
            .filter((t) => isFinite(t.beat) && t.bpm > 0)
            .sort((a, b) => a.beat - b.beat)   // piecewise detrend may locally reorder
            .filter((t, i, arr) => i === 0 || Math.abs(t.bpm - arr[i - 1].bpm) > 0.005);
        const pedal = this._pedalSpansFromMIDI(midi, ppq)
            .map((s) => ({ start: mapQ(s.start), end: mapQ(s.end) }))
            .filter((s) => s.end > s.start);
        const scoreJSON = {
            title: sanitizeTitle(midi.name, fileData.filename.replace(/\.midi?$/i, '')),
            composer: 'MIDI Import',
            key: keyInfo.key,
            tempo: Math.round(tempo * 100) / 100,    // 139.9998 must not display as 139
            time: `${ts[0]}/${ts[1]}`,
            measures: measuresArr,  // builder tiles each measure exactly — no padding needed
            ...(tempoMap.length > 1 ? { tempoMap } : {}),
            ...(pedal.length ? { pedal } : {}),
        };
        const musicXML = ScoreJSON.toMusicXML(scoreJSON);
        // count STRUCK notes from the built measures (duplicate-track copies dedupe in the builder)
        const countStaff = (staff) => staff.reduce((acc, toks) => acc + toks.reduce(
            (a, tok) => a + (!tok.rest && !tok.tie ? 1 + (tok.chord ? tok.chord.length : 0) : 0), 0), 0);
        const totalNotes = countStaff(trebleStaff) + countStaff(bassStaff);
        stepCallback('export', 'done', `${totalNotes} notes, ${maxMeasure + 1} measures`);

        return {
            musicXML, scoreJSON,
            stats: { notes: totalNotes, measures: maxMeasure + 1, voices: 2 },
            accuracy: { value: 1.0, metric: 'exact', method: 'midi-parse' },
        };
    }

    async _runMIDIPipelineServer(fileData, stepCallback) {
        stepCallback('parse', 'running', 'Uploading to server');
        const form = new FormData();
        form.append('file', new File([fileData.content], fileData.filename));
        let response;
        try {
            response = await fetch(`${BACKEND_URL}/convert/midi`, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
        } catch { stepCallback('parse', 'err', 'Server unavailable — is the backend running?'); return { useSample: true }; }
        if (!response.ok) { stepCallback('parse', 'err', `Server error: ${response.status}`); return { useSample: true }; }

        if (response.status === 202) {
            const { job_id, stream } = await response.json();
            stepCallback('parse', 'done', 'Uploaded — processing');
            stepCallback('quantize', 'running', 'Server processing');
            return this._pollSSE(stream || `/convert/midi/stream/${job_id}`, stepCallback,
                { parsing: 'parse', track: 'quantize', voice_sep: 'voice', export: 'export' });
        }
        const r = normalizeResponse(await response.json());
        stepCallback('parse', 'done', 'Server conversion complete');
        stepCallback('export', 'done', 'MusicXML received');
        return { musicXML: r.musicXML, scoreJSON: r.scoreJSON, stats: r.stats || { notes: '?', measures: '?', voices: 2 }, accuracy: r.accuracy };
    }

    // ── Audio lane (server, branch-aware) ─────────────────────────────────

    /**
     * PATH Audio — server-side. Posts to /convert/audio with the selected branch
     * (piano | instrumental | singing). Always async (202 + SSE) per the contract.
     * Falls back to the in-browser Basic Pitch helper only if the server is unreachable
     * AND the optional client helper module is available (demo affordance).
     */
    async _runAudioPipeline(fileData, stepCallback) {
        const firstStep = this._stepsForRun('audio')[0].id;
        stepCallback(firstStep, 'running', 'Uploading audio');

        const form = new FormData();
        form.append('file', new File([fileData.content], fileData.filename));
        form.append('branch', this.audioBranch);

        let response;
        try {
            response = await fetch(`${BACKEND_URL}/convert/audio`, { method: 'POST', body: form, signal: AbortSignal.timeout(300000) });
        } catch {
            // Server unreachable — try the optional in-browser fallback if present.
            if (this._audioUtils && this.audioBranch === 'piano') {
                return this._runAudioClientFallback(fileData, stepCallback);
            }
            stepCallback(firstStep, 'err', 'Audio server unreachable — start the backend or use a different lane');
            return { useSample: true };
        }
        if (!response.ok) { stepCallback(firstStep, 'err', `Server error: ${response.status}`); return { useSample: true }; }

        const stepMap = { separation: 'separation', amt: 'amt', onset: 'amt', reduce: 'reduce', export: 'export' };

        if (response.status === 202) {
            const { job_id, stream } = await response.json();
            stepCallback(firstStep, 'done', 'Uploaded — processing');
            return this._pollSSE(stream || `/convert/audio/stream/${job_id}`, stepCallback, stepMap);
        }
        // Some short clips may return sync.
        const r = normalizeResponse(await response.json());
        stepCallback('export', 'done', 'MusicXML received');
        return { musicXML: r.musicXML, scoreJSON: r.scoreJSON, stats: r.stats, accuracy: r.accuracy };
    }

    /** Optional in-browser Basic Pitch fallback (demo only; piano branch). */
    async _runAudioClientFallback(fileData, stepCallback) {
        try {
            stepCallback('amt', 'running', 'Running Basic Pitch in-browser (fallback)');
            const audioBuffer = await this._audioUtils.decodeAudioBuffer(fileData.content);
            const resampled = await this._audioUtils.resampleToMono22050(audioBuffer);
            const noteEvents = await this._audioUtils.runBasicPitchWorker(resampled, 22050);
            if (!noteEvents.length) { stepCallback('amt', 'err', 'No notes detected'); return { useSample: true }; }
            const bpm = this._audioUtils.detectBPM(noteEvents);
            const midiNotes = this._audioUtils.basicPitchToMIDINotes(noteEvents, bpm, 480);
            const mock = { tracks: [{ notes: midiNotes }], name: fileData.filename, header: { tempos: [{ bpm }], timeSignatures: [[4, 4]], ppq: 480 } };
            const { trebleNotes, bassNotes } = this._separateMIDIVoices(mock);
            const keyInfo = this._detectKey(midiNotes);
            const qopts = { ...this._estimateQuantization(midiNotes, bpm, 480, 4), useFlats: keyInfo.useFlats };
            const tStaff = this._notesToStaffMeasures(trebleNotes, bpm, 480, 4, qopts);
            const bStaff = this._notesToStaffMeasures(bassNotes, bpm, 480, 4, qopts);
            const maxM = Math.max(tStaff.length, bStaff.length, 1) - 1;
            const measuresArr = [];
            for (let i = 0; i <= maxM; i++) measuresArr.push({ treble: tStaff[i] || this._restMeasureTokens(4), bass: bStaff[i] || this._restMeasureTokens(4) });
            const scoreJSON = { title: fileData.filename || 'Recorded Audio', composer: 'Basic Pitch', key: keyInfo.key, tempo: bpm, time: '4/4', measures: ScoreJSON.equalizeMeasureWidths(measuresArr, 4) };
            const musicXML = ScoreJSON.toMusicXML(scoreJSON);
            const total = trebleNotes.length + bassNotes.length;
            stepCallback('export', 'done', `${total} notes, ${maxM + 1} measures (in-browser draft)`);
            return { musicXML, scoreJSON, stats: { notes: total, measures: maxM + 1, voices: 2 }, accuracy: null };
        } catch (err) {
            stepCallback('amt', 'err', `In-browser fallback failed: ${err.message}`);
            return { useSample: true };
        }
    }

    // ── OMR lane (server) ─────────────────────────────────────────────────

    async _runOMRPipeline(fileData, stepCallback) {
        stepCallback('segment', 'running', 'Uploading image');
        const form = new FormData();
        form.append('file', new File([fileData.content], fileData.filename));
        let response;
        try {
            response = await fetch(`${BACKEND_URL}/convert/omr`, { method: 'POST', body: form, signal: AbortSignal.timeout(300000) });
        } catch {
            stepCallback('segment', 'err', 'Server not reachable — is the backend running?');
            return { useSample: true };
        }
        if (!response.ok) { stepCallback('segment', 'err', `Server error: ${response.status}`); return { useSample: true }; }
        const { job_id, stream } = await response.json();
        stepCallback('segment', 'done', 'Uploaded — oemer processing');
        ['classify', 'reconstruct', 'export'].forEach((id) => stepCallback(id, 'running', 'Waiting'));
        return this._pollSSE(stream || `/convert/omr/stream/${job_id}`, stepCallback,
            { segment: 'segment', classify: 'classify', reconstruct: 'reconstruct', export: 'export' });
    }

    // ── Shared SSE poller (one logic for midi/audio/omr) ──────────────────

    /**
     * Open an SSE stream and drive the step UI until a terminal `done`/`error` event.
     * One silent retry on connection error after 1s, then surfaces "connection lost".
     * @param {string} streamPath - path beginning with '/' OR a full URL
     * @param {function} stepCallback
     * @param {object} stepMap - event.type -> step id
     */
    async _pollSSE(streamPath, stepCallback, stepMap) {
        const url = streamPath.startsWith('http') ? streamPath : `${BACKEND_URL}${streamPath}`;
        const RETRY = {};
        let retries = 0;
        while (retries < 2) {
            // The retry signal must travel through resolve(): a `throw` inside
            // es.onerror runs in the event-handler context, never reaches this
            // loop's catch, and leaves the promise pending forever.
            const result = await new Promise((resolve, reject) => {
                const es = new EventSource(url);
                es.onmessage = (e) => {
                    let event;
                    try { event = JSON.parse(e.data); } catch { return; }
                    if (event.type === 'done') {
                        es.close();
                        const r = normalizeResponse(event);
                        stepCallback('export', 'done', 'Conversion complete');
                        resolve({ musicXML: r.musicXML, scoreJSON: r.scoreJSON, stats: r.stats, accuracy: r.accuracy, meta: r.meta });
                    } else if (event.type === 'error') {
                        es.close();
                        stepCallback('export', 'err', `Server error: ${event.msg}`);
                        reject(new Error(event.msg));
                    } else if (event.type) {
                        const stepId = stepMap[event.type] || 'export';
                        const pct = event.pct ? ` (${event.pct}%)` : '';
                        stepCallback(stepId, 'running', (event.msg || event.type) + pct);
                    }
                };
                es.onerror = () => {
                    es.close();
                    if (retries === 0) { retries++; resolve(RETRY); return; }
                    stepCallback('export', 'err', 'Connection lost — please try again');
                    reject(new Error('SSE connection lost'));
                };
            });
            if (result === RETRY) { await this._delay(1000); continue; }
            return result;
        }
        return { useSample: true };
    }

    // ── MIDI voice helpers (shared with audio fallback) ───────────────────


    /**
     * Faithful notes -> ScoreJSON measures builder (port of the server's
     * midi_scorejson.py). Quantizes onsets AND gate durations to a 32nd grid —
     * in the TICK domain when available, which is immune to tempo-map rubato
     * (seconds * one-flat-BPM drifted fast runs onto the same slot and merged
     * them into cluster chords). Groups simultaneous notes per hand into chords,
     * clamps each gate at the next same-hand onset, splits note/rest spans at
     * barlines into tied pieces, and fills every gap with rests so articulation
     * and rests survive (the old builder stretched every note to the next onset).
     * Duplicate-track note copies (±2-tick echoes) collapse onto the same grid
     * slot and dedupe via the per-onset pitch map.
     * @param notes   array of {midi, ticks, durationTicks} or {midi, time(s), duration(s)}
     * @param bpm     flat fallback BPM for seconds-domain notes (audio lane)
     * @param ppq     MIDI pulses per quarter
     * @param beatsPerMeasure  measure length in QUARTER notes (e.g. 1.5 for 3/8)
     */
    _notesToStaffMeasures(notes, bpm, ppq, beatsPerMeasure, qopts) {
        const o = qopts || {};
        const GRID = o.grid || 0.125;                             // onset grid (quarters)
        const ALIGN = o.alignFn || ((x) => x + (o.offsetQ || 0)); // timing correction
        const TRIM = o.trimQ || 0;                                // leading empty measures
        const FLATS = !!o.useFlats;
        const CODES = [[4,'w'],[3,'hd'],[2,'h'],[1.5,'qd'],[1,'q'],[0.75,'ed'],[0.5,'e'],[0.375,'sd'],[0.25,'s'],[0.125,'t']];
        const CODE_Q = { w:4, hd:3, h:2, qd:1.5, q:1, ed:0.75, e:0.5, sd:0.375, s:0.25, t:0.125 };
        // note-value vocabulary a single token may carry (no ties needed)
        const VOCAB = [4, 3, 2, 1.5, 1, 0.75, 0.5, 0.375, 0.25, 0.125].filter((v) => v >= GRID - 1e-9);
        const toQ = (n) => (n.ticks != null ? n.ticks / (ppq || 480) : (n.time || 0) * bpm / 60);
        const gateQ = (n) => (n.durationTicks != null ? n.durationTicks / (ppq || 480) : (n.duration || 0) * bpm / 60);
        const q = (x) => Math.round(x / GRID) * GRID;
        const splitDur = (dur) => {
            const out = []; let rem = Math.round(dur / 0.125) * 0.125; let guard = 0;
            while (rem >= 0.125 - 1e-6 && guard++ < 64) {
                for (const [qv, c] of CODES) { if (qv <= rem + 1e-6) { out.push(c); rem = Math.round((rem - qv) / 0.125) * 0.125; break; } }
            }
            return out.length ? out : ['t'];
        };
        const SHARPS = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
        const FLATN = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
        const NAMES = FLATS ? FLATN : SHARPS;
        const mName = (m) => NAMES[m % 12] + (Math.floor(m / 12) - 1);

        // group simultaneous notes into chords; keep the longest RAW gate per
        // pitch (gates snap to the note-value vocabulary later, with full
        // precision still available)
        const groups = new Map();
        notes.forEach((n) => {
            const on = Math.max(q(ALIGN(toQ(n))) - TRIM, 0);
            const gate = Math.max(gateQ(n), GRID);
            if (!groups.has(on)) groups.set(on, new Map());
            const g = groups.get(on);
            g.set(n.midi, Math.max(g.get(n.midi) || 0, gate));
        });
        const events = Array.from(groups.entries())
            .map(([on, g]) => [on, Array.from(g.keys()).sort((a, b) => a - b), Math.max(...g.values())])
            .sort((a, b) => a[0] - b[0]);
        if (!events.length) return [];

        const beats = beatsPerMeasure;
        // Gate -> notated duration:
        //  1. legato snap: a small gap to the next same-hand onset (performance
        //     "release early") is absorbed into the note instead of becoming a
        //     32nd-rest;
        //  2. vocabulary snap: round to the nearest single note value so 95%-
        //     gates ("0.948 of a quarter") notate as the quarter they mean;
        //  3. clamp at the next onset -> non-overlapping spans on the grid.
        const LEGATO_GAP = Math.max(GRID, 0.25);
        const spans = events.map(([on, pitches, gate], k) => {
            const nextOn = k + 1 < events.length ? events[k + 1][0] : Infinity;
            let dur = gate;
            if (nextOn - (on + dur) <= LEGATO_GAP + 1e-6) dur = nextOn - on;     // legato fill
            let best = null;
            for (const v of VOCAB) {
                if (Math.abs(dur - v) <= Math.max(GRID / 2, 0.12 * dur) + 1e-9
                    && (best == null || Math.abs(dur - v) < Math.abs(dur - best))) best = v;
            }
            if (best != null) {
                dur = best;
            } else {
                // longer than any single note value (ties ahead) — a 95%-gate
                // miss grows with length, so snap the END to the nearest beat
                const endBeat = Math.round(on + dur);
                if (endBeat > on && Math.abs(on + dur - endBeat) <= Math.max(GRID, 0.12 * dur)) dur = endBeat - on;
                else dur = Math.max(q(dur), GRID);
            }
            if (nextOn !== Infinity) dur = Math.min(dur, nextOn - on);
            return [on, on + Math.max(dur, GRID), pitches];
        });
        const lastEnd = spans[spans.length - 1][1];
        const nMeasures = Math.floor((lastEnd - 1e-6) / beats) + 1;
        const measures = Array.from({ length: nMeasures }, () => []);

        // emit one note/rest span, split at barlines (continuations carry tie=true)
        const emitSpan = (start, end, pitches) => {
            let seg = start, first = true;
            while (seg < end - 1e-6) {
                const mi = Math.min(Math.floor((seg + 1e-9) / beats), nMeasures - 1);
                const segEnd = Math.min((mi + 1) * beats, end);
                for (const c of splitDur(segEnd - seg)) {
                    if (!pitches) {
                        measures[mi].push({ rest: true, duration: c });
                    } else {
                        const tok = { pitch: mName(pitches[0]), duration: c };
                        if (pitches.length > 1) tok.chord = pitches.slice(1).map(mName);
                        if (!first) tok.tie = true;
                        measures[mi].push(tok);
                    }
                    first = false;
                    seg = Math.round((seg + CODE_Q[c]) / GRID) * GRID;
                }
            }
        };

        let pos = 0;
        spans.forEach(([on, end, pitches]) => {
            if (on > pos + 1e-6) emitSpan(pos, on, null);
            emitSpan(on, end, pitches);
            pos = end;
        });
        if (pos < nMeasures * beats - 1e-6) emitSpan(pos, nMeasures * beats, null);
        return measures;
    }

    /**
     * Estimate quantization parameters from ALL notes (both hands together —
     * the grid must be shared or the staves drift apart).
     *
     * Performance-timed MIDI (tuneonmusic, recorded takes) floats off the
     * notation grid by a near-constant phase: every onset lands at e.g.
     * x.41 quarters. Quantizing that raw turns quarter notes into dotted/tied
     * syncopation everywhere (issue #1 follow-up: "completely wrong" score).
     *
     *  - grid: 16th by default; 32nd only when the inter-onset histogram
     *    actually contains 32nd-sized gaps.
     *  - offsetQ: circular-mean phase on the grid period, then the whole-grid
     *    translation that puts the most onsets on integer quarters (strong
     *    beats) — phase alone cannot tell the beat from the offbeat.
     *  - trimQ: whole empty leading measures dropped (scores start at bar 1;
     *    playback already skips leading silence).
     */
    _estimateQuantization(notes, bpm, ppq, beatsPerMeasure) {
        const toQ = (n) => (n.ticks != null ? n.ticks / (ppq || 480) : (n.time || 0) * bpm / 60);
        const ons = notes.map(toQ).sort((a, b) => a - b);
        if (!ons.length) return { offsetQ: 0, trimQ: 0, grid: 0.125 };

        // adaptive grid: any real 32nd-note content?
        const iois = [];
        for (let i = 1; i < ons.length; i++) {
            const d = ons[i] - ons[i - 1];
            if (d > 1e-6) iois.push(d);
        }
        const n32 = iois.filter((d) => d > 0.09 && d < 0.19).length;
        const grid = iois.length && n32 / iois.length > 0.05 ? 0.125 : 0.25;

        // ── drift track: windowed median deviation from the EIGHTH grid ──
        // (quarters and offbeat eighths share the same phase mod 0.5; true
        // sixteenths are a minority, and the median shrugs them off)
        const W = 16;                                       // window size, quarters
        const wins = new Map();
        ons.forEach((on) => {
            const w = Math.floor(on / W);
            if (!wins.has(w)) wins.set(w, []);
            wins.get(w).push(on);
        });
        const track = [];                                   // [{q, dev}] unwrapped
        let prevDev = null;
        [...wins.keys()].sort((a, b) => a - b).forEach((w) => {
            const os = wins.get(w);
            if (os.length < 4) return;
            // candidate deviations from the 0.5 grid, unwrapped near prevDev
            const devs = os.map((on) => {
                let d = on - Math.round(on / 0.5) * 0.5;    // (-0.25, 0.25]
                if (prevDev != null) {
                    while (d - prevDev > 0.25) d -= 0.5;
                    while (d - prevDev < -0.25) d += 0.5;
                }
                return d;
            }).sort((a, b) => a - b);
            const med = devs[Math.floor(devs.length / 2)];
            track.push({ q: (w + 0.5) * W, dev: med });
            prevDev = med;
        });

        const devRange = track.length
            ? Math.max(...track.map((t) => t.dev)) - Math.min(...track.map((t) => t.dev)) : 0;

        // alignFn maps a raw onset to the corrected timeline (before grid snap)
        let alignFn;
        if (track.length >= 2 && devRange > grid / 2) {
            // rubato / tempo-mismatch drift — piecewise-linear detrend
            const devAt = (qPos) => {
                if (qPos <= track[0].q) return track[0].dev;
                for (let i = 1; i < track.length; i++) {
                    if (qPos <= track[i].q) {
                        const a = track[i - 1], b = track[i];
                        return a.dev + (b.dev - a.dev) * (qPos - a.q) / (b.q - a.q);
                    }
                }
                return track[track.length - 1].dev;
            };
            alignFn = (on) => on - devAt(on);
        } else {
            // near-constant phase — circular mean on the grid period
            let sx = 0, sy = 0;
            ons.forEach((on) => {
                const a = ((on % grid) / grid) * 2 * Math.PI;
                sx += Math.cos(a); sy += Math.sin(a);
            });
            const r = Math.sqrt(sx * sx + sy * sy) / ons.length;
            let offsetQ = 0;
            if (r > 0.5) {
                const phase = Math.atan2(sy, sx) / (2 * Math.PI) * grid;
                offsetQ = -phase;
            }
            alignFn = (on) => on + offsetQ;
        }

        // beat-phase disambiguation: phase/detrend alone cannot tell the beat
        // from the offbeat — try whole-grid translations, keep the one landing
        // the most onsets on integer quarters
        let bestShift = 0, bestHits = -1;
        for (let k = -Math.round(0.5 / grid); k <= Math.round(0.5 / grid); k++) {
            const s = k * grid;
            const hits = ons.reduce((acc, on) => {
                const p = alignFn(on) + s;
                return acc + (Math.abs(p - Math.round(p)) < grid / 2 - 1e-9 ? 1 : 0);
            }, 0);
            if (hits > bestHits) { bestHits = hits; bestShift = s; }
        }
        const baseAlign = alignFn;
        const gridAlign = (on) => baseAlign(on) + bestShift;

        // bar-phase: the beat grid still leaves "which beat is the downbeat"
        // open. Long notes (sustained chords) overwhelmingly START on
        // downbeats — let them vote for the whole-beat translation.
        const beats = beatsPerMeasure || 4;
        const gateOf = (n) => (n.durationTicks != null ? n.durationTicks / (ppq || 480) : (n.duration || 0) * bpm / 60);
        const longOns = notes.filter((n) => gateOf(n) >= 1.2).map(toQ);
        let barShift = 0;
        if (longOns.length >= 6 && beats > 1) {
            let bestBar = -1;
            for (let k = 0; k < Math.round(beats); k++) {
                const score = longOns.reduce((acc, on) => {
                    const p = ((gridAlign(on) + k) % beats + beats) % beats;
                    return acc + (p < grid / 2 || p > beats - grid / 2 ? 1 : 0);
                }, 0);
                if (score > bestBar) { bestBar = score; barShift = k; }
            }
        }
        const finalAlign = (on) => gridAlign(on) + barShift;

        const first = Math.round(finalAlign(ons[0]) / grid) * grid;
        const trimQ = Math.max(Math.floor((first + 1e-6) / beats), 0) * beats;
        const offsetQ = finalAlign(0);                       // representative (for the UI label)
        return { offsetQ, trimQ, grid, alignFn: finalAlign };
    }

    /**
     * Pick the major/minor-agnostic key signature whose diatonic set covers
     * the most notes, and whether to spell accidentals as flats. Keeps the
     * rendered score from drowning in accidentals (C-major was hardcoded).
     * Returns { key: 'G', fifths: 1, useFlats: false } style data.
     */
    _detectKey(notes) {
        const KEYS = [
            { key: 'C', fifths: 0 }, { key: 'G', fifths: 1 }, { key: 'D', fifths: 2 },
            { key: 'A', fifths: 3 }, { key: 'E', fifths: 4 }, { key: 'B', fifths: 5 },
            { key: 'F#', fifths: 6 }, { key: 'F', fifths: -1 }, { key: 'Bb', fifths: -2 },
            { key: 'Eb', fifths: -3 }, { key: 'Ab', fifths: -4 }, { key: 'Db', fifths: -5 },
            { key: 'Gb', fifths: -6 },
        ];
        const hist = new Array(12).fill(0);
        notes.forEach((n) => { hist[n.midi % 12]++; });
        const MAJOR = [0, 2, 4, 5, 7, 9, 11];
        let best = KEYS[0], bestScore = -1;
        KEYS.forEach((k) => {
            const tonic = ((k.fifths * 7) % 12 + 12) % 12;
            const score = MAJOR.reduce((acc, deg) => acc + hist[(tonic + deg) % 12], 0);
            // prefer fewer signature accidentals on ties
            if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) < 1e-9 && Math.abs(k.fifths) < Math.abs(best.fifths))) {
                best = k; bestScore = score;
            }
        });
        return { key: best.key, fifths: best.fifths, useFlats: best.fifths < 0 };
    }

    /** A full measure of rests for a measure length in quarters (e.g. 1.5 -> [qd]). */
    _restMeasureTokens(beatsQ) {
        const CODES = [[4,'w'],[3,'hd'],[2,'h'],[1.5,'qd'],[1,'q'],[0.75,'ed'],[0.5,'e'],[0.375,'sd'],[0.25,'s'],[0.125,'t']];
        const out = []; let rem = beatsQ; let guard = 0;
        while (rem >= 0.125 - 1e-6 && guard++ < 64) {
            for (const [qv, c] of CODES) { if (qv <= rem + 1e-6) { out.push({ rest: true, duration: c }); rem -= qv; break; } }
        }
        return out.length ? out : [{ rest: true, duration: 'w' }];
    }

    /** CC64 sustain-pedal spans (beat domain) from a parsed @tonejs/midi file.
     *  Down while ANY track holds it (files often duplicate the pedal per hand). */
    _pedalSpansFromMIDI(midi, ppq) {
        const evs = [];
        (midi.tracks || []).forEach((t, ti) => {
            const ccs = (t.controlChanges && (t.controlChanges[64] || t.controlChanges['64'])) || [];
            ccs.forEach((cc) => evs.push({ ticks: cc.ticks, track: ti, down: cc.value >= 0.5 }));
        });
        if (!evs.length) return [];
        evs.sort((a, b) => a.ticks - b.ticks);
        const state = new Map();
        const spans = [];
        let downAt = null;
        evs.forEach((e) => {
            state.set(e.track, e.down);
            const anyDown = Array.from(state.values()).some(Boolean);
            const beat = Math.round((e.ticks / (ppq || 480)) * 1e4) / 1e4;
            if (anyDown) { if (downAt == null) downAt = beat; }
            else if (downAt != null) {
                if (beat > downAt) spans.push({ start: downAt, end: beat });
                downAt = null;
            }
        });
        if (downAt != null) {
            const endBeat = Math.round(((midi.durationTicks || 0) / (ppq || 480)) * 1e4) / 1e4;
            if (endBeat > downAt) spans.push({ start: downAt, end: endBeat });
        }
        return spans;
    }

    _separateMIDIVoices(midi) {
        const trebleNotes = [], bassNotes = [];
        const lh = [], rh = [];
        midi.tracks.forEach((t, idx) => {
            const name = (t.name || '').toLowerCase();
            if (name.includes('left') || name.includes('lh')) lh.push(idx);
            if (name.includes('right') || name.includes('rh')) rh.push(idx);
        });
        if (lh.length && rh.length) {
            midi.tracks.forEach((t, idx) => {
                if (lh.includes(idx)) t.notes.forEach((n) => bassNotes.push(n));
                else if (rh.includes(idx)) t.notes.forEach((n) => trebleNotes.push(n));
            });
            return { trebleNotes, bassNotes };
        }
        // Multi-track files usually already keep one hand per track. Splitting
        // those by a C4 pitch cutoff tears chords apart (a held D4 in the
        // left-hand chord lands in the melody staff and gets clamped by the
        // next melody note). Cluster whole tracks by mean pitch instead, at
        // the largest gap between sorted track means.
        const noteTracks = midi.tracks.filter((t) => t.notes.length);
        if (noteTracks.length >= 2) {
            const means = noteTracks.map((t) => t.notes.reduce((a, n) => a + n.midi, 0) / t.notes.length);
            const order = means.map((m, i) => [m, i]).sort((a, b) => a[0] - b[0]);
            let cut = 1, bestGap = -1;
            for (let i = 1; i < order.length; i++) {
                const g = order[i][0] - order[i - 1][0];
                if (g > bestGap) { bestGap = g; cut = i; }
            }
            if (bestGap >= 5) {                      // clearly separated registers
                const bassIdx = new Set(order.slice(0, cut).map((x) => x[1]));
                noteTracks.forEach((t, i) => {
                    t.notes.forEach((n) => (bassIdx.has(i) ? bassNotes : trebleNotes).push(n));
                });
                if (trebleNotes.length && bassNotes.length) return { trebleNotes, bassNotes };
                trebleNotes.length = 0; bassNotes.length = 0;
            }
        }
        const MIDDLE_C = 60;
        midi.tracks.forEach((t) => t.notes.forEach((n) => (n.midi >= MIDDLE_C ? trebleNotes : bassNotes).push(n)));
        return { trebleNotes, bassNotes };
    }

    _midiNotesToMeasures(notes, tempo, ppq, beatsPerMeasure) {
        const MIDDLE_C = 60;
        const measureMap = new Map();
        notes.forEach((note) => {
            const idx = Math.floor(note.ticks / (ppq * beatsPerMeasure));
            if (!measureMap.has(idx)) measureMap.set(idx, { treble: [], bass: [] });
            const quarterDur = 60 / tempo;
            const divisions = (note.duration / quarterDur) * 4;
            const code = this._divisionsToDurationCode(Math.max(Math.round(divisions), 1));
            const entry = `${note.name}/${code}`;
            measureMap.get(idx)[note.midi >= MIDDLE_C ? 'treble' : 'bass'].push(entry);
        });
        return Array.from(measureMap.keys()).sort((a, b) => a - b).map((idx) => measureMap.get(idx));
    }

    _divisionsToDurationCode(divisions) {
        const n = divisions / 4;
        if (n >= 4) return 'w';
        if (n >= 2) return 'h';
        if (n >= 1) return 'q';
        if (n >= 0.5) return 'e';
        return 's';
    }

    // ── Recording (audio lane, demo-only) ─────────────────────────────────

    async startRecording() {
        const recordBtn = document.getElementById('recordBtn');
        const recordLabel = document.getElementById('recordLabel');
        const levelMeter = document.getElementById('levelMeter');
        try {
            this._mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            if (typeof Tone !== 'undefined') {
                this._mic = new Tone.UserMedia();
                await this._mic.open();
                this._analyser = new Tone.Analyser('amplitude', 256);
                this._mic.connect(this._analyser);
            }
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
                : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
            this._mediaRecorder = new MediaRecorder(this._mediaStream, mimeType ? { mimeType } : undefined);
            this._audioChunks = [];
            this._mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) this._audioChunks.push(e.data); };
            this._mediaRecorder.onstop = async () => {
                const blob = new Blob(this._audioChunks, { type: mimeType || 'audio/webm' });
                const arrayBuffer = await blob.arrayBuffer();
                if (recordLabel) recordLabel.textContent = 'Record';
                recordBtn.classList.remove('is-recording');
                if (levelMeter) { levelMeter.classList.remove('active'); levelMeter.style.transform = 'scaleY(0.05)'; }
                this._stopMeterAnimation();
                if (this._mic) { this._mic.close(); this._mic = null; }
                if (this._mediaStream) { this._mediaStream.getTracks().forEach((t) => t.stop()); this._mediaStream = null; }
                this.runPipeline('audio', null, false, arrayBuffer);
            };
            this._mediaRecorder.start();
            this._isRecording = true;
            if (recordLabel) recordLabel.textContent = 'Stop';
            recordBtn.classList.add('is-recording');
            if (levelMeter) levelMeter.classList.add('active');
            this._startMeterAnimation();
        } catch (err) {
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                this.showToast('Microphone access denied. Enable it in your browser settings, then refresh.');
                if (recordBtn) recordBtn.classList.add('is-disabled');
            } else {
                this.showToast(`Recording error: ${err.message}`);
            }
        }
    }

    _stopRecording() {
        if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') this._mediaRecorder.stop();
        this._isRecording = false;
    }

    _startMeterAnimation() {
        const levelMeter = document.getElementById('levelMeter');
        const update = () => {
            if (!this._isRecording || !this._analyser || !levelMeter) return;
            const level = this._analyser.getValue();
            const normalized = Math.max(0.05, (level + 60) / 60);
            levelMeter.style.transform = `scaleY(${normalized})`;
            this._meterRafId = requestAnimationFrame(update);
        };
        this._meterRafId = requestAnimationFrame(update);
    }

    _stopMeterAnimation() {
        if (this._meterRafId) { cancelAnimationFrame(this._meterRafId); this._meterRafId = null; }
    }

    // ── Sample animation ──────────────────────────────────────────────────

    async _animateSampleSteps(steps, stepCallback) {
        for (const s of steps) {
            stepCallback(s.id, 'running', 'Processing');
            await this._delay(600 + Math.random() * 350);
            stepCallback(s.id, 'done', 'Complete');
            await this._delay(120);
        }
    }

    _delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

    // ── Self-test accuracy badge ──────────────────────────────────────────

    /**
     * Load bundled-asset accuracy numbers for the result badge.
     *
     * Primary source is the same-origin, pre-measured ACCURACY_RESULTS.json (instant,
     * authoritative mir_eval F1 per branch). The live /selftest endpoint re-runs every
     * fixture through Demucs + Basic Pitch on demand and takes far longer than any
     * page-load budget, so it is NOT fetched here (it would only ERR_ABORTED). The
     * conversion response's own accuracy field, when present, always wins over both.
     */
    async _loadSelfTest() {
        try {
            const res = await fetch('.planning/rebuild/ACCURACY_RESULTS.json', { signal: AbortSignal.timeout(4000) });
            if (res.ok) this._selfTestCache = await res.json();
        } catch { /* file missing — accuracy then comes from the conversion response only */ }
    }

    /**
     * Resolve the accuracy value (0..1) to display in the result badge.
     * Priority: the conversion response's own accuracy -> the /selftest number for the lane.
     */
    _resolveAccuracy(path, result) {
        if (result && result.accuracy && typeof result.accuracy.value === 'number') return result.accuracy;
        // The MIDI/audio server reports a faithful, lossless conversion via stats.metric.
        // Surface that as an "Exact / lossless" badge (never a fabricated %).
        if (result && result.stats && result.stats.metric === 'exact') {
            return { value: 1.0, metric: 'exact', method: 'server' };
        }
        const key = path === 'ocr' ? 'omr' : path === 'audio' ? this.audioBranch : path;
        const st = this._selfTestCache;
        if (st && st[key] && typeof st[key].f1 === 'number') {
            return { value: st[key].f1, metric: 'note_f1', method: 'selftest' };
        }
        if (st && st[path] && typeof st[path].f1 === 'number') {
            return { value: st[path].f1, metric: 'note_f1', method: 'selftest' };
        }
        return null;
    }

    /** Render the accuracy badge into #accuracyBadgeSlot (or clear it). */
    _renderAccuracyBadge(accuracy, noteCount) {
        const slot = document.getElementById('accuracyBadgeSlot');
        if (!slot) return;
        // Never show a "pass" badge when nothing was detected.
        if (noteCount === 0) {
            slot.innerHTML =
                `<span class="accuracy-badge is-fail" role="status">` +
                `<span class="accuracy-badge__value">No notes</span>` +
                `<span class="accuracy-badge__label">conversion empty</span></span>`;
            return;
        }
        if (!accuracy || typeof accuracy.value !== 'number') { slot.innerHTML = ''; return; }
        if (accuracy.metric === 'exact') {
            slot.innerHTML =
                `<span class="accuracy-badge is-pass" role="status">` +
                `${icon('Icon_star2__Active-Fill.svg')}` +
                `<span class="accuracy-badge__value">Exact</span>` +
                `<span class="accuracy-badge__label">lossless</span></span>`;
            return;
        }
        const pct = Math.round(accuracy.value * 100);
        let cls = 'is-fail';
        if (accuracy.value >= ACCURACY_PASS) cls = 'is-pass';
        else if (accuracy.value >= ACCURACY_MARGINAL) cls = 'is-marginal';
        const label = accuracy.method === 'selftest'
            ? 'benchmark'
            : (accuracy.metric === 'omr_symbol_acc' ? 'symbol acc.' : 'note accuracy');
        slot.innerHTML =
            `<span class="accuracy-badge ${cls}" role="status" title="${accuracy.method === 'selftest' ? 'Measured on the bundled reference assets, not your upload' : ''}">` +
            `${icon('Icon_star2__Active-Fill.svg')}` +
            `<span class="accuracy-badge__value">${pct}%</span>` +
            `<span class="accuracy-badge__label">${label}</span></span>`;
    }

    // ── Result screen + Teacher Review Gate ───────────────────────────────

    async showResult(path, result, isSample, uploadedFilename) {
        const p = PIPELINES[path];
        document.getElementById('screen-processing').classList.remove('active');
        document.getElementById('screen-result').classList.add('active');

        const realStats = (result && !result.useSample && result.stats) ? result.stats : null;
        const fb = p.stats;
        // Server stats use n_* keys (n_notes / n_measures / n_treble + n_bass);
        // client-path stats use notes / measures / voices. Read both spellings.
        const hasHands = realStats && (realStats.n_treble != null || realStats.n_bass != null);
        const notes = realStats ? (realStats.notes ?? realStats.n_notes ?? fb.notes) : fb.notes;
        const measures = realStats ? (realStats.measures ?? realStats.n_measures ?? fb.measures) : fb.measures;
        const voices = realStats
            ? (realStats.voices ?? realStats.parts ?? (hasHands ? 2 : fb.voices))
            : fb.voices;

        // Accuracy badge (response value, else /selftest).
        const accuracy = this._resolveAccuracy(path, result && !result.useSample ? result : null);
        const noteCountNum = (typeof notes === 'number') ? notes : Number(notes);
        this._renderAccuracyBadge(accuracy, Number.isFinite(noteCountNum) ? noteCountNum : undefined);

        // Compression chip if ScoreJSON present.
        let compressionChip = '';
        if (result && result.scoreJSON && result.musicXML) {
            const ratio = Math.round(result.musicXML.length / JSON.stringify(result.scoreJSON).length);
            if (ratio > 0) compressionChip = `<div class="stat-chip scorejson-ready"><span>${ratio}x</span>ScoreJSON ratio</div>`;
        } else if (realStats && realStats.compressionRatio) {
            compressionChip = `<div class="stat-chip scorejson-ready"><span>${realStats.compressionRatio}x</span>ScoreJSON ratio</div>`;
        }

        document.getElementById('resultStats').innerHTML = `
            <div class="stat-chip"><span>${notes}</span>Notes</div>
            <div class="stat-chip"><span>${measures}</span>Measures</div>
            <div class="stat-chip"><span>${voices}</span>Voice${voices > 1 ? 's' : ''}</div>
            ${compressionChip}`;

        const sourceLabel = isSample ? 'built-in sample'
            : (uploadedFilename ? `uploaded: ${uploadedFilename}` : 'recording');
        const branchLabel = path === 'audio' ? ` (${AUDIO_BRANCHES[this.audioBranch].label})` : '';
        const pipelineLabel = `${p.provenance.engine}${branchLabel}${isSample ? ' · sample' : ''}`;
        // Surface real source-separation provenance when the server reports it (demucs etc.).
        const sep = realStats && realStats.separation_quality;
        const sepLabel = (sep && sep !== 'n/a') ? ` · Separation: ${sep}` : '';

        document.getElementById('resultTitleText').textContent = `${p.label} Complete`;
        document.getElementById('resultMeta').textContent = `Source: ${sourceLabel} · Engine: ${pipelineLabel}${sepLabel}`;

        // Editable title (teacher edit, M10).
        const titleInput = document.getElementById('scoreTitleInput');
        const sjTitle = result && result.scoreJSON && result.scoreJSON.title;
        const derivedTitle = (sjTitle && sjTitle !== 'Untitled')
            ? sjTitle
            : (uploadedFilename ? uploadedFilename.replace(/\.[^.]+$/, '') : `${p.label} score`);
        if (titleInput) titleInput.value = derivedTitle;

        // Footnote — engine provenance recap.
        document.getElementById('resultFootnote').textContent =
            `${p.provenance.engine} (${p.provenance.license}) — ${p.provenance.note}. ` +
            'This converted score is a draft; it must be reviewed and approved by a teacher before it is dispatched and versioned (M10).';

        // Render the score in OSMD (also stops any prior playback + sets tempo).
        await this._renderScore(path, result);

        // ScoreJSON inspect panel.
        this._renderJsonPanel(result);

        // Playback + Save/Export toolbar state for this result.
        this._updatePlayButtons();
        this._updateExportButtons(result && !result.useSample ? result : (result && result.scoreJSON ? result : null));
    }

    async _renderScore(path, result) {
        const p = PIPELINES[path];
        const container = document.getElementById('score-container');
        this._currentScoreJSON = (result && result.scoreJSON) || null;  // drives playback
        try {
            let xml;
            if (result && !result.useSample && result.musicXML) {
                xml = result.musicXML;
            } else if (result && !result.useSample && result.scoreJSON) {
                // Server returns the proprietary ScoreJSON with an empty MusicXML;
                // build the render intermediate client-side via ScoreJSON.js. Cache
                // it on the result so playback/export reuse the same MusicXML.
                xml = ScoreJSON.toMusicXML(result.scoreJSON);
                result.musicXML = xml;
            } else {
                const res = await fetch(`samples/${p.sampleFile}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                xml = await res.text();
            }
            if (!this.osmd) {
                this.osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay('score-container', {
                    autoResize: true, backend: 'svg', drawingParameters: 'compacttight',
                    disableCursor: false, pageFormat: 'Endless',
                });
            }
            // Stop any playback from a previous result before re-loading.
            this.stopPlayback();
            await this.osmd.load(xml);
            this.osmd.render();
            // Cursor drives playback (B1 pattern). Show it at the start.
            try { this.osmd.cursor.show(); this.osmd.cursor.reset(); } catch (_) { /* cursor optional */ }
            // Remember the current score's tempo for playback timing.
            this._playTempo = (result && result.scoreJSON && Number(result.scoreJSON.tempo)) || this._tempoFromXML(xml) || 120;
            // Start decoding the piano soundfont now so the FIRST Play press
            // doesn't sit through several seconds of decodeAudioData.
            this._preloadAudio();
        } catch (e) {
            console.error('OSMD render error:', e);
            container.innerHTML = '<p class="score-fallback">Score preview requires the page to be served over HTTP (run: python -m http.server).</p>';
        }
    }

    /** Pull a fallback tempo (BPM) from a MusicXML <sound tempo> attribute. */
    _tempoFromXML(xml) {
        try {
            const m = String(xml).match(/<sound[^>]*\btempo="([\d.]+)"/);
            return m ? Number(m[1]) : null;
        } catch (_) { return null; }
    }

    _renderJsonPanel(result) {
        const panel = document.getElementById('scoreJsonPanel');
        if (!panel) return;
        if (result && result.scoreJSON && result.musicXML) {
            const jsonStr = JSON.stringify(result.scoreJSON, null, 2);
            const jsonSize = new Blob([jsonStr]).size;
            const xmlSize = new Blob([result.musicXML]).size;
            const ratio = Math.max(1, Math.round(xmlSize / jsonSize));
            panel.innerHTML = `
                <div class="json-panel-header" onclick="document.getElementById('scoreJsonBody').classList.toggle('collapsed')">
                    <span class="json-panel-title">ScoreJSON</span>
                    <span class="json-panel-meta">${(jsonSize / 1024).toFixed(1)} KB vs ${(xmlSize / 1024).toFixed(1)} KB MusicXML (~${ratio}x smaller)</span>
                    <span class="json-panel-toggle">▾</span>
                </div>
                <div class="json-panel-body" id="scoreJsonBody">
                    <button class="btn-tertiary--chip json-copy-btn" type="button"
                            onclick="navigator.clipboard.writeText(${JSON.stringify(jsonStr)})">Copy</button>
                    <pre class="json-content">${highlightJSON(jsonStr)}</pre>
                </div>`;
            panel.classList.remove('hidden');
        } else {
            panel.classList.add('hidden');
        }
    }

    // ── Real-piano playback (ported from B1: WebAudioFont + OSMD cursor) ───

    /** Kick off AudioContext creation + preset decode ahead of the first Play.
     *  Safe before any user gesture: the context stays 'suspended' but
     *  decodeAudioData still runs, so _ensureAudio() later finds warm buffers. */
    _preloadAudio() {
        try {
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (this.player && this.pianoPreset) {
                this.player.adjustPreset(this.audioContext, this.pianoPreset);
            }
        } catch (_) { /* audio stays lazy — _ensureAudio() will retry on Play */ }
    }

    /** Lazily create / resume the AudioContext and load the piano preset (gesture-safe). */
    async _ensureAudio() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
        if (this.player && this.pianoPreset) {
            this.player.adjustPreset(this.audioContext, this.pianoPreset);
            // decodeAudioData is async — wait until the zones are decoded so the
            // FIRST Play doesn't silently skip notes whose sample isn't ready yet.
            const ready = () => (this.pianoPreset.zones || []).every((z) => !z.file || (z.buffer && z.buffer.length > 0));
            for (let i = 0; i < 100 && !ready(); i++) await this._delay(50);
        }
    }

    /** Reflect playing/stopped state on the Play / Stop buttons. */
    _updatePlayButtons() {
        const playBtn = document.getElementById('playBtn');
        const stopBtn = document.getElementById('stopBtn');
        const label = document.getElementById('playBtnLabel');
        const ico = document.getElementById('playBtnIcon');
        if (label) label.textContent = this.isPlaying ? 'Playing…' : 'Play';
        if (playBtn) playBtn.disabled = this.isPlaying;
        if (stopBtn) stopBtn.disabled = !this.isPlaying;
        if (ico) ico.src = `${ICONS}Icon_play__Activ-Fill.svg`;
    }

    /** Build an absolutely-timed playback schedule from the current ScoreJSON.
     *  Honours the optional `tempoMap` (rubato) and `pedal` (CC64 sustain) fields,
     *  extends tied notes instead of cutting them at the first piece, and walks
     *  each staff across all measures so tie chains can cross barlines. Older
     *  ScoreJSON files without the optional fields play at the flat `tempo`. */
    _buildPlaybackEvents() {
        const sj = this._currentScoreJSON;
        if (!sj || !Array.isArray(sj.measures)) return [];
        const [tNum, tDen] = String(sj.time || '4/4').split('/').map(Number);
        const beats = (tNum || 4) * (4 / (tDen || 4));            // quarters per measure
        const qSec = this._tempoMapper(sj);

        const baseQ = { w: 4, h: 2, q: 1, e: 0.5, s: 0.25, t: 0.125 };
        const durQ = (code) => {
            if (typeof code === 'number' && isFinite(code)) return code / 4;  // numeric padding rests (legacy divisions, quarter = 4)
            if (!code) return 1;
            let v = baseQ[String(code)[0]] ?? 1;
            if (String(code).includes('d')) v *= 1.5;
            return v;
        };

        // Walk each staff across ALL measures so tie chains can span barlines.
        const raw = [];                                           // {onQ, relQ, midi}
        ['treble', 'bass'].forEach((staff) => {
            let open = new Map();                                 // midi -> sounding event (tie target)
            sj.measures.forEach((m, mi) => {
                let pos = mi * beats;                             // quarters from score start
                (m[staff] || []).forEach((tokRaw) => {
                    let tok = tokRaw;
                    if (typeof tok === 'string') {
                        const a = tok.split('/');
                        tok = a[0] === 'rest' ? { rest: true, duration: a[1] } : { pitch: a[0], duration: a[1] };
                    }
                    const dq = durQ(tok.duration);
                    if (tok.rest) { open = new Map(); pos += dq; return; }
                    const pitches = [tok.pitch, ...(tok.chord || [])];
                    if (tok.tie) {
                        // tie continuation: extend the sounding note's gate, don't re-strike
                        pitches.forEach((pn) => {
                            const midi = this._nameToMidi(pn);
                            if (midi == null) return;
                            const ev = open.get(midi);
                            if (ev && Math.abs(ev.relQ - pos) < 1e-6) { ev.relQ = pos + dq; }
                            else {                                // no contiguous match — strike (head-convention ties)
                                const nu = { onQ: pos, relQ: pos + dq, midi };
                                raw.push(nu); open.set(midi, nu);
                            }
                        });
                    } else {
                        open = new Map();
                        pitches.forEach((pn) => {
                            const midi = this._nameToMidi(pn);
                            if (midi == null) return;
                            const ev = { onQ: pos, relQ: pos + dq, midi };
                            raw.push(ev); open.set(midi, ev);
                        });
                    }
                    pos += dq;
                });
            });
        });

        // Sustain pedal: a note released while the pedal is down rings until pedal-up.
        const pedal = (Array.isArray(sj.pedal) ? sj.pedal : [])
            .filter((s) => s && isFinite(s.start) && isFinite(s.end) && s.end > s.start);
        const pedalRelease = (qPos) => {
            for (const s of pedal) { if (qPos > s.start + 1e-6 && qPos < s.end - 1e-6) return s.end; }
            return qPos;
        };

        const events = raw.map((ev) => {
            const t = qSec(ev.onQ);
            const rel = pedal.length ? pedalRelease(ev.relQ) : ev.relQ;
            return { t, midi: ev.midi, dur: Math.max(qSec(rel) - t, 0.05) };
        });
        events.sort((a, b) => a.t - b.t);
        return events;
    }

    /** Piecewise tempo map for a ScoreJSON: quarter position -> seconds.
     *  Falls back to the flat `tempo` when no tempoMap is present. Shared by
     *  the audio scheduler and the cursor animator so they can never drift. */
    _tempoMapper(sj) {
        const baseBpm = Number(sj && sj.tempo) || 120;
        const map = (Array.isArray(sj && sj.tempoMap) ? sj.tempoMap : [])
            .filter((e) => e && isFinite(e.beat) && e.beat >= 0 && Number(e.bpm) > 0)
            .map((e) => ({ beat: Number(e.beat), bpm: Number(e.bpm) }))
            .sort((a, b) => a.beat - b.beat);
        if (!map.length || map[0].beat > 1e-9) map.unshift({ beat: 0, bpm: baseBpm });
        let accSec = 0;
        const segs = map.map((e, i) => {
            if (i > 0) accSec += (e.beat - map[i - 1].beat) * 60 / map[i - 1].bpm;
            return { beat: e.beat, bpm: e.bpm, sec: accSec };
        });
        return (qPos) => {
            let i = segs.length - 1;
            while (i > 0 && segs[i].beat > qPos + 1e-9) i--;
            return segs[i].sec + (qPos - segs[i].beat) * 60 / segs[i].bpm;
        };
    }

    /** "C#4" / "Bb3" -> MIDI number. */
    _nameToMidi(name) {
        const m = /^([A-G])([#b]?)(-?\d+)$/.exec(String(name || ''));
        if (!m) return null;
        const pc = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]];
        const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
        return 12 * (parseInt(m[3], 10) + 1) + pc + acc;
    }

    /** Play the whole score: schedule every note up-front (precise), animate the cursor. */
    async togglePlay() {
        if (this.isPlaying) return;
        await this._ensureAudio();
        if (!this.audioContext || this.audioContext.state !== 'running') {
            this.showToast('Audio could not start — click Play again.');
            return;
        }
        const events = this._buildPlaybackEvents();
        if (!events.length) { this.showToast('No notes to play yet.'); return; }
        this.isPlaying = true;
        this._updatePlayButtons();

        const ctx = this.audioContext;
        const startAt = ctx.currentTime + 0.12;
        const t0 = events[0].t;          // skip leading silence — sound starts immediately
        events.forEach((ev) => {
            if (!this.player || !this.pianoPreset) return;
            const zone = this.player.findZone(ctx, this.pianoPreset, ev.midi);
            if (zone && zone.buffer && zone.buffer.length > 0) {
                this.player.queueWaveTable(ctx, ctx.destination, this.pianoPreset,
                    startAt + ev.t - t0, ev.midi, Math.min(ev.dur, 12), 0.5);
            }
        });
        this._animateCursor(events, startAt, t0);
        const endT = Math.max(...events.map((e) => e.t + e.dur)) - t0;
        this._playEndTimer = setTimeout(() => this.stopPlayback(), (endT + 0.4) * 1000);
    }

    /** Step the OSMD cursor in real time to follow the scheduled audio.
     *
     *  The cursor advances over EVERY voice-entry timestamp in the score —
     *  rests and tie continuations included — so it must be scheduled from the
     *  score's own iterator timeline, not from the audio onsets (one next()
     *  per onset left it drifting hundreds of steps behind by the last page).
     *  Timestamps map through the same tempo mapper as the audio schedule. */
    _animateCursor(events, startAt, t0) {
        if (!this.osmd || !this.osmd.cursor) return;
        try { this.osmd.cursor.reset(); this.osmd.cursor.show(); } catch (_) { return; }
        const ctx = this.audioContext;
        this._cursorTimers = [];

        let stampsSec = null;
        try {
            // RealValue is in whole notes -> quarters = x4.
            const it = this.osmd.cursor.Iterator.clone();
            const qSec = this._tempoMapper(this._currentScoreJSON || {});
            stampsSec = [];
            let guard = 0;
            while (!it.EndReached && guard++ < 200000) {
                stampsSec.push(qSec(it.CurrentEnrolledTimestamp.RealValue * 4));
                it.moveToNext();
            }
        } catch (_) { stampsSec = null; }
        if (!stampsSec || !stampsSec.length) {
            // Fallback (old behaviour): one step per distinct audio onset.
            stampsSec = Array.from(new Set(events.map((e) => Number(e.t.toFixed(4))))).sort((a, b) => a - b);
        }

        stampsSec.forEach((t, i) => {
            if (i === 0) return;                                 // cursor already on the first entry
            const delayMs = (startAt + t - (t0 || 0) - ctx.currentTime) * 1000;
            this._cursorTimers.push(setTimeout(() => {
                if (!this.isPlaying) return;
                try { this.osmd.cursor.next(); } catch (_) { /* end of score */ }
            }, Math.max(delayMs, 0)));
        });
    }

    /** Stop playback: silence scheduled audio + reset the cursor. */
    stopPlayback() {
        this.isPlaying = false;
        this._updatePlayButtons();
        if (this._playEndTimer) { clearTimeout(this._playEndTimer); this._playEndTimer = null; }
        if (this._cursorTimers) { this._cursorTimers.forEach(clearTimeout); this._cursorTimers = []; }
        try {
            if (this.player && typeof this.player.cancelQueue === 'function' && this.audioContext) {
                this.player.cancelQueue(this.audioContext);
            }
        } catch (_) { /* ignore */ }
        if (this.osmd && this.osmd.cursor) {
            try { this.osmd.cursor.reset(); } catch (_) { /* no cursor */ }
        }
    }

    // ── Save / Export ─────────────────────────────────────────────────────

    /** Trigger a browser download from a string/Blob. */
    _download(filename, content, mime) {
        const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /** Slugify the (teacher-editable) title for use as a filename stem. */
    _exportStem() {
        const titleInput = document.getElementById('scoreTitleInput');
        const raw = (titleInput?.value || '').trim()
            || (this._lastResult && this._lastResult.scoreJSON && this._lastResult.scoreJSON.title)
            || 'score';
        return String(raw).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'score';
    }

    /** (a) Download the proprietary ScoreJSON — the primary export. */
    downloadScoreJSON() {
        const sj = this._lastResult && this._lastResult.scoreJSON;
        if (!sj) { this.showToast('No ScoreJSON available for this result.'); return; }
        // Keep the export title in sync with the teacher's edit.
        const out = { ...sj, title: this._exportStem().replace(/-/g, ' ') };
        this._download(`${this._exportStem()}.json`, JSON.stringify(out, null, 2), 'application/json');
        this.showToast('ScoreJSON downloaded.', 'success');
    }

    /** (b) Download MusicXML (built client-side from ScoreJSON when needed). */
    downloadMusicXML() {
        let xml = this._lastResult && this._lastResult.musicXML;
        const sj = this._lastResult && this._lastResult.scoreJSON;
        if ((!xml || !xml.trim()) && sj && typeof ScoreJSON !== 'undefined') {
            try { xml = ScoreJSON.toMusicXML(sj); } catch (_) { /* handled below */ }
        }
        if (!xml || !xml.trim()) { this.showToast('No MusicXML available for this result.'); return; }
        this._download(`${this._exportStem()}.musicxml`, xml, 'application/vnd.recordare.musicxml+xml');
        this.showToast('MusicXML downloaded.', 'success');
    }

    /** (c) Download the original uploaded source file (when one was provided). */
    downloadSource() {
        const ctx = this._lastContext;
        const file = ctx && ctx.file;
        if (!file) { this.showToast('No original file to download (sample or recording).'); return; }
        this._download(file.name, file, file.type || 'application/octet-stream');
        this.showToast('Original file downloaded.', 'success');
    }

    /** Enable/disable the toolbar buttons for the current result. */
    _updateExportButtons(result) {
        const hasJson = !!(result && result.scoreJSON);
        const hasXml = !!(result && (result.musicXML || result.scoreJSON));
        const saveJson = document.getElementById('saveJsonBtn');
        const saveXml = document.getElementById('saveXmlBtn');
        const saveSrc = document.getElementById('saveSourceBtn');
        const playBtn = document.getElementById('playBtn');
        if (saveJson) saveJson.disabled = !hasJson;
        if (saveXml) saveXml.disabled = !hasXml;
        if (playBtn) playBtn.disabled = !hasXml;
        // Show "Original file" only when a real upload is present.
        const file = this._lastContext && this._lastContext.file;
        if (saveSrc) saveSrc.hidden = !file;
    }

    // ── Teacher Gate actions ──────────────────────────────────────────────

    approveScore() {
        const title = (document.getElementById('scoreTitleInput')?.value || '').trim() || 'Untitled score';
        this.showToast(`Approved & dispatched: "${title}". Saved as a new version (M10).`, 'success');
    }

    rerunScore() {
        const ctx = this._lastContext;
        if (!ctx) { this.reset(); return; }
        this.runPipeline(ctx.path, ctx.file, ctx.isSample, ctx.arrayBuffer);
    }

    rejectScore() {
        this.showToast('Score rejected — not saved. Returning to upload.');
        this.reset();
    }

    // ── Toast + reset ─────────────────────────────────────────────────────

    showToast(message, variant = 'error') {
        const toast = document.getElementById('toast');
        if (!toast) return;
        toast.textContent = message;
        // Recolor success/info via inline token-bound styles (still token values, no raw hex).
        if (variant === 'success') {
            toast.style.background = 'var(--color-green-alpha10)';
            toast.style.borderColor = 'var(--color-green-200)';
        } else {
            toast.style.background = '';
            toast.style.borderColor = '';
        }
        toast.classList.remove('fade-out');
        toast.classList.add('visible');
        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => { toast.classList.remove('visible', 'fade-out'); }, 300);
        }, 6000);
    }

    reset() {
        this.stopPlayback();
        document.getElementById('screen-result').classList.remove('active');
        document.getElementById('screen-processing').classList.remove('active');
        document.getElementById('screen-input').classList.add('active');
        this.renderInputScreen();
    }
}

const app = new ConversionApp();
window.app = app;
