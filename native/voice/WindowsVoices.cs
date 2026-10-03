using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Speech.AudioFormat;
using System.Speech.Synthesis;
using Windows.Foundation;
using Windows.Storage.Streams;
using ModernSynth = Windows.Media.SpeechSynthesis.SpeechSynthesizer;

static class WindowsVoices
{
    public class Voice {
        public string id { get; set; }
        public string name { get; set; }
        public string language { get; set; }
        public string gender { get; set; }
    }
    public static Voice[] Installed() {
        var voices = new List<Voice>();
        // Modern language packs and legacy SAPI voices are separate inventories.
        foreach (var voice in ModernSynth.AllVoices) voices.Add(new Voice {
            id = "winrt:" + voice.Id, name = voice.DisplayName, language = voice.Language, gender = voice.Gender.ToString().ToLowerInvariant()
        });
        using (var synth = new SpeechSynthesizer()) foreach (var voice in synth.GetInstalledVoices().Where(v => v.Enabled).Select(v => v.VoiceInfo)) voices.Add(new Voice {
            id = "sapi:" + voice.Name, name = voice.Name, language = voice.Culture.Name, gender = voice.Gender.ToString().ToLowerInvariant()
        });
        return voices.ToArray();
    }
    public static void Speak(string text, string language, string gender, string id, double speed, Action<object> emit) {
        var selected = Installed().FirstOrDefault(v => v.language.Equals(language, StringComparison.OrdinalIgnoreCase) &&
            v.gender.Equals(gender, StringComparison.OrdinalIgnoreCase) && (String.IsNullOrEmpty(id) || v.id == id));
        if (selected == null) throw new InvalidOperationException("未安装所选语言和性别的系统音色，请在 Windows 设置中安装语音包，或选择其他已安装音色。");
        if (selected.id.StartsWith("sapi:")) {
            using (var synth = new SpeechSynthesizer()) using (var output = new PcmOutput(emit)) {
                synth.SelectVoice(selected.name);
                synth.Rate = Math.Max(-10, Math.Min(10, (int)Math.Round(Math.Log(speed, 2) * 6)));
                synth.SetOutputToAudioStream(output, new SpeechAudioFormatInfo(24000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
                synth.Speak(text);
            }
            return;
        }
        using (var synth = new ModernSynth()) {
            synth.Voice = ModernSynth.AllVoices.First(v => "winrt:" + v.Id == selected.id);
            synth.Options.SpeakingRate = speed;
            var job = synth.SynthesizeTextToStreamAsync(text);
            while (job.Status == AsyncStatus.Started) Thread.Sleep(10);
            using (var result = job.GetResults()) using (var reader = new DataReader(result)) {
                if (result.Size > 12 * 1024 * 1024) throw new InvalidOperationException("本地语音回复过长。");
                var loading = reader.LoadAsync((uint)result.Size);
                while (loading.Status == AsyncStatus.Started) Thread.Sleep(10);
                var bytes = new byte[loading.GetResults()]; reader.ReadBytes(bytes);
                EmitWave(bytes, emit);
            }
        }
    }
    static void EmitWave(byte[] bytes, Action<object> emit) {
        using (var reader = new BinaryReader(new MemoryStream(bytes, false))) {
            if (Encoding.ASCII.GetString(reader.ReadBytes(4)) != "RIFF") throw new InvalidOperationException("系统音频格式无效。");
            reader.ReadUInt32();
            if (Encoding.ASCII.GetString(reader.ReadBytes(4)) != "WAVE") throw new InvalidOperationException("系统音频格式无效。");
            int rate = 0; bool valid = false, emitted = false;
            while (reader.BaseStream.Position + 8 <= bytes.Length) {
                var tag = Encoding.ASCII.GetString(reader.ReadBytes(4)); var length = reader.ReadUInt32();
                long start = reader.BaseStream.Position, end = start + length;
                if (end > bytes.Length) throw new InvalidOperationException("系统音频数据不完整。");
                if (tag == "fmt " && length >= 16) {
                    var format = reader.ReadUInt16(); var channels = reader.ReadUInt16(); rate = reader.ReadInt32();
                    reader.ReadUInt32(); reader.ReadUInt16(); var bits = reader.ReadUInt16();
                    valid = format == 1 && channels == 1 && bits == 16 && rate >= 8000 && rate <= 48000;
                } else if (tag == "data") {
                    if (!valid || length % 2 != 0) throw new InvalidOperationException("系统音频不是受支持的单声道 PCM。");
                    for (long offset = start; offset < end; offset += 4800) {
                        int count = (int)Math.Min(4800, end - offset);
                        emit(new { type = "audio", pcm = Convert.ToBase64String(bytes, (int)offset, count), sampleRate = rate }); emitted = true;
                    }
                }
                reader.BaseStream.Position = end + (length % 2);
            }
            if (!emitted) throw new InvalidOperationException("系统没有生成音频。");
        }
    }
    sealed class PcmOutput : Stream {
        readonly Action<object> emit;
        public PcmOutput(Action<object> emit) { this.emit = emit; }
        public override bool CanRead { get { return false; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return true; } }
        public override long Length { get { return 0; } }
        public override long Position { get { return 0; } set { throw new NotSupportedException(); } }
        public override void Flush() {}
        public override void Write(byte[] buffer, int offset, int count) {
            if (count > 0) emit(new { type = "audio", pcm = Convert.ToBase64String(buffer, offset, count), sampleRate = 24000 });
        }
        public override int Read(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
        public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
        public override void SetLength(long value) { throw new NotSupportedException(); }
    }
}
