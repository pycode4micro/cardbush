using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;

internal static class BrowserConnectionApproval
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int MessageBox(IntPtr window, string text, string title, uint flags);

    public static int Run(string browser)
    {
        if (browser != "chrome" && browser != "edge") return 2;
        if (!Environment.UserInteractive) return 3;
        try
        {
            // Different local profiles must not stack authorization dialogs.
            using (var mutex = new Mutex(false, @"Local\CardBushBrowserConnectionApproval-" + WindowsIdentity.GetCurrent().User.Value))
            {
                bool acquired;
                try { acquired = mutex.WaitOne(0); } catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) return 3;
                try
                {
                    string name = browser == "edge" ? "Microsoft Edge" : "Google Chrome";
                    bool chinese = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "zh";
                    string text = chinese
                        ? "允许此浏览器连接 CardBush 吗？\n\n请求的浏览器：" + name + "\n\n允许后，请在浏览器扩展中确认连接。本机 CardBush App 和 CLI 将共用此连接并自动重连，网页访问仍需单独授权。\n\n请仅在你已安装并启用 CardBush Browser Use 扩展时允许。可在 CardBush 设置中移除此连接。"
                        : "Allow this browser to connect to CardBush?\n\nRequested browser: " + name + "\n\nAfter allowing, confirm in the browser extension. The local CardBush App and CLI will share this connection and reconnect automatically. Website access still requires separate authorization.\n\nAllow only if you installed and enabled CardBush Browser Use. You can remove this connection in CardBush settings.";
                    // Yes/No, question icon, No selected, foreground. This is an
                    // application consent dialog, never elevation or a UAC bypass.
                    int result = MessageBox(IntPtr.Zero, text, chinese ? "CardBush 浏览器连接" : "CardBush browser connection", 0x10024U | 0x100U);
                    Console.Write(result == 6 ? "approved" : "denied");
                    return 0;
                }
                finally { mutex.ReleaseMutex(); }
            }
        }
        catch { return 3; }
    }
}
