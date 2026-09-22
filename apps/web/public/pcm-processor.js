// AudioWorklet processor: captures microphone PCM, resamples to 24 kHz, posts Int16 buffers.
//
// The context runs at the device's own rate (browser default) so echo cancellation keeps
// working everywhere. The client passes { inputSampleRate, targetSampleRate: 24000 } as
// processor options; the worklet linearly resamples to the target rate before posting.
// Linear interpolation is good enough for speech. A persistent fractional position carries
// across render quanta so long sessions never drift. Served from /public, no build step.
class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = (options && options.processorOptions) || {};
    const inputSampleRate = Number(processorOptions.inputSampleRate) || 48000;
    const targetSampleRate = Number(processorOptions.targetSampleRate) || 24000;
    this.ratio = inputSampleRate / targetSampleRate;
    this.position = 0;
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input && input.length > 0) {
      const out = [];
      while (Math.floor(this.position) < input.length) {
        const index = Math.floor(this.position);
        const fraction = this.position - index;
        const first = input[index] || 0;
        const second = index + 1 < input.length ? input[index + 1] || 0 : first;
        const sample = first + (second - first) * fraction;
        out.push(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))));
        this.position += this.ratio;
      }
      this.position -= input.length;
      if (out.length > 0) {
        const pcm16 = new Int16Array(out);
        this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
      }
    }
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
