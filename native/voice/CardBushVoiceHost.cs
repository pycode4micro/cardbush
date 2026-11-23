using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Speech.Recognition;
using System.Web.Script.Serialization;

sealed class VoiceHostException : Exception
{
    public VoiceHostException(string code) : base(code) {}
}

// One bounded request per process. Audio is received over stdin and never saved to disk.
// Uses installed Windows recognition and synthesis engines; never online dictation.
class CardBushVoiceHost
{
    class Request {
        public string action { get; set; }
        public string language { get; set; }
        public string gender { get; set; }
        public string voice { get; set; }
        public string text { get; set; }
        public string audio { get; set; }
        public double speed { get; set; }
    }
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 18 * 1024 * 1024 };
    static void Emit(object value) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
    static void Fail(string code) { throw new VoiceHostException(code); }
    static void Main()
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try {
            var input = new StringBuilder(); var chars = new char[8192]; int read;
            while ((read = Console.In.Read(chars, 0, chars.Length)) > 0) {
                if (input.Length + read > 18 * 1024 * 1024) Fail("voiceNative.windowsRecordingTooLarge");
                input.Append(chars, 0, read);
            }
            var request = Json.Deserialize<Request>(input.ToString());
            if (request == null) Fail("voiceNative.windowsInvalidRequest");
            if (request.action == "capabilities") {
                var voices = WindowsVoices.Installed();
                var recognizers = SpeechRecognitionEngine.InstalledRecognizers().Select(r => new { id = r.Id, name = r.Name, language = r.Culture.Name }).ToArray();
                Emit(new { type = "result", available = true, voices, recognizers });
            } else if (request.action == "speak") {
                if (String.IsNullOrWhiteSpace(request.text) || request.text.Length > 3000 || request.speed < .5 || request.speed > 2) Fail("voiceNative.windowsInvalidSpeech");
                WindowsVoices.Speak(request.text, request.language, request.gender, request.voice, request.speed, Emit);
                Emit(new { type = "result" });
            } else if (request.action == "transcribe") {
                var info = SpeechRecognitionEngine.InstalledRecognizers().FirstOrDefault(r => r.Culture.Name.Equals(request.language, StringComparison.OrdinalIgnoreCase));
                if (info == null) Fail("voiceNative.windowsRecognizerMissing");
                var audio = Convert.FromBase64String(request.audio ?? "");
                if (audio.Length < 44 || audio.Length > 12 * 1024 * 1024) Fail("voiceNative.windowsInvalidRecording");
                using (var inputAudio = new MemoryStream(audio, false))
                using (var engine = new SpeechRecognitionEngine(info))
                using (var completed = new ManualResetEvent(false)) {
                    engine.LoadGrammar(new DictationGrammar());
                    engine.SetInputToWaveStream(inputAudio);
                    var text = new StringBuilder(); Exception recognitionError = null;
                    engine.SpeechRecognized += (sender, args) => {
                        if (text.Length > 64000) return;
                        if (text.Length > 0 && !request.language.StartsWith("zh", StringComparison.OrdinalIgnoreCase)) text.Append(' ');
                        text.Append(args.Result.Text);
                    };
                    engine.RecognizeCompleted += (sender, args) => { recognitionError = args.Error; completed.Set(); };
                    engine.RecognizeAsync(RecognizeMode.Multiple);
                    if (!completed.WaitOne(60000)) { engine.RecognizeAsyncCancel(); Fail("voiceNative.windowsRecognitionTimedOut"); }
                    if (recognitionError != null) Fail("voiceNative.windowsRecognitionFailed");
                    if (text.Length > 64000) Fail("voiceNative.windowsTranscriptTooLong");
                    Emit(new { type = "result", text = text.ToString() });
                }
            } else Fail("voiceNative.windowsUnsupportedAction");
        } catch (VoiceHostException error) {
            Emit(new { type = "error", code = error.Message }); Environment.ExitCode = 1;
        } catch {
            Emit(new { type = "error", code = "voiceNative.windowsEngineUnavailable" }); Environment.ExitCode = 1;
        }
    }
}
