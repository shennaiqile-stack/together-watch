using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

/// <summary>
/// 一起看 · 单文件启动器
/// 把内置的程序包解压到 %LOCALAPPDATA%\TogetherWatch\app-&lt;版本&gt;，
/// 然后用用户目录作为数据目录启动主程序（不碰系统临时目录）。
/// </summary>
static class Program
{
    const string AppVersion = "1.6.13";
    const string ResourceName = "app.zip";

    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            string home = Environment.GetEnvironmentVariable("WT_HOME");
            Log("start home_env=" + (home ?? "<null>") + " exe=" + Application.ExecutablePath);
            if (string.IsNullOrWhiteSpace(home))
            {
                string local = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "TogetherWatchNext");
                if (CanWrite(local)) home = local;
                else
                {
                    Log("local not writable: " + local + " err=" + LastWriteError);
                    home = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "TogetherWatchNext-home");
                }
                if (!CanWrite(home))
                    throw new IOException("没有可写的目录，无法保存配置。\r\n请把程序放到有写入权限的文件夹再试。");
            }
            Directory.CreateDirectory(home);
            Log("home=" + home);

            string appDir = Path.Combine(home, "app-" + AppVersion);
            string stamp = Path.Combine(appDir, ".ok");
            // 用「版本 + 内置包大小」做指纹，重新打包后一定会重新解压，不会跑到旧代码
            string expected = AppVersion + ":" + BundleSize(ResourceName);

            if (!File.Exists(stamp) || ReadStamp(stamp) != expected || !PayloadReady(appDir))
            {
                Directory.CreateDirectory(appDir);
                ExtractEmbedded(ResourceName, appDir);
                File.WriteAllText(stamp, expected);
            }

            string exe = Path.Combine(appDir, "TogetherWatch.exe");
            if (!File.Exists(exe))
                throw new FileNotFoundException("解压后找不到主程序：" + exe);

            var psi = new ProcessStartInfo(exe);
            psi.UseShellExecute = false;
            psi.WorkingDirectory = appDir;
            psi.CreateNoWindow = true;
            psi.EnvironmentVariables["WT_DATA_DIR"] = Path.Combine(home, "data");
            psi.Arguments = JoinArgs(args);
            Process.Start(psi);

            // An older process may still serve files from its installation.
            // Keep version directories until an explicit, offline cleanup.
            return 0;
        }
        catch (Exception ex)
        {
            try
            {
                MessageBox.Show(
                    "「一起看」启动失败：\r\n\r\n" + ex.Message + "\r\n\r\n" + ex.StackTrace,
                    "一起看", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            catch { }
            return 1;
        }
    }

    static string LastWriteError = "";

    static long BundleSize(string name)
    {
        using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
            return stream == null ? -1 : stream.Length;
    }

    static string ReadStamp(string path)
    {
        try { return File.ReadAllText(path).Trim(); }
        catch { return ""; }
    }

    static bool PayloadReady(string dir)
    {
        string[] required = {
            "TogetherWatch.exe", "_internal/web/index.html", "_internal/web/css/app.css",
            "_internal/web/js/app.js", "_internal/web/js/interface.js", "_internal/web/js/theme.js",
            "_internal/web/js/player.js", "_internal/web/js/sync.js", "_internal/web/js/media-source.js",
            "_internal/web/js/home-art.js", "_internal/web/art/bangumi/index.json",
            "_internal/web/js/source-engine.js", "_internal/web/js/personal-account.js", "_internal/web/js/chat-alerts.js", "_internal/web/js/fullscreen.js", "_internal/web/art/providers.json",
            "_internal/web/js/downloads.js", "_internal/web/js/anime-sources.js", "_internal/web/js/hls.min.js",
            "_internal/web/css/discovery.css", "_internal/web/js/discovery.js", "_internal/web/js/room-notice.js", "_internal/web/art/discovery/index.json"
        };
        foreach (string file in required)
        {
            string target = Path.Combine(dir, file.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(target) || new FileInfo(target).Length == 0) return false;
        }
        return true;
    }

    static bool SameContent(ZipArchiveEntry entry, string target)
    {
        if (!File.Exists(target) || new FileInfo(target).Length != entry.Length) return false;
        using (var hash = System.Security.Cryptography.SHA256.Create())
        using (var existing = File.Open(target, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        using (var packed = entry.Open())
        {
            byte[] first = hash.ComputeHash(existing);
            byte[] second = hash.ComputeHash(packed);
            return Convert.ToBase64String(first) == Convert.ToBase64String(second);
        }
    }

    static void Log(string msg)
    {
        try
        {
            string dir = Path.GetDirectoryName(Application.ExecutablePath);
            File.AppendAllText(Path.Combine(dir, "launcher.log"),
                DateTime.Now.ToString("HH:mm:ss") + " " + msg + Environment.NewLine, Encoding.UTF8);
        }
        catch { }
    }

    static bool CanWrite(string dir)
    {
        try
        {
            if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
        }
        catch (Exception e) { LastWriteError = e.GetType().Name + ": " + e.Message; return false; }

        // 杀毒软件扫描/占用目录时，第一次写探测文件可能失败，稍等重试几次
        for (int i = 0; i < 4; i++)
        {
            try
            {
                string probe = Path.Combine(dir, ".write-test-" + Guid.NewGuid().ToString("N"));
                File.WriteAllText(probe, "1");
                File.Delete(probe);
                return true;
            }
            catch (Exception e)
            {
                LastWriteError = e.GetType().Name + ": " + e.Message;
                System.Threading.Thread.Sleep(250);
            }
        }
        return false;
    }

    static string JoinArgs(string[] args)
    {
        var sb = new StringBuilder();
        foreach (var a in args)
        {
            if (sb.Length > 0) sb.Append(' ');
            if (a.IndexOf(' ') >= 0 || a.IndexOf('\t') >= 0)
                sb.Append('"').Append(a.Replace("\"", "\\\"")).Append('"');
            else
                sb.Append(a);
        }
        return sb.ToString();
    }

    static void ExtractEmbedded(string name, string dest)
    {
        using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
        {
            if (stream == null)
                throw new InvalidOperationException("程序包损坏：找不到内置资源 " + name);

            using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                string root = Path.GetFullPath(dest);
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    string target = Path.GetFullPath(Path.Combine(root, entry.FullName));
                    if (!target.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                        continue;
                    if (entry.Name.Length == 0)
                    {
                        Directory.CreateDirectory(target);
                        continue;
                    }
                    string dir = Path.GetDirectoryName(target);
                    if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                    // Repair missing assets without deleting files used by a live process.
                    if (!SameContent(entry, target)) entry.ExtractToFile(target, true);
                }
            }
        }
    }

}
