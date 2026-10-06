/*
 * One-shot, authenticated directory-descriptor handoff for tmux panes.
 *
 * Build this helper for each supported OS/architecture before packaging. It
 * is never compiled on an end-user's machine. The broker receives an already
 * validated directory as fd 3 from its Node parent. A tmux pane starts the
 * client without a user-selected pathname; only after the parent authorizes
 * the exact pane PID does the broker transfer that fd with SCM_RIGHTS.
 */
#define _GNU_SOURCE
#define _DARWIN_C_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#if !defined(__APPLE__) && !defined(__linux__)
#error "hcc-cwd-handoff supports macOS and Linux only"
#endif

#define HANDOFF_TIMEOUT_MS 20000
#define AUTH_WINDOW_MS 5000
#define REQUEST_TIMEOUT_MS 2000
#define RETRY_INTERVAL_MS 50
#define MAX_CLIENTS 64
#define LINE_CAP 256
#define NONCE_HEX_LENGTH 64

#ifndef HCC_SOURCE_SHA256
#error "Build with scripts/build-cwd-handoff.mjs to embed source provenance"
#endif

static const char build_id[] = "HCC_SOURCE_SHA256:" HCC_SOURCE_SHA256;
static struct sigaction previous_sigpipe;

typedef struct {
  const char *socket_path;
  const char *nonce;
  dev_t dev;
  ino_t ino;
  int dir_fd;
  char **exec_argv;
} options_t;

static bool socket_bound;
static char socket_basename[sizeof(((struct sockaddr_un *)0)->sun_path)];
static dev_t socket_dev;
static ino_t socket_ino;

static void diagnostic(const char *reason) {
  fprintf(stderr, "HCC_CWD_HANDOFF:%s\n", reason);
}

static int error_exit(const char *reason) {
  diagnostic(reason);
  return 42;
}

static int64_t monotonic_ms(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return -1;
  return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static int64_t deadline_after(int duration_ms) {
  int64_t now = monotonic_ms();
  return now < 0 ? -1 : now + duration_ms;
}

static int remaining_ms(int64_t deadline) {
  int64_t now = monotonic_ms();
  if (now < 0 || now >= deadline) return 0;
  int64_t remaining = deadline - now;
  return remaining > INT_MAX ? INT_MAX : (int)remaining;
}

static bool wait_fd(int fd, short events, int64_t deadline) {
  struct pollfd pfd = { .fd = fd, .events = events, .revents = 0 };
  while (remaining_ms(deadline) > 0) {
    int rc = poll(&pfd, 1, remaining_ms(deadline));
    if (rc > 0) return (pfd.revents & (events | POLLHUP | POLLERR)) != 0;
    if (rc == 0) return false;
    if (errno != EINTR) return false;
  }
  return false;
}

static bool write_all(int fd, const char *data, size_t size, int64_t deadline) {
  size_t written = 0;
  while (written < size) {
    if (!wait_fd(fd, POLLOUT, deadline)) return false;
    ssize_t count = write(fd, data + written, size - written);
    if (count > 0) { written += (size_t)count; continue; }
    if (count < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    return false;
  }
  return true;
}

static bool read_line(int fd, char *buffer, size_t capacity, int64_t deadline) {
  size_t length = 0;
  while (length + 1 < capacity) {
    if (!wait_fd(fd, POLLIN, deadline)) return false;
    char byte;
    ssize_t count = read(fd, &byte, 1);
    if (count == 0) return false;
    if (count < 0) {
      if (errno == EINTR || errno == EAGAIN) continue;
      return false;
    }
    if (byte == '\n') { buffer[length] = '\0'; return true; }
    if ((unsigned char)byte < 0x20 || (unsigned char)byte > 0x7e) return false;
    buffer[length++] = byte;
  }
  return false;
}

static bool set_cloexec(int fd) {
  int flags = fcntl(fd, F_GETFD);
  return flags >= 0 && fcntl(fd, F_SETFD, flags | FD_CLOEXEC) == 0;
}

static bool set_nonblock(int fd) {
  int flags = fcntl(fd, F_GETFL);
  return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

static bool parse_uint(const char *value, uintmax_t limit, uintmax_t *result) {
  if (!value || !*value) return false;
  uintmax_t parsed = 0;
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    if (*p < '0' || *p > '9') return false;
    unsigned digit = (unsigned)(*p - '0');
    if (parsed > (limit - digit) / 10) return false;
    parsed = parsed * 10 + digit;
  }
  *result = parsed;
  return true;
}

static bool parse_nonce(const char *value) {
  if (!value || strlen(value) != NONCE_HEX_LENGTH) return false;
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    if (!((*p >= '0' && *p <= '9') || (*p >= 'a' && *p <= 'f'))) return false;
  }
  return true;
}

/* Some platforms expose dev_t as signed and Node may render the same raw
 * device ID as either a negative signed value or a positive bit pattern. */
static bool parse_device(const char *value, dev_t *result) {
  if (!value || !*value) return false;
  if (value[0] == '-') {
    if (!value[1]) return false;
    for (const unsigned char *p = (const unsigned char *)value + 1; *p; p++) {
      if (*p < '0' || *p > '9') return false;
    }
    char *end;
    errno = 0;
    intmax_t parsed = strtoimax(value, &end, 10);
    if (errno != 0 || *end != '\0') return false;
    *result = (dev_t)parsed;
    return (intmax_t)*result == parsed;
  }
  uintmax_t parsed;
  if (!parse_uint(value, UINTMAX_MAX, &parsed)) return false;
  uintmax_t mask = UINTMAX_MAX;
  if (sizeof(dev_t) < sizeof(uintmax_t)) {
    mask >>= (sizeof(uintmax_t) - sizeof(dev_t)) * CHAR_BIT;
  }
  if (parsed > mask) return false;
  *result = (dev_t)parsed;
  return ((uintmax_t)*result & mask) == parsed;
}

static bool parse_options(int argc, char **argv, bool broker, options_t *out) {
  memset(out, 0, sizeof(*out));
  out->dir_fd = -1;
  bool seen_socket = false, seen_dev = false, seen_ino = false;
  bool seen_fd = false, seen_nonce = false;
  int i = 2;
  for (; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) { i++; break; }
    if (i + 1 >= argc) return false;
    const char *flag = argv[i++], *value = argv[i];
    uintmax_t parsed;
    if (strcmp(flag, "--socket") == 0 && !seen_socket) {
      out->socket_path = value; seen_socket = true;
    } else if (strcmp(flag, "--dev") == 0 && !seen_dev &&
               parse_device(value, &out->dev)) {
      seen_dev = true;
    } else if (strcmp(flag, "--ino") == 0 && !seen_ino &&
               parse_uint(value, UINTMAX_MAX, &parsed)) {
      out->ino = (ino_t)parsed;
      if ((uintmax_t)out->ino != parsed) return false;
      seen_ino = true;
    } else if (strcmp(flag, "--dir-fd") == 0 && broker && !seen_fd &&
               parse_uint(value, INT_MAX, &parsed)) {
      out->dir_fd = (int)parsed; seen_fd = true;
    } else if (strcmp(flag, "--nonce") == 0 && !seen_nonce && parse_nonce(value)) {
      out->nonce = value; seen_nonce = true;
    } else return false;
  }
  if (!seen_socket || !seen_dev || !seen_ino || !seen_nonce ||
      (broker && (!seen_fd || i != argc)) || (!broker && (seen_fd || i >= argc))) return false;
  if (!out->socket_path || out->socket_path[0] != '/') return false;
  if (!broker) {
    if (argv[i][0] == '\0') return false;
    out->exec_argv = argv + i;
  }
  return true;
}

static bool same_directory(const struct stat *st, const options_t *options) {
  return S_ISDIR(st->st_mode) && st->st_dev == options->dev && st->st_ino == options->ino;
}

/* The AF_UNIX name lives only in a private, user-owned, non-symlink directory.
 * The broker pins that directory with fchdir before binding the basename. */
static bool socket_parent(const char *socket_path, char *basename, size_t basename_cap,
                          int *parent_fd) {
  size_t length = strlen(socket_path);
  if (length == 0 || length >= sizeof(((struct sockaddr_un *)0)->sun_path)) return false;
  const char *slash = strrchr(socket_path, '/');
  if (!slash || !slash[1] || strcmp(slash + 1, ".") == 0 ||
      strcmp(slash + 1, "..") == 0 || strlen(slash + 1) >= basename_cap) return false;
  size_t parent_length = (size_t)(slash - socket_path);
  char *parent = malloc(parent_length + 2);
  if (!parent) return false;
  if (parent_length == 0) { parent[0] = '/'; parent[1] = '\0'; }
  else { memcpy(parent, socket_path, parent_length); parent[parent_length] = '\0'; }
  int fd = open(parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  free(parent);
  if (fd < 0) return false;
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISDIR(st.st_mode) || st.st_uid != geteuid() ||
      (st.st_mode & 0077) != 0) { close(fd); return false; }
  strcpy(basename, slash + 1);
  *parent_fd = fd;
  return true;
}

static bool socket_address(const char *path, struct sockaddr_un *address,
                           socklen_t *address_len) {
  size_t length = strlen(path);
  if (length == 0 || length >= sizeof(address->sun_path)) return false;
  memset(address, 0, sizeof(*address));
  address->sun_family = AF_UNIX;
  memcpy(address->sun_path, path, length + 1);
  *address_len = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + length + 1);
#ifdef __APPLE__
  address->sun_len = (uint8_t)*address_len;
#endif
  return true;
}

static void cleanup_socket(void) {
  if (!socket_bound) return;
  struct stat st;
  if (lstat(socket_basename, &st) == 0 && S_ISSOCK(st.st_mode) &&
      st.st_dev == socket_dev && st.st_ino == socket_ino) {
    unlink(socket_basename);
  }
  socket_bound = false;
}

static bool receipt_names(const char *basename, char *final, size_t final_cap,
                          char *temporary, size_t temporary_cap) {
  int final_length = snprintf(final, final_cap, "%s.bound", basename);
  int temporary_length = snprintf(temporary, temporary_cap, "%s.bound.tmp", basename);
  return final_length > 0 && (size_t)final_length < final_cap &&
         temporary_length > 0 && (size_t)temporary_length < temporary_cap;
}

static bool name_absent(const char *name) {
  struct stat st;
  return lstat(name, &st) != 0 && errno == ENOENT;
}

/* Publish only after an authenticated client has acknowledged fchdir. The
 * final pathname is never visible with partial content. It is left for the
 * parent to validate and remove after synchronous launch admission. */
static bool publish_bound_receipt(int parent_fd, const char *basename,
                                  const char *nonce) {
  char final[sizeof(((struct sockaddr_un *)0)->sun_path) + 16];
  char temporary[sizeof(((struct sockaddr_un *)0)->sun_path) + 16];
  if (!receipt_names(basename, final, sizeof(final), temporary,
                     sizeof(temporary)) || !name_absent(final)) return false;
  int fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return false;
  struct stat created = { 0 }, current;
  bool created_valid = fstat(fd, &created) == 0;
  bool renamed = false, success = false;
  if (!created_valid || !S_ISREG(created.st_mode) ||
      created.st_uid != geteuid() || created.st_nlink != 1 ||
      (created.st_mode & 0777) != 0600) goto done;
  char payload[NONCE_HEX_LENGTH + 2];
  memcpy(payload, nonce, NONCE_HEX_LENGTH);
  payload[NONCE_HEX_LENGTH] = '\n';
  size_t written = 0;
  while (written < NONCE_HEX_LENGTH + 1) {
    ssize_t count = write(fd, payload + written, NONCE_HEX_LENGTH + 1 - written);
    if (count > 0) { written += (size_t)count; continue; }
    if (count < 0 && errno == EINTR) continue;
    goto done;
  }
  if (fsync(fd) != 0) goto done;
  if (close(fd) != 0) { fd = -1; goto done; }
  fd = -1;
  if (!name_absent(final) || rename(temporary, final) != 0) goto done;
  renamed = true;
  if (lstat(final, &current) != 0 || !S_ISREG(current.st_mode) ||
      current.st_dev != created.st_dev || current.st_ino != created.st_ino ||
      current.st_uid != geteuid() || current.st_nlink != 1 ||
      (current.st_mode & 0777) != 0600 || fsync(parent_fd) != 0) goto done;
  success = true;

done:
  if (fd >= 0) close(fd);
  const char *cleanup = renamed ? final : temporary;
  if (!success && created_valid && lstat(cleanup, &current) == 0 &&
      current.st_dev == created.st_dev && current.st_ino == created.st_ino) {
    unlink(cleanup);
  }
  return success;
}

static bool peer_identity(int fd, pid_t *pid, uid_t *uid) {
#ifdef __linux__
  struct ucred credentials;
  socklen_t size = sizeof(credentials);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &size) != 0 ||
      size != sizeof(credentials)) return false;
  *pid = credentials.pid;
  *uid = credentials.uid;
#else
  socklen_t size = sizeof(*pid);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, pid, &size) != 0 ||
      size != sizeof(*pid)) return false;
  gid_t group;
  if (getpeereid(fd, uid, &group) != 0) return false;
#endif
  return *pid > 0;
}

static bool send_directory_fd(int socket_fd, int dir_fd, int64_t deadline) {
  char marker = 'F';
  struct iovec iov = { .iov_base = &marker, .iov_len = 1 };
  union { struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(int))]; } ancillary;
  memset(&ancillary, 0, sizeof(ancillary));
  struct msghdr message = { 0 };
  message.msg_iov = &iov;
  message.msg_iovlen = 1;
  message.msg_control = ancillary.bytes;
  message.msg_controllen = sizeof(ancillary.bytes);
  struct cmsghdr *control = CMSG_FIRSTHDR(&message);
  if (!control) return false;
  control->cmsg_level = SOL_SOCKET;
  control->cmsg_type = SCM_RIGHTS;
  control->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(control), &dir_fd, sizeof(dir_fd));
  while (wait_fd(socket_fd, POLLOUT, deadline)) {
    ssize_t count = sendmsg(socket_fd, &message, 0);
    if (count == 1) return true;
    if (count < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    return false;
  }
  return false;
}

static int receive_directory_fd(int socket_fd, int64_t deadline) {
  char marker = '\0';
  struct iovec iov = { .iov_base = &marker, .iov_len = 1 };
  union { struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(int) * 8)]; } ancillary;
  memset(&ancillary, 0, sizeof(ancillary));
  struct msghdr message = { 0 };
  message.msg_iov = &iov;
  message.msg_iovlen = 1;
  message.msg_control = ancillary.bytes;
  while (wait_fd(socket_fd, POLLIN, deadline)) {
    message.msg_controllen = sizeof(ancillary.bytes);
    message.msg_flags = 0;
    ssize_t count = recvmsg(socket_fd, &message, 0);
    if (count < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (count < 0) return -1;
    int received = -1, total = 0;
    bool unexpected_control = false;
    for (struct cmsghdr *control = CMSG_FIRSTHDR(&message); control;
         control = CMSG_NXTHDR(&message, control)) {
      if (control->cmsg_level != SOL_SOCKET || control->cmsg_type != SCM_RIGHTS ||
          control->cmsg_len < CMSG_LEN(0)) {
        unexpected_control = true;
        continue;
      }
      size_t bytes = control->cmsg_len - CMSG_LEN(0);
      if (bytes % sizeof(int) != 0) unexpected_control = true;
      size_t count_fds = bytes / sizeof(int);
      int *fds = (int *)CMSG_DATA(control);
      for (size_t i = 0; i < count_fds; i++) {
        if (total++ == 0) received = fds[i];
        else close(fds[i]);
      }
    }
    if (count != 1 || marker != 'F' ||
        (message.msg_flags & (MSG_CTRUNC | MSG_TRUNC)) ||
        unexpected_control || total != 1) {
      if (received >= 0) close(received);
      return -1;
    }
    if (!set_cloexec(received)) { close(received); return -1; }
    return received;
  }
  return -1;
}

static bool parse_allow(const char *line, const char *nonce, pid_t *pid) {
  if (strncmp(line, "ALLOW ", 6) != 0) return false;
  const char *space = strchr(line + 6, ' ');
  if (!space || strcmp(space + 1, nonce) != 0) return false;
  size_t digits = (size_t)(space - (line + 6));
  if (digits == 0 || digits >= 24) return false;
  char number[24];
  memcpy(number, line + 6, digits);
  number[digits] = '\0';
  uintmax_t parsed;
  if (!parse_uint(number, INT_MAX, &parsed) || parsed == 0) return false;
  *pid = (pid_t)parsed;
  return (uintmax_t)*pid == parsed;
}

static int broker(const options_t *options) {
  struct stat dir_stat;
  if (options->dir_fd != 3 || fstat(options->dir_fd, &dir_stat) != 0 ||
      !same_directory(&dir_stat, options) || !set_cloexec(options->dir_fd)) {
    return error_exit("BROKER_DIRECTORY_INVALID");
  }

  int parent_fd = -1, listener = -1, rc = 42;
  if (!socket_parent(options->socket_path, socket_basename,
                     sizeof(socket_basename), &parent_fd)) {
    return error_exit("SOCKET_PARENT_INVALID");
  }
  if (fchdir(parent_fd) != 0) { close(parent_fd); return error_exit("SOCKET_PARENT_CHANGED"); }
  struct stat current_parent, original_parent;
  if (fstat(parent_fd, &original_parent) != 0 || stat(".", &current_parent) != 0 ||
      original_parent.st_dev != current_parent.st_dev ||
      original_parent.st_ino != current_parent.st_ino) {
    close(parent_fd);
    return error_exit("SOCKET_PARENT_CHANGED");
  }
  struct stat existing;
  char receipt_final[sizeof(((struct sockaddr_un *)0)->sun_path) + 16];
  char receipt_temporary[sizeof(((struct sockaddr_un *)0)->sun_path) + 16];
  if (!receipt_names(socket_basename, receipt_final, sizeof(receipt_final),
                     receipt_temporary, sizeof(receipt_temporary)) ||
      !name_absent(socket_basename) || !name_absent(receipt_final) ||
      !name_absent(receipt_temporary)) {
    rc = error_exit("SOCKET_EXISTS"); goto done;
  }

  struct sockaddr_un address;
  socklen_t address_len;
  if (!socket_address(socket_basename, &address, &address_len)) {
    rc = error_exit("SOCKET_PATH_INVALID"); goto done;
  }
  listener = socket(AF_UNIX, SOCK_STREAM, 0);
  if (listener < 0 || !set_cloexec(listener) || !set_nonblock(listener)) {
    rc = error_exit("BROKER_SOCKET_FAILED"); goto done;
  }
  umask(0077);
  if (bind(listener, (struct sockaddr *)&address, address_len) != 0) {
    rc = error_exit("BROKER_BIND_FAILED"); goto done;
  }
  if (lstat(socket_basename, &existing) != 0 || !S_ISSOCK(existing.st_mode) ||
      existing.st_uid != geteuid()) {
    rc = error_exit("BROKER_BIND_FAILED"); goto done;
  }
  socket_dev = existing.st_dev;
  socket_ino = existing.st_ino;
  socket_bound = true;
  if (chmod(socket_basename, 0600) != 0 ||
      lstat(socket_basename, &existing) != 0 || !S_ISSOCK(existing.st_mode) ||
      existing.st_dev != socket_dev || existing.st_ino != socket_ino ||
      existing.st_uid != geteuid() || (existing.st_mode & 0077) != 0) {
    rc = error_exit("BROKER_BIND_FAILED"); goto done;
  }
  if (listen(listener, 4) != 0) { rc = error_exit("BROKER_LISTEN_FAILED"); goto done; }
  if (!write_all(STDOUT_FILENO, "READY\n", 6, deadline_after(REQUEST_TIMEOUT_MS))) {
    rc = error_exit("BROKER_READY_FAILED"); goto done;
  }

  char line[LINE_CAP];
  pid_t expected_pid;
  if (!read_line(STDIN_FILENO, line, sizeof(line), deadline_after(HANDOFF_TIMEOUT_MS)) ||
      !parse_allow(line, options->nonce, &expected_pid)) {
    rc = error_exit("BROKER_ALLOW_INVALID"); goto done;
  }

  int64_t deadline = deadline_after(AUTH_WINDOW_MS);
  int attempts = 0;
  while (remaining_ms(deadline) > 0 && attempts++ < MAX_CLIENTS) {
    if (!wait_fd(listener, POLLIN, deadline)) break;
    int peer = accept(listener, NULL, NULL);
    if (peer < 0) { if (errno == EINTR || errno == EAGAIN) continue; break; }
    if (!set_cloexec(peer) || !set_nonblock(peer)) { close(peer); continue; }
    pid_t actual_pid;
    uid_t actual_uid;
    if (!peer_identity(peer, &actual_pid, &actual_uid) ||
        actual_pid != expected_pid || actual_uid != geteuid()) {
      close(peer);
      continue;
    }
    int64_t request_deadline = deadline_after(REQUEST_TIMEOUT_MS);
    if (!read_line(peer, line, sizeof(line), request_deadline)) {
      close(peer); rc = error_exit("CLIENT_HELLO_FAILED"); goto done;
    }
    char expected_hello[LINE_CAP];
    snprintf(expected_hello, sizeof(expected_hello), "HELLO %s", options->nonce);
    if (strcmp(line, expected_hello) != 0) {
      close(peer); rc = error_exit("CLIENT_NONCE_INVALID"); goto done;
    }
    if (!send_directory_fd(peer, options->dir_fd, request_deadline)) {
      close(peer); rc = error_exit("FD_TRANSFER_FAILED"); goto done;
    }
    if (!read_line(peer, line, sizeof(line), deadline)) {
      close(peer); rc = error_exit("CLIENT_BIND_UNCONFIRMED"); goto done;
    }
    char expected_bound[LINE_CAP];
    snprintf(expected_bound, sizeof(expected_bound), "BOUND %s", options->nonce);
    bool bound = strcmp(line, expected_bound) == 0;
    close(peer);
    if (!bound) { rc = error_exit("CLIENT_BIND_UNCONFIRMED"); goto done; }
    if (!publish_bound_receipt(parent_fd, socket_basename, options->nonce)) {
      rc = error_exit("BROKER_BOUND_RECEIPT_FAILED"); goto done;
    }
    if (!write_all(STDOUT_FILENO, "BOUND\n", 6, deadline_after(REQUEST_TIMEOUT_MS))) {
      rc = error_exit("BROKER_BOUND_FAILED"); goto done;
    }
    rc = 0;
    goto done;
  }
  rc = error_exit("BROKER_CLIENT_TIMEOUT");

done:
  if (listener >= 0) close(listener);
  cleanup_socket();
  if (parent_fd >= 0) close(parent_fd);
  return rc;
}

static int connect_client(const char *socket_path, int64_t deadline) {
  struct sockaddr_un address;
  socklen_t address_len;
  if (strlen(socket_path) >= sizeof(address.sun_path)) return -1;
  char basename[sizeof(address.sun_path)];
  int parent_fd = -1;
  if (!socket_parent(socket_path, basename, sizeof(basename), &parent_fd)) return -1;
  struct stat parent, current;
  if (fstat(parent_fd, &parent) != 0 || fchdir(parent_fd) != 0 ||
      stat(".", &current) != 0 || parent.st_dev != current.st_dev ||
      parent.st_ino != current.st_ino ||
      !socket_address(basename, &address, &address_len)) {
    close(parent_fd);
    return -1;
  }
  while (remaining_ms(deadline) > 0) {
    struct stat st;
    if (fstatat(parent_fd, basename, &st, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno != ENOENT) break;
    } else if (!S_ISSOCK(st.st_mode) || st.st_uid != geteuid() ||
               (st.st_mode & 0077) != 0) break;
    else {
      int fd = socket(AF_UNIX, SOCK_STREAM, 0);
      if (fd < 0) break;
      if (!set_cloexec(fd) || !set_nonblock(fd)) { close(fd); break; }
      if (connect(fd, (struct sockaddr *)&address, address_len) == 0) {
        close(parent_fd); return fd;
      }
      int cause = errno;
      if (cause == EINPROGRESS || cause == EAGAIN) {
        if (wait_fd(fd, POLLOUT, deadline)) {
          socklen_t size = sizeof(cause);
          if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &cause, &size) == 0 && cause == 0) {
            close(parent_fd); return fd;
          }
        } else cause = ETIMEDOUT;
      }
      close(fd);
      if (cause != ENOENT && cause != ECONNREFUSED && cause != EAGAIN) break;
    }
    struct timespec pause = { .tv_sec = 0, .tv_nsec = RETRY_INTERVAL_MS * 1000000L };
    nanosleep(&pause, NULL);
  }
  close(parent_fd);
  return -1;
}

static char *current_cwd(void) {
  size_t capacity = 256;
  while (capacity <= 1024 * 1024) {
    char *buffer = malloc(capacity);
    if (!buffer) return NULL;
    if (getcwd(buffer, capacity)) return buffer;
    int cause = errno;
    free(buffer);
    if (cause != ERANGE) return NULL;
    capacity *= 2;
  }
  return NULL;
}

static int client(const options_t *options) {
  int fd = connect_client(options->socket_path, deadline_after(HANDOFF_TIMEOUT_MS));
  if (fd < 0) return error_exit("CLIENT_CONNECT_FAILED");
  pid_t broker_pid;
  uid_t broker_uid;
  if (!peer_identity(fd, &broker_pid, &broker_uid) || broker_uid != geteuid()) {
    close(fd); return error_exit("BROKER_IDENTITY_INVALID");
  }
  char hello[LINE_CAP];
  int size = snprintf(hello, sizeof(hello), "HELLO %s\n", options->nonce);
  if (size < 0 || (size_t)size >= sizeof(hello) ||
      !write_all(fd, hello, (size_t)size, deadline_after(REQUEST_TIMEOUT_MS))) {
    close(fd); return error_exit("CLIENT_HELLO_FAILED");
  }
  int directory_fd = receive_directory_fd(fd, deadline_after(HANDOFF_TIMEOUT_MS));
  if (directory_fd < 0) { close(fd); return error_exit("FD_RECEIVE_FAILED"); }
  struct stat received, current;
  if (fstat(directory_fd, &received) != 0 || !same_directory(&received, options) ||
      fchdir(directory_fd) != 0 || stat(".", &current) != 0 ||
      !same_directory(&current, options)) {
    close(directory_fd); close(fd); return error_exit("CLIENT_DIRECTORY_CHANGED");
  }
  char *cwd = current_cwd();
  if (!cwd || setenv("PWD", cwd, 1) != 0) {
    free(cwd); close(directory_fd); close(fd);
    return error_exit("CLIENT_CWD_UNAVAILABLE");
  }
  free(cwd);
  char bound[LINE_CAP];
  size = snprintf(bound, sizeof(bound), "BOUND %s\n", options->nonce);
  if (size < 0 || (size_t)size >= sizeof(bound) ||
      !write_all(fd, bound, (size_t)size, deadline_after(REQUEST_TIMEOUT_MS))) {
    close(directory_fd); close(fd); return error_exit("CLIENT_BOUND_FAILED");
  }
  close(fd);
  /* Retain directory_fd, marked CLOEXEC, until the successful exec. */
  if (sigaction(SIGPIPE, &previous_sigpipe, NULL) != 0) {
    close(directory_fd);
    return error_exit("CLIENT_SIGNAL_RESTORE_FAILED");
  }
  execvp(options->exec_argv[0], options->exec_argv);
  int cause = errno;
  close(directory_fd);
  fprintf(stderr, "HCC_CWD_HANDOFF:CLIENT_EXEC_FAILED:%d\n", cause);
  return 127;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--build-id") == 0) {
    puts(build_id);
    return 0;
  }
  if (argc < 3 || (strcmp(argv[1], "broker") != 0 && strcmp(argv[1], "client") != 0)) {
    diagnostic("USAGE"); return 64;
  }
  bool is_broker = strcmp(argv[1], "broker") == 0;
  options_t options;
  if (!parse_options(argc, argv, is_broker, &options)) {
    diagnostic("USAGE"); return 64;
  }
  struct sigaction ignore_sigpipe = { .sa_handler = SIG_IGN };
  sigemptyset(&ignore_sigpipe.sa_mask);
  if (sigaction(SIGPIPE, &ignore_sigpipe, &previous_sigpipe) != 0) {
    return error_exit("SIGNAL_SETUP_FAILED");
  }
  return is_broker ? broker(&options) : client(&options);
}
