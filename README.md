# file-lock-kit

A minimal, zero-dependency file lock for Node.js that uses `O_EXCL` creation so the lock is released automatically when the process exits, even on a crash.

```js
import { FileLock } from 'file-lock-kit';

const lock = new FileLock();
if (lock.acquire('/tmp/my-app.lock')) {
  try {
    // critical section
  } finally {
    lock.release();
  }
} else {
  // someone else holds it
}
```

## Why

The standard advisory-lock primitive (`flock`) is not exposed by Node's `fs` module, and reaching for it means pulling in a native addon. This library gets the same crash-safety property from `fs.open(path, 'wx')`: the `x` flag is `O_EXCL`, which fails if the file exists. The lock is therefore just a file whose existence means "held" and whose non-existence means "free". When the process dies — cleanly or via `SIGKILL` — the OS closes the file descriptor and a subsequent locker can re-create the file.

The trade-off: this is a *sentinel-file* lock, not a byte-range lock. It cannot be re-acquired by the same process while held, and it does not distinguish between processes. It is meant for the common case of "run one instance of this job at a time on this host".

## The awkward edge

If the holder process is killed, the lockfile is **left behind on disk**. A crash does not tidy up — it only frees the file descriptor. The next caller of `acquire()` will see the stale file and get `false`. This is deliberate: silently deleting a lockfile you did not create would race with a holder that is merely paused, not dead. If you need automatic recovery from stale locks, schedule a cleanup with a heartbeat and a TTL; that is a distributed-mutex problem, not a file problem.

`acquire()` returns `false` only for `EEXIST` (already locked). Every other failure — bad path, missing parent, permissions — throws. Check the return value; do not wrap `acquire` in `try/catch` expecting it to report "locked".
