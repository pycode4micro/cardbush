using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

// A bounded, CPU-only embedding request. No microphone, network or audio files.
class CardBushSpeakerHost
{
    [StructLayout(LayoutKind.Sequential)] struct Config { public IntPtr model; public int threads; public int debug; public IntPtr provider; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool SetDllDirectory(string path);
    [DllImport("sherpa-onnx-c-api.dll", CallingConvention = CallingConvention.Cdecl)] static extern IntPtr SherpaOnnxCreateSpeakerEmbeddingExtractor(ref Config config);
    [DllImport("sherpa-onnx-c-api.dll", CallingConvention = CallingConvention.Cdecl)] static extern int SherpaOnnxSpeakerEmbeddingExtractorDim(IntPtr extractor);
    [DllImport("sherpa-onnx-c-api.dll", CallingConvention = CallingConvention.Cdecl)] static extern IntPtr SherpaOnnxSpeakerEmbeddingExtractorCreateStream(IntPtr extractor);
    [DllImport("sherpa-onnx-c-api.dll", CallingConvention = CallingConvention.Cdecl)] static extern void SherpaOnnxOnlineStreamAcceptWaveform(IntPtr stream, int rate, float[] samples, int count);
    [DllImport("sherpa-onnx-c-api.dll", CallingConvention = CallingConvention.Cdecl)] static extern void SherpaOnnxOnlineStreamInputFinished(IntPtr stream);
    [DllImport("sherpa-onnx-c-api.dll", CallingConvention = CallingConvention.Cdecl)] static extern int SherpaOnnxSpeakerEmbeddingExtractorIsReady(IntPtr extractor, IntPtr stream);
    [DllImport("sherpa-onnx-c-api.dll", CallingConvention = CallingConvention.Cdecl)] static extern IntPtr SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding(IntPtr extractor, IntPtr stream);
    [DllImport("sherpa-onnx-c-api.dll", CallingConvention = CallingConvention.Cdecl)] static extern void SherpaOnnxSpeakerEmbeddingExtractorDestroyEmbedding(IntPtr embedding);
    [DllImport("sherpa-onnx-c-api.dll", CallingConvention = CallingConvention.Cdecl)] static extern void SherpaOnnxDestroyOnlineStream(IntPtr stream);
    [DllImport("sherpa-onnx-c-api.dll", CallingConvention = CallingConvention.Cdecl)] static extern void SherpaOnnxDestroySpeakerEmbeddingExtractor(IntPtr extractor);
    class Request { public string directory { get; set; } public string[] clips { get; set; } }
    static IntPtr Utf8(string text) { byte[] bytes = Encoding.UTF8.GetBytes(text + "\0"); IntPtr ptr = Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes, 0, ptr, bytes.Length); return ptr; }
    static int Main()
    {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        var json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
        try {
            var text = new StringBuilder(); char[] block = new char[8192]; int read;
            while ((read = Console.In.Read(block, 0, block.Length)) > 0) { text.Append(block, 0, read); if (text.Length > 16 * 1024 * 1024) throw new Exception(); }
            var input = json.Deserialize<Request>(text.ToString());
            if (input == null || !Path.IsPathRooted(input.directory) || input.clips == null || input.clips.Length < 1 || input.clips.Length > 64) throw new Exception();
            if (!SetDllDirectory(input.directory)) throw new Exception();
            var config = new Config { model = Utf8(Path.Combine(input.directory, "campplus.onnx")), threads = 2, debug = 0, provider = Utf8("cpu") };
            IntPtr extractor = IntPtr.Zero;
            try {
                extractor = SherpaOnnxCreateSpeakerEmbeddingExtractor(ref config);
                if (extractor == IntPtr.Zero) throw new Exception();
                int dim = SherpaOnnxSpeakerEmbeddingExtractorDim(extractor);
                if (dim < 1 || dim > 1024) throw new Exception();
                var vectors = new List<float[]>();
                foreach (string clip in input.clips) {
                    if (clip == null || clip.Length > 700000) throw new Exception();
                    byte[] pcm = Convert.FromBase64String(clip);
                    if (pcm.Length < 32000 || pcm.Length > 512000 || pcm.Length % 2 != 0) throw new Exception();
                    var samples = new float[pcm.Length / 2];
                    for (int i = 0; i < samples.Length; i++) samples[i] = BitConverter.ToInt16(pcm, i * 2) / 32768f;
                    IntPtr stream = SherpaOnnxSpeakerEmbeddingExtractorCreateStream(extractor), embedding = IntPtr.Zero;
                    if (stream == IntPtr.Zero) throw new Exception();
                    try {
                        SherpaOnnxOnlineStreamAcceptWaveform(stream, 16000, samples, samples.Length);
                        SherpaOnnxOnlineStreamInputFinished(stream);
                        if (SherpaOnnxSpeakerEmbeddingExtractorIsReady(extractor, stream) == 0) throw new Exception();
                        embedding = SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding(extractor, stream);
                        if (embedding == IntPtr.Zero) throw new Exception();
                        var vector = new float[dim]; Marshal.Copy(embedding, vector, 0, dim);
                        foreach (float value in vector) if (float.IsNaN(value) || float.IsInfinity(value)) throw new Exception();
                        vectors.Add(vector);
                    } finally { if (embedding != IntPtr.Zero) SherpaOnnxSpeakerEmbeddingExtractorDestroyEmbedding(embedding); SherpaOnnxDestroyOnlineStream(stream); }
                }
                Console.WriteLine(json.Serialize(new { vectors = vectors }));
            } finally { if (extractor != IntPtr.Zero) SherpaOnnxDestroySpeakerEmbeddingExtractor(extractor); Marshal.FreeHGlobal(config.model); Marshal.FreeHGlobal(config.provider); }
            return 0;
        } catch { Console.WriteLine("{\"error\":\"speaker_embedding_failed\"}"); return 1; }
    }
}
