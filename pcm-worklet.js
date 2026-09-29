// pcm-worklet.js — captured tab audio -> mono 16-bit PCM chunks
//
// This runs on the audio thread inside the offscreen document. It does the
// smallest possible job: downmix every input channel to one, convert to signed
// 16-bit little-endian, and hand a chunk to the page every `FLUSH_MS`.
//
// Two things are deliberate:
//
//   * it OUTPUTS SILENCE. The captured stream is played back to the speakers by
//     a separate connection in offscreen.js, so anything this node passed on
//     would be a second copy of the same sound. Silence here keeps the two
//     paths from ever mixing.
//   * it does NOT resample. The recognizer resamples from whatever rate the
//     AudioContext runs at, and a resampler with state produces better results
//     than bare decimation on an audio thread.
class PcmChunker extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings = (options && options.processorOptions) || {};
    this.flushMs = Math.max(10, Math.min(500, Number(settings.flushMs) || 100));
    this.language = typeof settings.language === "string" ? settings.language : "auto";
    this.limit = Math.max(160, Math.round((sampleRate * this.flushMs) / 1000));
    this.samples = new Float32Array(this.limit);
    this.filled = 0;
    this.stopped = false;
    this.port.onmessage = (event) => {
      if (event && event.data && event.data.type === "stop") {
        // The last partial chunk is still audio the recognizer can use.
        this.flush();
        this.stopped = true;
      }
    };
  }

  flush() {
    if (!this.filled) return;
    const count = this.filled;
    const chunk = new Float32Array(count);
    chunk.set(this.samples.subarray(0, count));
    this.filled = 0;
    // A fresh buffer every time: the buffer is handed to the page, and the next
    // chunk must not write into it while the message is still in flight.
    this.port.postMessage({ type: "pcm", samples: chunk, frames: count, language: this.language }, [
      chunk.buffer,
    ]);
  }

  process(inputs, outputs) {
    // Keep the graph silent. See the note at the top of the file.
    if (outputs && outputs.length) {
      for (const output of outputs) {
        for (const channel of output) channel.fill(0);
      }
    }
    if (this.stopped) return false;
    const input = inputs && inputs[0];
    if (!input || !input.length) return true;
    const channels = input.length;
    const frames = input[0].length;
    for (let i = 0; i < frames; i += 1) {
      let value;
      if (channels === 1) {
        value = input[0][i];
      } else {
        // Downmix rather than take the first channel: tabCapture can hand us
        // either layout, and a hard-panned sound would vanish otherwise.
        let sum = 0;
        for (let c = 0; c < channels; c += 1) sum += input[c][i] || 0;
        value = sum / channels;
      }
      if (value > 1) value = 1;
      else if (value < -1) value = -1;
      this.samples[this.filled] = value;
      this.filled += 1;
      if (this.filled >= this.limit) this.flush();
    }
    return true;
  }
}

registerProcessor("pcm-chunker", PcmChunker);
