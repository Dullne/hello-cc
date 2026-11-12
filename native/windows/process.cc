#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <node_api.h>
#include <algorithm>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
#include "process.h"
#include "filesystem.h"

namespace {
constexpr size_t kTransferBytes = 64 * 1024;
constexpr size_t kQueueBytes = 1024 * 1024;
const napi_type_tag kControllerTag{0x40ae97bf8d724938ULL, 0x9a8b465605319ae1ULL};

class Failure : public std::runtime_error {
 public:
  explicit Failure(const char* message, DWORD error = ERROR_INVALID_PARAMETER)
      : std::runtime_error(message), error(error) {}
  DWORD error;
};
void Check(napi_status status) { if (status != napi_ok) throw Failure("Node-API process operation failed"); }
void WinCheck(BOOL ok, const char* message) { if (!ok) throw Failure(message, GetLastError()); }
napi_value Undefined(napi_env env) { napi_value value; Check(napi_get_undefined(env, &value)); return value; }
napi_value Number(napi_env env, uint32_t n) { napi_value value; Check(napi_create_uint32(env, n, &value)); return value; }
napi_value Boolean(napi_env env, bool n) { napi_value value; Check(napi_get_boolean(env, n, &value)); return value; }
napi_value String(napi_env env, const std::string& text) {
  napi_value value; Check(napi_create_string_utf8(env, text.data(), text.size(), &value)); return value;
}
napi_value String(napi_env env, const std::wstring& text) {
  napi_value value; Check(napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(text.data()), text.size(), &value)); return value;
}
void Set(napi_env env, napi_value object, const char* key, napi_value value) {
  Check(napi_set_named_property(env, object, key, value));
}
napi_value Throw(napi_env env, const std::exception& error) {
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (pending) return nullptr;
  napi_value result, code, message;
  const auto* failure = dynamic_cast<const Failure*>(&error);
  if (napi_create_string_utf8(env, "WINDOWS_PROCESS_ERROR", NAPI_AUTO_LENGTH, &code) == napi_ok &&
      napi_create_string_utf8(env, error.what(), NAPI_AUTO_LENGTH, &message) == napi_ok &&
      napi_create_error(env, code, message, &result) == napi_ok) {
    napi_value nativeError;
    if (failure && napi_create_uint32(env, failure->error, &nativeError) == napi_ok) {
      napi_set_named_property(env, result, "win32Error", nativeError);
    }
    napi_throw(env, result);
  }
  return nullptr;
}

class Handle {
 public:
  Handle() = default;
  explicit Handle(HANDLE value) : value_(value) {}
  ~Handle() { reset(); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value_(other.release()) {}
  Handle& operator=(Handle&& other) noexcept { if (this != &other) reset(other.release()); return *this; }
  HANDLE get() const { return value_; }
  HANDLE release() { HANDLE value = value_; value_ = nullptr; return value; }
  void reset(HANDLE value = nullptr) {
    if (value_ && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_);
    value_ = value;
  }
 private:
  HANDLE value_ = nullptr;
};

std::wstring Wide(napi_env env, napi_value value) {
  napi_valuetype type; Check(napi_typeof(env, value, &type));
  if (type != napi_string) throw Failure("Process options must contain literal strings");
  size_t length; Check(napi_get_value_string_utf16(env, value, nullptr, 0, &length));
  if (length > 32767) throw Failure("Process string exceeds the Windows length limit");
  std::vector<char16_t> buffer(length + 1);
  Check(napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &length));
  if (std::find(buffer.begin(), buffer.begin() + length, u'\0') != buffer.begin() + length) {
    throw Failure("Process strings must not contain NUL");
  }
  return std::wstring(reinterpret_cast<const wchar_t*>(buffer.data()), length);
}
napi_value Property(napi_env env, napi_value object, const char* key) {
  napi_value value; Check(napi_get_named_property(env, object, key, &value)); return value;
}
bool Absolute(const std::wstring& value) {
  return value.size() >= 3 && ((value[1] == L':' && (value[2] == L'\\' || value[2] == L'/')) ||
    (value[0] == L'\\' && value[1] == L'\\'));
}
std::wstring Quote(const std::wstring& value) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (wchar_t character : value) {
    if (character == L'\\') { slashes++; continue; }
    result.append(character == L'"' ? slashes * 2 + 1 : slashes, L'\\');
    result.push_back(character);
    slashes = 0;
  }
  result.append(slashes * 2, L'\\');
  result.push_back(L'"');
  return result;
}

std::vector<wchar_t> Environment(napi_env env, napi_value object) {
  napi_valuetype type; Check(napi_typeof(env, object, &type));
  bool array = false; Check(napi_is_array(env, object, &array));
  napi_value null; Check(napi_get_null(env, &null)); bool isNull = false;
  Check(napi_strict_equals(env, object, null, &isNull));
  if (type != napi_object || array || isNull) throw Failure("Process environment must be a string map");
  napi_value names;
  Check(napi_get_all_property_names(env, object, napi_key_own_only, napi_key_enumerable,
    napi_key_numbers_to_strings, &names));
  uint32_t count; Check(napi_get_array_length(env, names, &count));
  if (count > 16384) throw Failure("Process environment has too many entries");
  std::vector<std::pair<std::wstring, std::wstring>> entries;
  size_t total = 1;
  for (uint32_t i = 0; i < count; i++) {
    napi_value key; Check(napi_get_element(env, names, i, &key));
    std::wstring name = Wide(env, key);
    if (name.empty() || name.find(L'=') != std::wstring::npos) throw Failure("Invalid Windows environment name");
    napi_value raw; Check(napi_get_property(env, object, key, &raw));
    std::wstring value = Wide(env, raw);
    total += name.size() + value.size() + 2;
    if (total > 1024 * 1024) throw Failure("Process environment exceeds its size limit");
    entries.emplace_back(std::move(name), std::move(value));
  }
  auto compare = [](const std::wstring& left, const std::wstring& right) {
    return CompareStringOrdinal(left.data(), static_cast<int>(left.size()),
      right.data(), static_cast<int>(right.size()), TRUE);
  };
  std::sort(entries.begin(), entries.end(), [&](const auto& left, const auto& right) {
    return compare(left.first, right.first) == CSTR_LESS_THAN;
  });
  std::vector<wchar_t> result;
  for (size_t i = 0; i < entries.size(); i++) {
    if (i > 0 && compare(entries[i - 1].first, entries[i].first) == CSTR_EQUAL) {
      throw Failure("Duplicate case-insensitive Windows environment name");
    }
    result.insert(result.end(), entries[i].first.begin(), entries[i].first.end());
    result.push_back(L'=');
    result.insert(result.end(), entries[i].second.begin(), entries[i].second.end());
    result.push_back(L'\0');
  }
  if (result.empty()) result.push_back(L'\0');
  result.push_back(L'\0');
  return result;
}

struct Writer {
  Handle pipe;
  std::mutex mutex;
  std::condition_variable changed;
  std::deque<std::vector<uint8_t>> queue;
  size_t pending = 0;
  bool closing = false, stopping = false, closed = false;
  DWORD error = ERROR_SUCCESS;
};

DWORD WINAPI WriteThread(void* data) {
  std::unique_ptr<std::shared_ptr<Writer>> argument(static_cast<std::shared_ptr<Writer>*>(data));
  const auto writer = *argument;
  argument.reset();
  try {
    while (true) {
      std::vector<uint8_t> bytes;
      {
        std::unique_lock<std::mutex> lock(writer->mutex);
        writer->changed.wait(lock, [&] { return writer->stopping || writer->closing || !writer->queue.empty(); });
        if (writer->stopping || (writer->queue.empty() && writer->closing)) break;
        bytes = std::move(writer->queue.front()); writer->queue.pop_front();
      }
      size_t offset = 0;
      while (offset < bytes.size()) {
        { std::lock_guard<std::mutex> lock(writer->mutex); if (writer->stopping) break; }
        DWORD written = 0;
        const BOOL ok = WriteFile(writer->pipe.get(), bytes.data() + offset,
          static_cast<DWORD>(bytes.size() - offset), &written, nullptr);
        if (!ok || written == 0) {
          const DWORD error = ok ? ERROR_BROKEN_PIPE : GetLastError();
          std::lock_guard<std::mutex> lock(writer->mutex);
          writer->error = error; writer->stopping = true; break;
        }
        offset += written;
        std::lock_guard<std::mutex> lock(writer->mutex); writer->pending -= written;
      }
    }
  } catch (...) {
    std::lock_guard<std::mutex> lock(writer->mutex); writer->error = ERROR_NOT_ENOUGH_MEMORY;
  }
  writer->pipe.reset();
  {
    std::lock_guard<std::mutex> lock(writer->mutex);
    writer->pending = 0; writer->queue.clear(); writer->closed = true;
  }
  return 0;
}

struct PtyControl {
  HPCON console = nullptr;
  std::mutex mutex;
  std::condition_variable changed;
  COORD size{};
  bool resize = false, closing = false, closed = false;
  HRESULT error = S_OK;
  ~PtyControl() { if (console) ClosePseudoConsole(console); }
};

DWORD WINAPI PtyThread(void* raw) {
  std::unique_ptr<std::shared_ptr<PtyControl>> owner(static_cast<std::shared_ptr<PtyControl>*>(raw));
  const auto state = *owner;
  for (;;) {
    COORD size{};
    bool closing;
    {
      std::unique_lock<std::mutex> lock(state->mutex);
      state->changed.wait(lock, [&] { return state->closing || state->resize; });
      closing = state->closing; size = state->size; state->resize = false;
    }
    if (closing) {
      // Windows versions before 11 24H2 may block while final output drains.
      // The JavaScript poller keeps reading on its independent thread.
      ClosePseudoConsole(state->console);
      std::lock_guard<std::mutex> lock(state->mutex);
      state->console = nullptr; state->closed = true;
      return 0;
    }
    const HRESULT result = ResizePseudoConsole(state->console, size);
    if (FAILED(result)) { std::lock_guard<std::mutex> lock(state->mutex); state->error = result; }
  }
}

SHORT Dimension(napi_env env, napi_value value) {
  double number; Check(napi_get_value_double(env, value, &number));
  if (!std::isfinite(number) || std::floor(number) != number || number < 1 || number > 32767) {
    throw Failure("Terminal dimensions must be integers from 1 through 32767");
  }
  return static_cast<SHORT>(number);
}

struct Controller {
  Handle job, process, primaryThread, output, errors, writerThread, ptyThread;
  std::shared_ptr<Writer> writer = std::make_shared<Writer>();
  std::shared_ptr<WindowsProcessDirectoryLease> directoryLease;
  std::shared_ptr<WindowsProcessAppendLease> appendLease;
  std::shared_ptr<PtyControl> pty;
  DWORD pid = 0;
  uint64_t creationTime = 0;
  std::wstring imagePath;
  bool assigned = false, closed = false, suspended = true, serviceHost = false, detached = false;
  ~Controller() { Close(); }
  void Close() {
    if (closed) return;
    closed = true;
    // The Job handle is never inherited. Closing its final owned handle kills
    // remaining descendants, including a reader that is blocking stdin writes.
    if (assigned && job.get()) TerminateJobObject(job.get(), 1);
    else if (process.get() && !detached) TerminateProcess(process.get(), 127);
    job.reset();
    {
      std::lock_guard<std::mutex> lock(writer->mutex); writer->stopping = true;
    }
    writer->changed.notify_one();
    if (writerThread.get()) CancelSynchronousIo(writerThread.get());
    // The worker owns its Writer state until it exits. No JS thread joins a
    // blocking pipe writer or frees memory that a pending WriteFile still uses.
    writerThread.reset();
    output.reset(); errors.reset(); primaryThread.reset(); process.reset();
    EndPty(); ptyThread.reset();
    directoryLease.reset();
    appendLease.reset();
  }
  void EndPty() {
    if (!pty) return;
    { std::lock_guard<std::mutex> lock(pty->mutex); pty->closing = true; }
    pty->changed.notify_one();
  }
  void Resume() {
    if (closed) throw Failure("The owned process is closed");
    if (!suspended) return;
    if (directoryLease) directoryLease->assertUnchanged();
    if (appendLease) appendLease->assertUnchanged();
    if (ResumeThread(primaryThread.get()) == static_cast<DWORD>(-1)) throw Failure("Cannot resume owned process", GetLastError());
    suspended = false;
    primaryThread.reset();
  }
};

void Finalize(napi_env, void* data, void*) { delete static_cast<Controller*>(data); }

template <typename Function>
napi_value Method(napi_env env, napi_callback_info info, size_t minimum, size_t maximum, Function fn) {
  try {
    size_t argc = 0; napi_value args[2], self;
    Check(napi_get_cb_info(env, info, &argc, nullptr, &self, nullptr));
    if (argc < minimum || argc > maximum) throw Failure("Unexpected owned process argument count");
    if (argc) Check(napi_get_cb_info(env, info, &argc, args, &self, nullptr));
    bool tagged = false;
    Check(napi_check_object_type_tag(env, self, &kControllerTag, &tagged));
    if (!tagged) throw Failure("Invalid owned process receiver");
    Controller* controller = nullptr;
    Check(napi_unwrap(env, self, reinterpret_cast<void**>(&controller)));
    if (!controller) throw Failure("Invalid owned process receiver");
    return fn(*controller, argc, args);
  } catch (const std::exception& error) { return Throw(env, error); }
}

napi_value Poll(napi_env env, napi_callback_info info) {
  return Method(env, info, 0, 0, [&](Controller& controller, size_t, napi_value*) {
    napi_value result; Check(napi_create_object(env, &result));
    Set(env, result, "closed", Boolean(env, controller.closed));
    Set(env, result, "suspended", Boolean(env, controller.suspended));
    if (controller.closed) return result;
    const DWORD wait = WaitForSingleObject(controller.process.get(), 0);
    if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) throw Failure("Process wait failed", GetLastError());
    Set(env, result, "exited", Boolean(env, wait == WAIT_OBJECT_0));
    if (wait == WAIT_OBJECT_0) {
      DWORD code; WinCheck(GetExitCodeProcess(controller.process.get(), &code), "Cannot read process exit code");
      Set(env, result, "exitCode", Number(env, code));
    }
    DWORD active = wait == WAIT_OBJECT_0 ? 0 : 1;
    if (controller.job.get()) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      WinCheck(QueryInformationJobObject(controller.job.get(), JobObjectBasicAccountingInformation,
        &accounting, sizeof(accounting), nullptr), "Cannot observe owned process tree");
      active = accounting.ActiveProcesses;
    }
    Set(env, result, "activeProcesses", Number(env, active));
    std::lock_guard<std::mutex> lock(controller.writer->mutex);
    Set(env, result, "pendingBytes", Number(env, static_cast<uint32_t>(controller.writer->pending)));
    Set(env, result, "stdinClosed", Boolean(env, controller.writer->closed));
    Set(env, result, "stdinError", Number(env, controller.writer->error));
    if (controller.pty) {
      std::lock_guard<std::mutex> ptyLock(controller.pty->mutex);
      Set(env, result, "ptyClosed", Boolean(env, controller.pty->closed));
      Set(env, result, "ptyError", Number(env, static_cast<uint32_t>(controller.pty->error)));
      Set(env, result, "resizePending", Boolean(env, controller.pty->resize));
    }
    return result;
  });
}

napi_value Read(napi_env env, napi_callback_info info, bool stderrStream) {
  return Method(env, info, 0, 1, [&](Controller& controller, size_t argc, napi_value* args) {
    size_t limit = kTransferBytes;
    if (argc > 0) {
      double number; Check(napi_get_value_double(env, args[0], &number));
      if (!std::isfinite(number) || number < 1 || number > kTransferBytes || std::floor(number) != number) {
        throw Failure("Process read limit must be 1..65536 bytes");
      }
      limit = static_cast<size_t>(number);
    }
    Handle& pipe = stderrStream ? controller.errors : controller.output;
    napi_value result;
    if (!pipe.get()) { Check(napi_get_null(env, &result)); return result; }
    DWORD available = 0;
    if (!PeekNamedPipe(pipe.get(), nullptr, 0, nullptr, &available, nullptr)) {
      const DWORD error = GetLastError();
      if (error != ERROR_BROKEN_PIPE && error != ERROR_PIPE_NOT_CONNECTED) throw Failure("Process output inspection failed", error);
      pipe.reset(); Check(napi_get_null(env, &result)); return result;
    }
    const DWORD length = static_cast<DWORD>(std::min<size_t>(available, limit));
    std::vector<uint8_t> bytes(length);
    DWORD read = 0;
    if (length) WinCheck(ReadFile(pipe.get(), bytes.data(), length, &read, nullptr), "Process output read failed");
    Check(napi_create_buffer_copy(env, read, bytes.data(), nullptr, &result));
    return result;
  });
}
napi_value ReadStdout(napi_env env, napi_callback_info info) { return Read(env, info, false); }
napi_value ReadStderr(napi_env env, napi_callback_info info) { return Read(env, info, true); }

napi_value Write(napi_env env, napi_callback_info info) {
  return Method(env, info, 1, 1, [&](Controller& controller, size_t argc, napi_value* args) {
    bool buffer = false; if (argc) Check(napi_is_buffer(env, args[0], &buffer));
    if (!buffer) throw Failure("Process stdin writes require a Buffer");
    void* bytes; size_t length; Check(napi_get_buffer_info(env, args[0], &bytes, &length));
    if (length > kTransferBytes) throw Failure("Process stdin transfer exceeds 65536 bytes");
    auto writer = controller.writer;
    std::lock_guard<std::mutex> lock(writer->mutex);
    if (controller.closed || writer->closing || writer->closed || writer->stopping) throw Failure("Process stdin is closed", ERROR_BROKEN_PIPE);
    if (writer->pending + length > kQueueBytes) return Boolean(env, false);
    if (length) {
      const auto* start = static_cast<const uint8_t*>(bytes);
      writer->queue.emplace_back(start, start + length); writer->pending += length;
      writer->changed.notify_one();
    }
    return Boolean(env, true);
  });
}
napi_value CloseStdin(napi_env env, napi_callback_info info) {
  return Method(env, info, 0, 0, [&](Controller& controller, size_t, napi_value*) {
    std::lock_guard<std::mutex> lock(controller.writer->mutex);
    controller.writer->closing = true; controller.writer->changed.notify_one();
    return Undefined(env);
  });
}
napi_value Terminate(napi_env env, napi_callback_info info) {
  return Method(env, info, 0, 0, [&](Controller& controller, size_t, napi_value*) {
    if (!controller.closed) {
      if (controller.serviceHost) {
        // This capability owns the retained handle created for this exact HCC
        // service root. Its service-owned provider Jobs close when it exits.
        if (WaitForSingleObject(controller.process.get(), 0) != WAIT_OBJECT_0) {
          WinCheck(TerminateProcess(controller.process.get(), 1), "Owned service termination failed");
        }
      } else WinCheck(TerminateJobObject(controller.job.get(), 1), "Owned process tree termination failed");
    }
    return Undefined(env);
  });
}
napi_value Close(napi_env env, napi_callback_info info) {
  return Method(env, info, 0, 0, [&](Controller& controller, size_t, napi_value*) { controller.Close(); return Undefined(env); });
}
napi_value Resume(napi_env env, napi_callback_info info) {
  return Method(env, info, 0, 0, [&](Controller& controller, size_t, napi_value*) { controller.Resume(); return Undefined(env); });
}

napi_value Detach(napi_env env, napi_callback_info info) {
  return Method(env, info, 0, 0, [&](Controller& controller, size_t, napi_value*) {
    if (!controller.serviceHost || controller.closed || controller.suspended) {
      throw Failure("Only a running service host can be detached");
    }
    if (WaitForSingleObject(controller.process.get(), 0) != WAIT_TIMEOUT) {
      throw Failure("The service host exited before handoff");
    }
    controller.detached = true;
    controller.Close();
    return Undefined(env);
  });
}

napi_value EndPty(napi_env env, napi_callback_info info) {
  return Method(env, info, 0, 0, [&](Controller& controller, size_t, napi_value*) {
    if (!controller.pty) throw Failure("This process has no pseudoconsole");
    controller.EndPty(); return Undefined(env);
  });
}

napi_value Resize(napi_env env, napi_callback_info info) {
  return Method(env, info, 2, 2, [&](Controller& controller, size_t, napi_value* args) {
    const COORD size{Dimension(env, args[0]), Dimension(env, args[1])};
    if (!controller.pty || controller.closed) throw Failure("This process has no open pseudoconsole");
    {
      std::lock_guard<std::mutex> lock(controller.pty->mutex);
      // A valid resize racing terminal shutdown is already satisfied: no
      // future screen remains to resize. Preserve the terminal exit receipt.
      if (controller.pty->closing) return Undefined(env);
      controller.pty->size = size; controller.pty->resize = true;
    }
    controller.pty->changed.notify_one(); return Undefined(env);
  });
}

void Pipe(Handle& read, Handle& write, bool childReads) {
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE reader = nullptr, writer = nullptr;
  WinCheck(CreatePipe(&reader, &writer, &attributes, static_cast<DWORD>(kTransferBytes)), "Cannot create process stdio pipe");
  read.reset(reader); write.reset(writer);
  WinCheck(SetHandleInformation(childReads ? writer : reader, HANDLE_FLAG_INHERIT, 0), "Cannot restrict process stdio inheritance");
}

napi_value StartProcess(napi_env env, napi_callback_info info, bool serviceHost, bool terminal = false) {
  try {
    size_t argc = 0; napi_value args[1];
    Check(napi_get_cb_info(env, info, &argc, nullptr, nullptr, nullptr));
    if (argc != 1) throw Failure("Exactly one owned process options object is required");
    Check(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    napi_valuetype optionsType; Check(napi_typeof(env, args[0], &optionsType));
    bool optionsArray; Check(napi_is_array(env, args[0], &optionsArray));
    if (optionsType != napi_object || optionsArray) throw Failure("Owned process options must be an object");
    napi_value names; Check(napi_get_all_property_names(env, args[0], napi_key_own_only,
      napi_key_all_properties, napi_key_numbers_to_strings, &names));
    uint32_t optionCount; Check(napi_get_array_length(env, names, &optionCount));
    for (uint32_t i = 0; i < optionCount; i++) {
      napi_value name; Check(napi_get_element(env, names, i, &name));
      const auto key = Wide(env, name);
      if (key != L"file" && key != L"args" && key != L"cwd" && key != L"env" && key != L"lease" && key != L"suspended" &&
          !(serviceHost && key == L"log") && !(terminal && (key == L"cols" || key == L"rows"))) {
        throw Failure("Unknown owned process option");
      }
    }
    for (const char* required : {"file", "args", "cwd", "env"}) {
      bool own = false;
      Check(napi_has_own_property(env, args[0], String(env, required), &own));
      if (!own) throw Failure("Missing required owned process option");
    }
    const std::wstring file = Wide(env, Property(env, args[0], "file"));
    const std::wstring cwd = Wide(env, Property(env, args[0], "cwd"));
    if (!Absolute(file) || !Absolute(cwd)) throw Failure("Owned process executable and cwd must be absolute");
    bool extraHandles = false;
    Check(napi_has_named_property(env, args[0], "inheritHandles", &extraHandles));
    if (extraHandles) throw Failure("Arbitrary process handle inheritance is unsupported");
    napi_value arguments = Property(env, args[0], "args");
    bool array; Check(napi_is_array(env, arguments, &array));
    if (!array) throw Failure("Owned process arguments must be an array");
    uint32_t count; Check(napi_get_array_length(env, arguments, &count));
    if (count > 16384) throw Failure("Too many process arguments");
    std::wstring command = Quote(file);
    for (uint32_t i = 0; i < count; i++) {
      napi_value argument; Check(napi_get_element(env, arguments, i, &argument));
      command += L" " + Quote(Wide(env, argument));
      if (command.size() >= 32767) throw Failure("Process command line exceeds the Windows limit");
    }
    auto environment = Environment(env, Property(env, args[0], "env"));
    auto controller = std::make_unique<Controller>();
    controller->serviceHost = serviceHost;
    bool hasLease = false, hasSuspended = false, keepSuspended = false;
    Check(napi_has_named_property(env, args[0], "lease", &hasLease));
    Check(napi_has_named_property(env, args[0], "suspended", &hasSuspended));
    if (serviceHost && !hasLease) throw Failure("Service hosts require an opaque selected-directory lease");
    if (terminal && !hasLease) throw Failure("Pseudoconsole processes require an opaque selected-directory lease");
    if (hasSuspended) Check(napi_get_value_bool(env, Property(env, args[0], "suspended"), &keepSuspended));
    if (serviceHost && hasSuspended) throw Failure("Detached service roots must start runnable");
    std::vector<Handle> inheritedPins;
    if (hasLease) {
      controller->directoryLease = WindowsRetainDirectoryForProcess(env, Property(env, args[0], "lease"));
      const auto selected = WindowsPathArgument(env, Property(env, args[0], "cwd"));
      const auto& canonical = controller->directoryLease->canonical();
      if (CompareStringOrdinal(selected.data(), static_cast<int>(selected.size()),
          canonical.data(), static_cast<int>(canonical.size()), TRUE) != CSTR_EQUAL) {
        throw Failure("Selected process cwd does not match its directory lease");
      }
      for (HANDLE pin : controller->directoryLease->handles()) {
        HANDLE duplicate = nullptr;
        WinCheck(DuplicateHandle(GetCurrentProcess(), pin, GetCurrentProcess(), &duplicate,
          0, TRUE, DUPLICATE_SAME_ACCESS), "Cannot inherit selected directory pins");
        inheritedPins.emplace_back(duplicate);
      }
      controller->directoryLease->assertUnchanged();
    }
    bool hasLog = false;
    Check(napi_has_named_property(env, args[0], "log", &hasLog));
    if (hasLog) {
      if (!serviceHost) throw Failure("Only service hosts can inherit an append resource");
      controller->appendLease = WindowsRetainAppendForProcess(env, Property(env, args[0], "log"));
      for (HANDLE pin : controller->appendLease->handles()) {
        HANDLE duplicate = nullptr;
        WinCheck(DuplicateHandle(GetCurrentProcess(), pin, GetCurrentProcess(), &duplicate,
          0, TRUE, DUPLICATE_SAME_ACCESS), "Cannot inherit service log protection");
        inheritedPins.emplace_back(duplicate);
      }
      controller->appendLease->assertUnchanged();
    }
    if (!serviceHost) {
      controller->job.reset(CreateJobObjectW(nullptr, nullptr));
      WinCheck(controller->job.get() != nullptr, "Cannot create owned process Job");
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      WinCheck(SetInformationJobObject(controller->job.get(), JobObjectExtendedLimitInformation,
        &limits, sizeof(limits)), "Cannot configure owned process Job");
    }
    Handle inputChild, outputChild, errorChild;
    if (serviceHost) {
      SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
      inputChild.reset(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
        &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
      outputChild.reset(CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
        &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
      errorChild.reset(CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
        &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
      if (inputChild.get() == INVALID_HANDLE_VALUE || outputChild.get() == INVALID_HANDLE_VALUE ||
          errorChild.get() == INVALID_HANDLE_VALUE) throw Failure("Cannot create service stdio handles", GetLastError());
      if (controller->appendLease) {
        HANDLE output = nullptr, errors = nullptr;
        WinCheck(DuplicateHandle(GetCurrentProcess(), controller->appendLease->file(), GetCurrentProcess(),
          &output, 0, TRUE, DUPLICATE_SAME_ACCESS), "Cannot inherit service output");
        outputChild.reset(output);
        WinCheck(DuplicateHandle(GetCurrentProcess(), controller->appendLease->file(), GetCurrentProcess(),
          &errors, 0, TRUE, DUPLICATE_SAME_ACCESS), "Cannot inherit service diagnostics");
        errorChild.reset(errors);
      }
      controller->writer->closed = true;
    } else if (terminal) {
      const COORD size{Dimension(env, Property(env, args[0], "cols")), Dimension(env, Property(env, args[0], "rows"))};
      Pipe(inputChild, controller->writer->pipe, true);
      Pipe(controller->output, outputChild, false);
      controller->pty = std::make_shared<PtyControl>();
      const HRESULT result = CreatePseudoConsole(size, inputChild.get(), outputChild.get(), 0, &controller->pty->console);
      if (FAILED(result)) throw Failure("Cannot create Windows pseudoconsole", static_cast<DWORD>(result));
      auto threadData = std::make_unique<std::shared_ptr<PtyControl>>(controller->pty);
      controller->ptyThread.reset(CreateThread(nullptr, 0, PtyThread, threadData.get(), 0, nullptr));
      WinCheck(controller->ptyThread.get() != nullptr, "Cannot start pseudoconsole control worker");
      threadData.release();
    } else {
      Pipe(inputChild, controller->writer->pipe, true);
      Pipe(controller->output, outputChild, false);
      Pipe(controller->errors, errorChild, false);
    }
    SIZE_T attributeSize = 0;
    const DWORD attributeCount = serviceHost ? 1 : terminal ? 3 : 2;
    InitializeProcThreadAttributeList(nullptr, attributeCount, 0, &attributeSize);
    std::vector<uint8_t> attributeStorage(attributeSize);
    auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeStorage.data());
    WinCheck(InitializeProcThreadAttributeList(attributes, attributeCount, 0, &attributeSize), "Cannot allocate process handle list");
    struct AttributeCleanup {
      LPPROC_THREAD_ATTRIBUTE_LIST value;
      ~AttributeCleanup() { DeleteProcThreadAttributeList(value); }
    } attributeCleanup{attributes};
    std::vector<HANDLE> inherited;
    if (!terminal) inherited = {inputChild.get(), outputChild.get(), errorChild.get()};
    for (const auto& pin : inheritedPins) inherited.push_back(pin.get());
    WinCheck(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
      inherited.data(), inherited.size() * sizeof(HANDLE), nullptr, nullptr), "Cannot restrict inherited process handles");
    if (!serviceHost) {
      HANDLE jobs[] = {controller->job.get()};
      WinCheck(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
        jobs, sizeof(jobs), nullptr, nullptr), "Cannot associate the owned Job during process creation");
    }
    if (terminal) WinCheck(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
      controller->pty->console, sizeof(HPCON), nullptr, nullptr), "Cannot attach Windows pseudoconsole");
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    startup.StartupInfo.wShowWindow = SW_HIDE;
    if (!terminal) {
      startup.StartupInfo.hStdInput = inputChild.get();
      startup.StartupInfo.hStdOutput = outputChild.get();
      startup.StartupInfo.hStdError = errorChild.get();
    }
    startup.lpAttributeList = attributes;
    PROCESS_INFORMATION information{};
    const DWORD creationFlags = (terminal ? 0 : CREATE_NO_WINDOW) | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT |
      (serviceHost ? 0 : CREATE_SUSPENDED);
    WinCheck(CreateProcessW(file.c_str(), command.data(), nullptr, nullptr, TRUE, creationFlags,
      environment.data(), cwd.c_str(), &startup.StartupInfo, &information), "Owned process creation failed");
    controller->process.reset(information.hProcess);
    controller->primaryThread.reset(information.hThread);
    controller->pid = information.dwProcessId;
    if (serviceHost) {
      // The inherited pins protect the cwd before any HCC code can execute.
      // Without an outer Job, runnable creation also avoids an unresumable
      // orphan if this launcher dies immediately after CreateProcess returns.
      controller->suspended = false;
      controller->primaryThread.reset();
    }
    // The kernel applies JOB_LIST during creation, eliminating a suspended
    // orphan window if the host dies between creation and an assignment call.
    if (!serviceHost) {
      controller->assigned = true;
      BOOL inJob = FALSE;
      WinCheck(IsProcessInJob(controller->process.get(), controller->job.get(), &inJob), "Cannot verify owned process Job");
      if (!inJob) throw Failure("Created process did not enter its owned Job");
    }
    FILETIME created, exited, kernel, user;
    WinCheck(GetProcessTimes(controller->process.get(), &created, &exited, &kernel, &user), "Cannot read owned process creation time");
    controller->creationTime = (static_cast<uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
    std::vector<wchar_t> image(32768);
    DWORD imageLength = static_cast<DWORD>(image.size());
    WinCheck(QueryFullProcessImageNameW(controller->process.get(), 0, image.data(), &imageLength), "Cannot read owned process executable identity");
    if (imageLength == 0) throw Failure("Owned process executable identity is empty");
    controller->imagePath.assign(image.data(), imageLength);
    inputChild.reset(); outputChild.reset(); errorChild.reset();
    inheritedPins.clear();
    if (!serviceHost) {
      auto threadData = std::make_unique<std::shared_ptr<Writer>>(controller->writer);
      controller->writerThread.reset(CreateThread(nullptr, 0, WriteThread, threadData.get(), 0, nullptr));
      WinCheck(controller->writerThread.get() != nullptr, "Cannot start bounded process stdin writer");
      threadData.release();
    }
    if (!keepSuspended) controller->Resume();
    napi_value result; Check(napi_create_object(env, &result));
    napi_property_descriptor properties[] = {
      {"poll", nullptr, Poll, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readStdout", nullptr, ReadStdout, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readStderr", nullptr, ReadStderr, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"writeStdin", nullptr, Write, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"closeStdin", nullptr, CloseStdin, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"terminate", nullptr, Terminate, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"resume", nullptr, Resume, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"detach", nullptr, Detach, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"endPty", nullptr, EndPty, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"resize", nullptr, Resize, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"pid", nullptr, nullptr, nullptr, nullptr, Number(env, controller->pid), napi_enumerable, nullptr},
      {"creationTime", nullptr, nullptr, nullptr, nullptr, String(env, std::to_string(controller->creationTime)), napi_enumerable, nullptr},
      {"imagePath", nullptr, nullptr, nullptr, nullptr, String(env, controller->imagePath), napi_enumerable, nullptr}
    };
    Check(napi_define_properties(env, result, sizeof(properties) / sizeof(properties[0]), properties));
    Check(napi_type_tag_object(env, result, &kControllerTag));
    Check(napi_wrap(env, result, controller.get(), Finalize, nullptr, nullptr));
    controller.release();
    return result;
  } catch (const std::exception& error) { return Throw(env, error); }
}
napi_value Start(napi_env env, napi_callback_info info) { return StartProcess(env, info, false); }
napi_value StartDetachedHost(napi_env env, napi_callback_info info) { return StartProcess(env, info, true); }
napi_value StartOwnedPty(napi_env env, napi_callback_info info) { return StartProcess(env, info, false, true); }
}  // namespace

napi_value RegisterProcess(napi_env env, napi_value exports) {
  try {
    napi_value start; Check(napi_create_function(env, "startOwnedProcess", NAPI_AUTO_LENGTH, Start, nullptr, &start));
    Set(env, exports, "startOwnedProcess", start);
    Check(napi_create_function(env, "startDetachedHost", NAPI_AUTO_LENGTH, StartDetachedHost, nullptr, &start));
    Set(env, exports, "startDetachedHost", start);
    Check(napi_create_function(env, "startOwnedPty", NAPI_AUTO_LENGTH, StartOwnedPty, nullptr, &start));
    Set(env, exports, "startOwnedPty", start);
    return exports;
  } catch (const std::exception& error) { return Throw(env, error); }
}
