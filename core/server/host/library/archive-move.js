import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ApiError } from '../platform/errors.js';
import { checkPath, exists, within } from '../platform/files.js';

const temporary = new Set(['EPERM', 'EACCES', 'EBUSY']);
// Move only an existing library item into this host's private recovery directory.
// Native Windows moves handle directories rejected by MoveFileEx's replace flag.
export function archiveMove(root, source, destination, { platform = process.platform, rename = fs.renameSync, native = spawnSync, pause = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds) } = {}) {
  root = path.resolve(root); source = path.resolve(source); destination = path.resolve(destination);
  if (![path.join(root, 'question-banks'), path.join(root, 'extensions')].some(base => source !== base && within(base, source)) || !within(path.join(root, '.trash', 'library'), destination)) throw new Error('Invalid archive move scope');
  checkPath(source); checkPath(path.dirname(destination), { directory: true });
  if (exists(destination)) throw new ApiError(409, 'LIBRARY_TARGET_EXISTS', '回收目标已存在，请刷新后重试。');
  let failure;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { rename(source, destination); return; }
    catch (error) {
      failure = error;
      if (platform !== 'win32' || !temporary.has(error.code) || attempt === 3) break;
      pause([10, 30, 60][attempt]);
    }
  }
  if (platform === 'win32' && temporary.has(failure.code) && fs.lstatSync(source).isDirectory()) {
    const script = "$ErrorActionPreference='Stop'; $s=$env:QF_ARCHIVE_SOURCE; $d=$env:QF_ARCHIVE_DESTINATION; if(Test-Path -LiteralPath $d){exit 2}; Move-Item -LiteralPath $s -Destination $d -ErrorAction Stop";
    const result = native('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, encoding: 'utf8', env: { ...process.env, QF_ARCHIVE_SOURCE: source, QF_ARCHIVE_DESTINATION: destination }, stdio: ['ignore', 'ignore', 'pipe'] });
    // A timeout can arrive just after the atomic move completed.
    if (!exists(source) && exists(destination)) { checkPath(destination); return; }
    if (result.status === 0) failure = Object.assign(new Error('Move did not complete'), { code: 'MOVE_INCOMPLETE' });
  }
  if (temporary.has(failure.code)) throw new ApiError(409, 'LIBRARY_MOVE_BLOCKED', `无法移入回收目录（${failure.code}）：文件可能被其他程序占用，或目录没有写入权限。原项目仍保留，请稍后重试。`, { cause: failure });
  if (typeof failure.code === 'string' && /^[A-Z0-9_]+$/.test(failure.code)) throw new ApiError(409, 'LIBRARY_MOVE_FAILED', `移入回收目录未完成（${failure.code}），请刷新目录后重试；不要手动删除原文件。`, { cause: failure });
  throw failure;
}
