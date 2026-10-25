// Only bounded numeric fields cross the synchronous worker boundary. Never
// copy a listener error's message, path, address, or arbitrary properties.
export const SOCKET_LOCK_STATE_LENGTH = 6;
const CODE_INDEX = 2;
const ERRNO_INDEX = 3;
const SYSCALL_INDEX = 4;
const PORT_INDEX = 5;
const CODES = Object.freeze([null, 'EACCES', 'EPERM', 'EMFILE', 'ENFILE', 'ENOBUFS',
  'ENOMEM', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EINVAL', 'ENOTSOCK', 'EBADF', 'EADDRINUSE']);
const SYSCALLS = Object.freeze([null, 'listen', 'bind', 'accept', 'close']);

export function writeSocketLockFailure(state, error, port) {
  if (state.length < SOCKET_LOCK_STATE_LENGTH) return;
  Atomics.store(state, CODE_INDEX, Math.max(0, CODES.indexOf(error?.code)));
  const errno = error?.errno;
  Atomics.store(state, ERRNO_INDEX, Number.isInteger(errno) && Math.abs(errno) <= 65535 ? errno : 0);
  Atomics.store(state, SYSCALL_INDEX, Math.max(0, SYSCALLS.indexOf(error?.syscall)));
  Atomics.store(state, PORT_INDEX, Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0);
}

export function readSocketLockFailure(state) {
  if (state.length < SOCKET_LOCK_STATE_LENGTH) return null;
  const port = Atomics.load(state, PORT_INDEX);
  if (port < 1 || port > 65535) return null;
  return {
    cause: { code: CODES[Atomics.load(state, CODE_INDEX)] ?? null,
      errno: Atomics.load(state, ERRNO_INDEX) || null,
      syscall: SYSCALLS[Atomics.load(state, SYSCALL_INDEX)] ?? null },
    endpoint: { host: '127.0.0.1', port }
  };
}
