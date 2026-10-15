import OpusScript from 'opusscript';

/** Device Opus frames and the existing provider PCM contract stay independent. */
export class EmbodiedAudioCodec {
  private decoder = new OpusScript(16000, 1, OpusScript.Application.VOIP);
  private encoder = new OpusScript(24000, 1, OpusScript.Application.VOIP);
  private pending = Buffer.alloc(0);
  private closed = false;
  constructor(readonly frameMs: 20 | 40 | 60) { this.encoder.setBitrate(24000); }
  decode(packet: Buffer) {
    if (this.closed || !packet.length || packet.length > 3828) throw Error('Invalid Opus frame.');
    const pcm = this.decoder.decode(packet);
    if (!pcm.length || pcm.length % 640 || pcm.length > 1920) throw Error('Unsupported Opus duration.');
    const frames: Buffer[] = [];
    for (let at = 0; at < pcm.length; at += 640) frames.push(Buffer.from(pcm.subarray(at, at + 640)));
    return frames;
  }
  encode(pcm: Buffer, final = false): Buffer[] {
    if (this.closed || pcm.length % 2) throw Error('Invalid PCM audio.');
    this.pending = Buffer.concat([this.pending, pcm]);
    const bytes = this.frameMs * 24 * 2, packets: Buffer[] = [];
    if (final && this.pending.length % bytes) this.pending = Buffer.concat([this.pending, Buffer.alloc(bytes - this.pending.length % bytes)]);
    while (this.pending.length >= bytes) {
      packets.push(Buffer.from(this.encoder.encode(this.pending.subarray(0, bytes), bytes / 2)));
      this.pending = this.pending.subarray(bytes);
    }
    return packets;
  }
  clear() { this.pending = Buffer.alloc(0); }
  close() { if (this.closed) return; this.closed = true; this.decoder.delete(); this.encoder.delete(); this.clear(); }
}
