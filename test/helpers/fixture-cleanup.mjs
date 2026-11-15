const stacks = new WeakMap();

// node:test after hooks run in registration order. Filesystem fixtures must
// release later-created processes and leases before removing their ancestry.
export function registerCleanup(t, cleanup) {
  let stack = stacks.get(t);
  if (!stack) {
    stack = [];
    stacks.set(t, stack);
    t.after(async () => {
      const errors = [];
      for (const release of stack.reverse()) {
        try { await release(); } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, 'Fixture cleanup failed');
    });
  }
  stack.push(cleanup);
}

export function cleanupChild(t, child) {
  // Subscribe immediately: cleanup must also handle an already-closed child.
  const closed = new Promise(resolve => child.once('close', resolve));
  registerCleanup(t, async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    child.stdin?.destroy();
    child.stdout?.resume();
    child.stderr?.resume();
    await closed;
  });
}
