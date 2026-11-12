#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <node_api.h>
#include <cmath>
#include <cstdint>
#include <exception>
#include <stdexcept>
#include <string>
#include <vector>
#include "security.h"
#include "process.h"
#include "filesystem.h"
#include "private-purge.h"

#ifndef HCC_SOURCE_SHA256
#error HCC_SOURCE_SHA256 must identify the source used for this build
#endif
#ifndef HCC_WINDOWS_PROTOCOL_VERSION
#error HCC_WINDOWS_PROTOCOL_VERSION must be supplied by the build script
#endif

namespace {
void Check(napi_status status) {
  if (status != napi_ok) throw std::runtime_error("Node-API operation failed");
}

napi_value String(napi_env env, const char* text) {
  napi_value value;
  Check(napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value));
  return value;
}

void Set(napi_env env, napi_value object, const char* name, napi_value value) {
  Check(napi_set_named_property(env, object, name, value));
}

napi_value Number(napi_env env, uint32_t value) {
  napi_value result;
  Check(napi_create_uint32(env, value, &result));
  return result;
}

napi_value Observation(napi_env env, const char* state, DWORD pid,
                       const char* reason = nullptr, DWORD error = ERROR_SUCCESS) {
  napi_value result;
  Check(napi_create_object(env, &result));
  Set(env, result, "state", String(env, state));
  napi_value pidValue;
  if (pid == 0) Check(napi_get_null(env, &pidValue));
  else pidValue = Number(env, pid);
  Set(env, result, "pid", pidValue);
  if (reason) Set(env, result, "reason", String(env, reason));
  if (error != ERROR_SUCCESS) Set(env, result, "win32Error", Number(env, error));
  return result;
}

class ProcessHandle {
 public:
  explicit ProcessHandle(HANDLE value) : value_(value) {}
  ~ProcessHandle() { if (value_) CloseHandle(value_); }
  ProcessHandle(const ProcessHandle&) = delete;
  ProcessHandle& operator=(const ProcessHandle&) = delete;
  HANDLE get() const { return value_; }
 private:
  HANDLE value_;
};

napi_value InspectProcess(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1;
    napi_value argument;
    Check(napi_get_cb_info(env, info, &argc, &argument, nullptr, nullptr));
    napi_valuetype type = napi_undefined;
    if (argc != 0) Check(napi_typeof(env, argument, &type));
    double value = 0;
    if (type == napi_number) Check(napi_get_value_double(env, argument, &value));
    if (type != napi_number || !std::isfinite(value) || value < 1 ||
        value > UINT32_MAX || std::floor(value) != value) {
      return Observation(env, "unknown", 0, "invalid_pid");
    }
    const DWORD pid = static_cast<DWORD>(value);
    // Keep one real handle for the entire observation. Reading times/image from
    // separate PID lookups would permit PID reuse to mix two process instances.
    ProcessHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
    if (!process.get()) {
      const DWORD error = GetLastError();
      return Observation(env, error == ERROR_INVALID_PARAMETER ? "dead" : "unknown", pid,
                         error == ERROR_INVALID_PARAMETER ? "process_missing" : "open_failed", error);
    }
    DWORD wait = WaitForSingleObject(process.get(), 0);
    if (wait == WAIT_OBJECT_0) return Observation(env, "dead", pid, "process_exited");
    if (wait != WAIT_TIMEOUT) return Observation(env, "unknown", pid, "wait_failed", GetLastError());

    FILETIME created, exited, kernel, user;
    if (!GetProcessTimes(process.get(), &created, &exited, &kernel, &user)) {
      return Observation(env, "unknown", pid, "times_failed", GetLastError());
    }
    std::vector<wchar_t> image(32768);
    DWORD length = static_cast<DWORD>(image.size());
    if (!QueryFullProcessImageNameW(process.get(), 0, image.data(), &length)) {
      return Observation(env, "unknown", pid, "image_failed", GetLastError());
    }
    wait = WaitForSingleObject(process.get(), 0);
    if (wait == WAIT_OBJECT_0) return Observation(env, "dead", pid, "process_exited");
    if (wait != WAIT_TIMEOUT) return Observation(env, "unknown", pid, "wait_failed", GetLastError());
    const uint64_t creationTime = (static_cast<uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
    if (creationTime == 0 || length == 0) return Observation(env, "unknown", pid, "identity_incomplete");
    napi_value result = Observation(env, "live", pid);
    Set(env, result, "creationTime", String(env, std::to_string(creationTime).c_str()));
    static_assert(sizeof(wchar_t) == sizeof(char16_t), "Windows paths must be UTF-16");
    napi_value imagePath;
    Check(napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(image.data()), length, &imagePath));
    Set(env, result, "imagePath", imagePath);
    return result;
  } catch (const std::exception& error) {
    napi_throw_error(env, "WINDOWS_NATIVE_ERROR", error.what());
    return nullptr;
  }
}

napi_value Initialize(napi_env env, napi_value exports) {
  try {
    Set(env, exports, "protocolVersion", Number(env, HCC_WINDOWS_PROTOCOL_VERSION));
    Set(env, exports, "sourceHash", String(env, HCC_SOURCE_SHA256));
    napi_value capabilities, enabled;
    Check(napi_create_object(env, &capabilities));
    Check(napi_get_boolean(env, true, &enabled));
    Set(env, capabilities, "processIdentity", enabled);
    Set(env, exports, "capabilities", capabilities);
    napi_value inspect;
    Check(napi_create_function(env, "inspectProcess", NAPI_AUTO_LENGTH, InspectProcess, nullptr, &inspect));
    Set(env, exports, "inspectProcess", inspect);
    RegisterSecurity(env, exports);
    RegisterProcess(env, exports);
    RegisterPrivatePurge(env, exports);
    return RegisterFilesystem(env, exports);
  } catch (const std::exception& error) {
    napi_throw_error(env, "WINDOWS_NATIVE_ERROR", error.what());
    return nullptr;
  }
}
}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
