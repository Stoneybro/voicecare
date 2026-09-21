// AudioWorklet processor: captures microphone PCM and posts Int16 buffers.
// Runs at the context rate; the client forces a 24 kHz context on Chromium so no resampling
// is needed (AssemblyAI Voice Agent API expects 24 kHz PCM16). Served from /public, no build step.
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) {
      const pcm16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const sample = input[i] || 0;
        pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      }
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
