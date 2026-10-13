import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * A non-reentrant file lock that survives process crashes.
 *
 * Why exclusive creation over `fs.flock`?
 * - `fs.flock` (the natural tool for this job) is not part of Node's
 *   public `fs` API. Relying on it would require a native addon, and the
 *   zero-dependency brief forbids that.
 * - `fs.open(path, 'wx')` is standard and cross-platform. It fails with
 *   EEXIST if the file is already there, which is exactly the "locked"
 *   signal we need.
 *
 * The lock is held for the lifetime of the returned FileLock object.
 * Call `release()` to let go early. If the process crashes, the OS
 * closes the file descriptor, the inode is freed, and a subsequent
 * attempt can successfully re-create the file — no stale lock remains.
 *
 * Because the lock is keyed on a file *path*, not a file *inode*, there
 * is a deliberate gap: if the holder crashes *and* a new process creates
 * a new lockfile at a different path before the OS finalises the
 * teardown, both could briefly believe they hold the lock. We do not
 * try to patch this race with heartbeats or hostnames; that would trade
 * a narrow crash window for stale-lock complexity. The user who needs
 * a distributed mutex needs a different tool.
 */
export class FileLock {
  #lockPath = null;
  #fd = null;

  constructor() {
    // No I/O in the constructor — locks are acquired explicitly so
    // that failures surface at the call site, not at object creation.
  }

  /**
   * Attempt to acquire the lock at `lockPath`.
   * @param {string} lockPath Absolute path to the lock file.
   * @returns {boolean} `true` if this call acquired the lock,
   *   `false` if it was already held.
   * @throws {Error} for any failure other than EEXIST (permissions,
   *   missing parent directory, ENOSPC, etc.).
   */
  acquire(lockPath) {
    if (this.#fd !== null) {
      // Non-reentrant by design. Re-acquiring would silently swallow
      // the second caller's intent; throwing forces the caller to be
      // explicit about the second lock's path.
      throw new Error(`FileLock already holds ${this.#lockPath}`);
    }
    // 'x' = O_EXCL: fail if the file exists. This is what makes the
    // lock crash-safe rather than merely advisory.
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        return false;
      }
      throw err;
    }
    this.#lockPath = lockPath;
    this.#fd = fd;
    return true;
  }

  /**
   * Release the lock by deleting the lockfile and closing the fd.
   * @returns {boolean} `true` if a held lock was released,
   *   `false` if the lock was not held (idempotent).
   */
  release() {
    if (this.#fd === null) {
      return false;
    }
    const p = this.#lockPath;
    const fd = this.#fd;
    this.#lockPath = null;
    this.#fd = null;

    // fs.closeSync before fs.unlinkSync: ensures the fd is closed even
    // if the unlink fails (e.g. another process deleted it first).
    fs.closeSync(fd);
    try {
      fs.unlinkSync(p);
    } catch {
      // The lock is functionally released once the fd is closed.
      // A missing file here just means someone cleaned up for us.
    }
    return true;
  }
}

// Internal helper used by tests to build a scratch lock path in the
// OS temp dir without polluting the test's own source tree.
export function _tempLockPath(prefix = 'file-lock-kit-') {
  return path.join(os.tmpdir(), `${prefix}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}
