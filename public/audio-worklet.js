class PulseLinkPcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || !input[0].length) return true;
    const channel = input[0];
    const pcm = new Int16Array(channel.length);
    let sum = 0;
    for (let i = 0; i < channel.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, channel[i]));
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      sum += Math.abs(sample);
    }
    this.port.postMessage({ pcm: pcm.buffer, level: sum / channel.length }, [pcm.buffer]);
    return true;
  }
}

registerProcessor('pulselink-pcm-capture', PulseLinkPcmCapture);
