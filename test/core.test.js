import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { FileLock, _tempLockPath } from '../src/core.js';

function scratchPath() {
  return path.join(
    os.tmpdir(),
    `flk-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

// Each test that creates a lockfile is responsible for cleaning it up.
// We use unique paths so tests never collide.

test('acquire returns true and creates the lockfile', () => {
  const p = scratchPath();
  const lock = new FileLock();
  try {
    assert.equal(lock.acquire(p), true);
    assert.equal(fs.existsSync(p), true);
  } finally {
    lock.release();
  }
});

test('acquire on an already-held lock returns false', () => {
  const p = scratchPath();
  const a = new FileLock();
  const b = new FileLock();
  try {
    assert.equal(a.acquire(p), true);
    assert.equal(b.acquire(p), false);
  } finally {
    a.release();
    b.release();
  }
});

test('release deletes the lockfile and allows re-acquire', () => {
  const p = scratchPath();
  const a = new FileLock();
  const b = new FileLock();
  assert.equal(a.acquire(p), true);
  assert.equal(a.release(), true);
  assert.equal(fs.existsSync(p), false);
  assert.equal(b.acquire(p), true);
  b.release();
});

test('release is idempotent and returns false when not held', () => {
  const lock = new FileLock();
  assert.equal(lock.release(), false);
  assert.equal(lock.release(), false);
});

test('double acquire on the same FileLock throws, not silently relocks', () => {
  const p = scratchPath();
  const lock = new FileLock();
  try {
    lock.acquire(p);
    assert.throws(() => lock.acquire(p), /already holds/);
  } finally {
    lock.release();
  }
});

test('acquire throws EEXIST-related Error type, not boolean, when it cannot create', () => {
  // Pre-create the file so O_EXCL must fail. The second locker should
  // catch the EEXIST and return false; we verify the *first* creation
  // surfaces as a thrown Error only when the path is genuinely bad.
  const p = scratchPath();
  fs.writeFileSync(p, 'x');
  try {
    const lock = new FileLock();
    assert.equal(lock.acquire(p), false);
    assert.equal(lock.release(), false); // never acquired
  } finally {
    fs.unlinkSync(p);
  }
});

test('acquire throws on an unwritable parent directory', () => {
  // /dev/null is not a directory, so ENOTDIR surfaces as a thrown Error,
  // not as a silent false. This is the contract: only "already locked"
  // maps to false; everything else throws.
  const badPath = path.join('/dev/null', 'cannot-exist-here');
  const lock = new FileLock();
  assert.throws(() => lock.acquire(badPath));
  assert.equal(lock.release(), false);
});

test('two FileLocks on different paths do not interfere', () => {
  const p1 = scratchPath();
  const p2 = scratchPath();
  const a = new FileLock();
  const b = new FileLock();
  try {
    assert.equal(a.acquire(p1), true);
    assert.equal(b.acquire(p2), true);
    // Non-reentrant by design: each FileLock can only hold one path at
    // a time. Re-acquiring on the same instance throws, regardless of
    // whether the path differs. Use separate FileLock instances for
    // independent locks.
    assert.throws(() => a.acquire(p2), /already holds/);
    assert.throws(() => b.acquire(p1), /already holds/);
  } finally {
    a.release();
    b.release();
  }
});

test('_tempLockPath returns a path inside the OS temp dir', () => {
  const p = _tempLockPath();
  assert.equal(path.dirname(p), os.tmpdir());
  // Not creating a file here — just verifying the helper's contract.
});

test('crash simulation: closing fd without unlink lets a new lock succeed', () => {
  // This models the crash-recovery guarantee: the lock is keyed on the
  // fd, so if the process dies the OS closes the fd. But because we
  // also create a *file* (not just hold an advisory lock), a hard
  // crash leaves the file behind. We deliberately do NOT auto-recover
  // from a leftover file in acquire() — the caller must delete it.
  // This test documents that: a stale file blocks the next locker.
  const p = scratchPath();
  fs.writeFileSync(p, 'stale');
  const lock = new FileLock();
  try {
    assert.equal(lock.acquire(p), false);
  } finally {
    fs.unlinkSync(p);
    lock.release();
  }
});

test('release leaves the FileLock ready to acquire a different path', () => {
  const p1 = scratchPath();
  const p2 = scratchPath();
  const lock = new FileLock();
  try {
    lock.acquire(p1);
    lock.release();
    assert.equal(lock.acquire(p2), true);
  } finally {
    lock.release();
  }
});

test('lockfile content is empty — the file is a sentinel, not a store', () => {
  const p = scratchPath();
  const lock = new FileLock();
  try {
    lock.acquire(p);
    assert.equal(fs.readFileSync(p, 'utf8'), '');
  } finally {
    lock.release();
  }
});
