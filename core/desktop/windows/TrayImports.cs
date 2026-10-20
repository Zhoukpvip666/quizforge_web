using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace QuizForge.Desktop
{
    internal sealed class LocalImportStatus
    {
        public string id, state, fileName, message, bankId, source, packId, cleanupWarning;
        public long revision;
        public int importedBanks, importedExtensions;
    }

    internal sealed partial class TrayContext
    {
        private readonly Dictionary<string, string> activeImports = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        private Task importWork = Task.FromResult(false);
        private LocalImportStatus lastImport;
        private string lastOpenedUrl = "";
        private string hubCleanupWarning;

        private void RecordHubCleanupWarning(string warning)
        {
            hubCleanupWarning = warning;
            try
            {
                string logs = Path.Combine(options.DataRoot, "logs"); Directory.CreateDirectory(logs);
                File.AppendAllText(Path.Combine(logs, "hub-import.log"), DateTime.UtcNow.ToString("o") + " " + warning + Environment.NewLine);
            }
            catch { /* Keep the warning in tray status if logging is unavailable. */ }
        }

        // Called only on the UI thread; repeated opens of the same pending file
        // share one job. Opening it again after completion imports a fresh copy.
        private string QueueImport(string file)
        {
            if (quitting) throw new IOException("应用正在退出，请稍后重新打开题库。");
            file = LocalPackageImport.ValidateFile(file);
            var status = new LocalImportStatus { source = "file", fileName = Path.GetFileName(file) };
            return QueueImportJob("file:" + file, status, () => LocalPackageImport.Upload(url, file));
        }
        private string QueueHubImport(HubImportRequest request)
        {
            request = HubImportRequest.Parse(request.Uri);
            var status = new LocalImportStatus { source = "hub", fileName = "Hub 题库", packId = request.PackId, revision = long.Parse(request.Revision, System.Globalization.CultureInfo.InvariantCulture) };
            return QueueImportJob(request.Key, status, () => hub.Import(url, options.DataRoot, request,
                (next, message) => Post(() =>
                {
                    status.state = next; status.message = message; lastImport = status;
                    if (!quitting) SetState("运行中", message);
                }), warning => Post(() => { status.cleanupWarning = warning; RecordHubCleanupWarning(warning); })));
        }
        private string QueueImportJob(string key, LocalImportStatus status, Func<Task<ImportedPackage>> import)
        {
            if (quitting) throw new IOException("应用正在退出，请稍后重新打开题库。");
            string existing;
            if (activeImports.TryGetValue(key, out existing)) return existing;
            if (activeImports.Count >= 20) throw new IOException("待导入文件较多，请等待当前导入完成。");
            status.id = Guid.NewGuid().ToString(); status.state = "queued"; status.message = "等待服务就绪并导入…";
            activeImports.Add(key, status.id); lastImport = status;
            importWork = importWork.ContinueWith(async _ =>
            {
                try
                {
                    if (!await ready.Task) throw new IOException("服务未能启动，请查看托盘的运行情况后重试。");
                    Post(() =>
                    {
                        status.state = status.source == "hub" ? "downloading" : "importing"; status.message = "正在处理导入：" + status.fileName; lastImport = status;
                        if (!quitting) SetState("运行中", "正在导入：" + status.fileName);
                        if (!options.NoBrowser && !quitting) tray.ShowBalloonTip(3000, "QuizForge", "正在导入：" + status.fileName, ToolTipIcon.Info);
                    });
                    var imported = await import();
                    Post(() =>
                    {
                        status.state = "completed"; status.bankId = imported.BankId; status.importedBanks = imported.Banks; status.importedExtensions = imported.Extensions;
                        status.message = "已导入「" + imported.Name + "」：" + imported.Banks + " 本题库、" + imported.Extensions + " 个拓展。";
                        lastImport = status; activeImports.Remove(key);
                        if (!quitting)
                        {
                            SetState("运行中", status.message);
                            if (!options.NoBrowser) tray.ShowBalloonTip(4000, "QuizForge 导入完成", status.message, ToolTipIcon.Info);
                            OpenPage(imported.BankId);
                        }
                    });
                }
                catch (Exception error)
                {
                    Post(() =>
                    {
                        status.state = "failed"; status.message = error.Message; lastImport = status; activeImports.Remove(key);
                        if (!quitting)
                        {
                            if (startedAt.HasValue && service != null && !service.HasExited) SetState("运行中", "导入失败：" + status.message);
                            if (!options.NoBrowser) tray.ShowBalloonTip(5000, "QuizForge 导入失败", status.message, ToolTipIcon.Error);
                        }
                    });
                }
            }, TaskScheduler.Default).Unwrap();
            return status.id;
        }
    }
}
