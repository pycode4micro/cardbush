/** PCM16/16 kHz capture with browser AEC. AudioWorklet avoids main-thread sampling drift. */
export class RealtimeVoiceAudio {
  private input?: AudioContext;
  private output?: AudioContext;
  private outputGain?: GainNode;
  private outputMuted = false;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private sources = new Set<AudioBufferSourceNode>();
  private cursor = 0;
  private closed = false;
  constructor(private frame: (pcm: ArrayBuffer) => void, private playing: (active: boolean) => void,
    private level: (value: number) => void, private failed: (error: Error) => void) {}
  async prepare(microphoneId: string) {
    try {
      this.input = new AudioContext({ sampleRate: 16000 });
      this.output = new AudioContext({ sampleRate: 24000 });
      this.outputGain = this.output.createGain(); this.outputGain.gain.value = this.outputMuted ? 0 : 1;
      this.outputGain.connect(this.output.destination);
      if (this.input.sampleRate !== 16000) throw Error('当前音频设备不支持 16 kHz 实时采集。');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true,
        autoGainControl: true, channelCount: 1, ...(microphoneId ? { deviceId: { exact: microphoneId } } : {}) }, video: false });
      if (this.closed) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      for (const track of stream.getAudioTracks()) track.onended = () => { if (!this.closed) this.failed(Error('麦克风已断开，请重新开始通话。')); };
      await this.input.audioWorklet.addModule(new URL('voice/realtime-capture-worklet.js', document.baseURI).href);
      if (this.closed) return;
      this.node = new AudioWorkletNode(this.input, 'cardbush-realtime-capture');
      this.node.port.onmessage = ({ data }) => {
        if (this.closed || !(data instanceof ArrayBuffer)) return;
        const samples = new Int16Array(data); let sum = 0;
        for (const value of samples) sum += (value/32768)**2;
        this.level(Math.min(1,Math.sqrt(sum/samples.length)*5)); this.frame(data);
      };
      const gain = this.input.createGain(); gain.gain.value = 0;
      this.input.createMediaStreamSource(stream).connect(this.node).connect(gain).connect(this.input.destination);
      await this.input.resume(); await this.output.resume();
    } catch (error) { this.close(); throw error; }
  }
  mute(muted: boolean) {
    this.node?.port.postMessage(!muted);
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
    if (muted) this.level(0);
  }
  setOutputMuted(value: boolean) {
    this.outputMuted = value;
    if (this.outputGain) this.outputGain.gain.value = value ? 0 : 1;
  }
  append(pcm: string, rate: number) {
    const context = this.output; if (!context || this.closed) return;
    const bytes = atob(pcm), view = new DataView(new ArrayBuffer(bytes.length));
    for (let i=0;i<bytes.length;i++) view.setUint8(i,bytes.charCodeAt(i));
    if (bytes.length%2 || rate!==24000) throw Error('不支持的实时语音格式。');
    if (!bytes.length) return;
    // Synthesis may run much faster than playback, especially for long replies. Ten seconds
    // of scheduled speech is normal, not a transport failure. Bound PCM to about 6 MiB instead.
    if (Math.max(0,this.cursor-context.currentTime)+bytes.length/2/rate>120) throw Error('实时语音播放积压超过两分钟，请重新开始通话。');
    const buffer=context.createBuffer(1,bytes.length/2,rate), channel=buffer.getChannelData(0);
    for (let i=0;i<channel.length;i++) channel[i]=view.getInt16(i*2,true)/32768;
    const source=context.createBufferSource(); source.buffer=buffer; source.connect(this.outputGain ?? context.destination);
    source.onended=()=>{ this.sources.delete(source); source.disconnect(); if (!this.sources.size) this.playing(false); };
    this.sources.add(source); this.cursor=Math.max(this.cursor,context.currentTime+.02);
    source.start(this.cursor); this.cursor+=buffer.duration; this.playing(true);
  }
  stop() { for (const source of this.sources) { source.onended=null; try { source.stop(); } catch {} source.disconnect(); } this.sources.clear(); this.cursor=0; this.playing(false); }
  close() { this.closed=true; this.stop(); this.node?.disconnect(); this.node?.port.close(); this.stream?.getTracks().forEach(track=>track.stop());
    void this.input?.close().catch(()=>{}); void this.output?.close().catch(()=>{}); }
}
