/**
 * Audio utility functions for Phase 2: resampling, worker communication.
 */

/**
 * Resample an AudioBuffer to 22050 Hz mono Float32Array using OfflineAudioContext.
 * @param {AudioBuffer} audioBuffer — decoded from MediaRecorder Blob or file upload
 * @returns {Promise<Float32Array>} — mono 22050 Hz audio samples
 */
export async function resampleToMono22050(audioBuffer) {
    const targetSampleRate = 22050;
    const numberOfFrames = Math.ceil(audioBuffer.duration * targetSampleRate);
    const offlineCtx = new OfflineAudioContext(1, numberOfFrames, targetSampleRate);
    const bufferSource = offlineCtx.createBufferSource();
    bufferSource.buffer = audioBuffer;
    bufferSource.connect(offlineCtx.destination);
    bufferSource.start();
    const renderedBuffer = await offlineCtx.startRendering();
    return renderedBuffer.getChannelData(0);
}

/**
 * Run basic-pitch transcription in a Web Worker.
 * @param {Float32Array} audioData — mono 22050 Hz audio
 * @param {number} sampleRate — 22050
 * @returns {Promise<Array>} — basic-pitch note events [{ start_time, end_time, pitch, amplitude }]
 */
export function runBasicPitchWorker(audioData, sampleRate = 22050) {
    return new Promise((resolve, reject) => {
        const worker = new Worker('src/workers/basic-pitch.worker.js', { type: 'module' });

        const timeout = setTimeout(() => {
            worker.terminate();
            reject(new Error('basic-pitch worker timed out after 60s'));
        }, 60000);

        worker.onmessage = (e) => {
            if (e.data.type === 'notes') {
                clearTimeout(timeout);
                worker.terminate();
                resolve(e.data.notes);
            } else if (e.data.type === 'error') {
                clearTimeout(timeout);
                worker.terminate();
                reject(new Error(e.data.message));
            }
        };

        worker.onerror = (err) => {
            clearTimeout(timeout);
            worker.terminate();
            reject(new Error(`Worker error: ${err.message}`));
        };

        // Transfer the buffer (zero-copy) for performance
        worker.postMessage({ type: 'transcribe', audioData, sampleRate }, [audioData.buffer]);
    });
}

/**
 * Decode audio file ArrayBuffer to AudioBuffer.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<AudioBuffer>}
 */
export function decodeAudioBuffer(arrayBuffer) {
    const audioCtx = new AudioContext();
    return audioCtx.decodeAudioData(arrayBuffer);
}

/**
 * Detect BPM from basic-pitch note events using autocorrelation on inter-onset intervals.
 * @param {Array} notes — basic-pitch note events [{ start_time, end_time, pitch, amplitude }]
 * @returns {number} — estimated BPM (40-240 range), default 120 if inconclusive
 */
export function detectBPM(notes) {
    const onsets = notes.map(n => n.start_time).sort((a, b) => a - b);
    if (onsets.length < 4) return 120; // fallback: too few onsets

    // Compute inter-onset intervals (IOI) in seconds
    const iois = [];
    for (let i = 1; i < onsets.length; i++) {
        iois.push(onsets[i] - onsets[i - 1]);
    }

    // Bin IOIs into 20ms bins (range: 0.1s to 2.0s = 50 to 300 BPM)
    const binSize = 0.02;
    const numBins = Math.floor(2.0 / binSize);
    const histogram = new Array(numBins).fill(0);
    iois.forEach(ioi => {
        if (ioi >= 0.1 && ioi <= 2.0) {
            histogram[Math.floor(ioi / binSize)]++;
        }
    });

    // Autocorrelation of histogram
    const r = new Array(numBins).fill(0);
    for (let lag = 0; lag < numBins; lag++) {
        for (let i = 0; i < numBins - lag; i++) {
            r[lag] += histogram[i] * histogram[i + lag];
        }
    }

    // Find dominant period (excluding lag 0)
    let maxR = -1, bestLag = 0;
    for (let lag = 1; lag < numBins; lag++) {
        if (r[lag] > maxR) { maxR = r[lag]; bestLag = lag; }
    }

    if (bestLag === 0) return 120; // fallback

    const periodSeconds = bestLag * binSize;
    const bpm = Math.round(60 / periodSeconds);

    // Clamp to reasonable piano tempo range
    return Math.min(Math.max(bpm, 40), 240);
}

/**
 * Convert basic-pitch note events to MIDI-like note objects.
 * @param {Array} notes — basic-pitch note events
 * @param {number} bpm — estimated tempo
 * @param {number} ppq — pulses per quarter note (default 480)
 * @returns {Array} — MIDI-like notes [{ midi, name, ticks, duration, time }]
 */
export function basicPitchToMIDINotes(notes, bpm = 120, ppq = 480) {
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    function hzToMidi(hz) {
        return Math.round(12 * Math.log2(hz / 440) + 69);
    }

    function midiNoteName(midi) {
        return noteNames[midi % 12] + Math.floor(midi / 12 - 1);
    }

    function secondsToTicks(seconds) {
        const quarterNoteDuration = 60 / bpm;
        const quarterNotes = seconds / quarterNoteDuration;
        return Math.round(quarterNotes * ppq);
    }

    return notes.map(note => {
        const midi = hzToMidi(note.pitch);
        const ticks = secondsToTicks(note.start_time);
        const durationSeconds = note.end_time - note.start_time;
        const durationTicks = secondsToTicks(durationSeconds);
        return {
            midi,
            name: midiNoteName(midi),
            ticks,
            duration: durationSeconds,
            durationTicks
        };
    });
}

/**
 * Estimate measure count from last note time, tempo, and 4/4 time.
 * @param {Array} notes — basic-pitch note events
 * @param {number} bpm
 * @param {number} beatsPerMeasure — default 4
 * @returns {number}
 */
export function estimateMeasureCount(notes, bpm, beatsPerMeasure = 4) {
    if (!notes || notes.length === 0) return 1;
    const lastEnd = Math.max(...notes.map(n => n.end_time));
    const quarterNotes = lastEnd / (60 / bpm);
    return Math.max(1, Math.ceil(quarterNotes / beatsPerMeasure));
}
