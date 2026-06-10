/**
 * basic-pitch Web Worker
 * Loads @spotify/basic-pitch TensorFlow.js model and runs inference off main thread.
 * Message protocol:
 *   { type: 'transcribe', audioData: Float32Array, sampleRate: number }
 *   { type: 'ready' } — emitted after model initialization
 *   { type: 'notes', notes: [...] } — emitted on inference completion
 *   { type: 'error', message: string }
 */
import { BasicPitch } from '@spotify/basic-pitch';

let model = null;

async function init() {
    try {
        model = new BasicPitch();
        await model.initialize();
        self.postMessage({ type: 'ready' });
    } catch (err) {
        self.postMessage({ type: 'error', message: `Model init failed: ${err.message}` });
    }
}

self.onmessage = async (e) => {
    if (e.data.type === 'transcribe') {
        if (!model) {
            self.postMessage({ type: 'error', message: 'Model not initialized' });
            return;
        }
        try {
            const { audioData, sampleRate } = e.data;
            const notes = await model.predictAudio(audioData, sampleRate);
            self.postMessage({ type: 'notes', notes });
        } catch (err) {
            self.postMessage({ type: 'error', message: `Inference failed: ${err.message}` });
        }
    }
};

init();
