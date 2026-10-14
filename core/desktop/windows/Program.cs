using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace QuizForge.Desktop
{
    internal sealed class Options
    {
        internal string Root = Application.StartupPath;
        internal int Port = 8787;
        internal bool NoBrowser;
        internal string Command = "open";
        internal string PipeName;
        internal static Options Parse(string[] args)
        {
            var result = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--root": result.Root = args[++i]; break;
                    case "--port": result.Port = int.Parse(args[++i]); break;
                    case "--no-browser": result.NoBrowser = true; break;
                    case "--status": result.Command = "status"; break;
                    case "--quit": result.Command = "quit"; break;
                    default: throw new ArgumentException("未知启动参数：" + args[i]);
                }
            }
            result.Root = Path.GetFullPath(result.Root);
            if (result.Root.Length > 3) result.Root = result.Root.TrimEnd(Path.DirectorySeparatorChar);
            if (!Directory.Exists(result.Root) || result.Port < 0 || result.Port > 65535) throw new ArgumentException("应用目录或端口无效。");
            using (var digest = SHA256.Create())
                result.PipeName = "QuizForgeTray-" + BitConverter.ToString(digest.ComputeHash(Encoding.UTF8.GetBytes(result.Root.ToLowerInvariant()))).Replace("-", "");
            return result;
        }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            Options options = null;
            try
            {
                options = Options.Parse(args);
                // Control clients must not create the owner mutex: a status or
                // exit request can arrive before the first launcher has started.
                if (options.Command != "open")
                {
                    Console.WriteLine(SingleInstance.Send(options.PipeName, options.Command));
                    return 0;
                }
                bool first;
                using (var mutex = new Mutex(true, "Local\\" + options.PipeName, out first))
                {
                    if (!first)
                    {
                        Console.WriteLine(SingleInstance.Send(options.PipeName, options.Command));
                        return 0;
                    }
                    try
                    {
                        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
                        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
                        using (var context = new TrayContext(options)) Application.Run(context);
                    }
                    finally { mutex.ReleaseMutex(); }
                }
                return 0;
            }
            catch (Exception error)
            {
                string message = "QuizForge 无法启动：" + error.Message;
                if (options == null || options.Command == "open" && !options.NoBrowser)
                    MessageBox.Show(message, "QuizForge", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Console.Error.WriteLine(message);
                return 1;
            }
        }
    }

    internal static class SingleInstance
    {
        internal static string Send(string name, string command)
        {
            using (var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut))
            {
                pipe.Connect(5000);
                using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true))
                using (var reader = new StreamReader(pipe, Encoding.UTF8, false, 1024, true))
                {
                    writer.WriteLine(command); writer.Flush();
                    var response = reader.ReadLineAsync();
                    if (!response.Wait(5000)) throw new IOException("托盘程序未响应，请稍后重试。");
                    return response.Result;
                }
            }
        }
        internal static async Task Listen(string name, Func<string, Task<string>> handle, CancellationToken cancellation)
        {
            var security = new PipeSecurity(); security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
            while (!cancellation.IsCancellationRequested)
            {
                try
                {
                    using (var pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, security))
                    using (cancellation.Register(() => pipe.Dispose()))
                    {
                        await pipe.WaitForConnectionAsync(cancellation);
                        using (var reader = new StreamReader(pipe, Encoding.UTF8, false, 1024, true))
                        using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true))
                        {
                            var reading = reader.ReadLineAsync();
                            if (await Task.WhenAny(reading, Task.Delay(3000, cancellation)) != reading) continue;
                            string command = await reading;
                            if (command != "open" && command != "status" && command != "quit") continue;
                            await writer.WriteLineAsync(await handle(command)); await writer.FlushAsync();
                        }
                    }
                }
                catch (OperationCanceledException) { break; }
                catch (ObjectDisposedException) { if (cancellation.IsCancellationRequested) break; }
                catch (IOException) { if (cancellation.IsCancellationRequested) break; }
            }
        }
    }
}
