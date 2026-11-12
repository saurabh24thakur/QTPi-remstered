const tails = new WeakMap();

/** Acquire the serialized execution slot for an agent's mutable conversation. */
export async function acquireAgentLock(agent) {
  if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) {
    throw new TypeError('acquireAgentLock requires an agent object');
  }

  const previous = tails.get(agent) || Promise.resolve();
  let unlock;
  const gate = new Promise((resolve) => { unlock = resolve; });
  const tail = previous.then(() => gate);
  tails.set(agent, tail);
  await previous;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    unlock();
  };
}
