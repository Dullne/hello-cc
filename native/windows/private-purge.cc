#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winternl.h>
#include <bcrypt.h>
#include <algorithm>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
#include "private-purge.h"
#include "filesystem.h"
#include "security.h"

namespace {
struct Failure : std::runtime_error {
  const char* code; DWORD win32;
  Failure(const char* code, const char* text, DWORD win32 = 0) : std::runtime_error(text), code(code), win32(win32) {}
};
void Check(napi_status status) { if (status != napi_ok) throw Failure("WINDOWS_NATIVE_ERROR", "Native purge value is unavailable."); }
[[noreturn]] void Invalid() { throw Failure("BAD_ARGS", "Private purge requires a pinned parent, one ordinary child name and an exact Windows directory identity."); }
class Handle {
 public:
  explicit Handle(HANDLE value = INVALID_HANDLE_VALUE) : value(value) {}
  ~Handle() { close(); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value(std::exchange(other.value, INVALID_HANDLE_VALUE)) {}
  Handle& operator=(Handle&& other) noexcept { close(); value = std::exchange(other.value, INVALID_HANDLE_VALUE); return *this; }
  void close() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = INVALID_HANDLE_VALUE; }
  HANDLE value;
};
struct Identity {
  uint64_t volume; unsigned char id[16]; int64_t created;
  bool operator==(const Identity& other) const { return volume == other.volume && created == other.created && std::equal(std::begin(id), std::end(id), std::begin(other.id)); }
};
struct Facts { Identity identity; bool directory; };

Facts Inspect(napi_env env, HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO attributes{}; FILE_STANDARD_INFO standard{}; FILE_ID_INFO id{}; FILE_BASIC_INFO basic{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &attributes, sizeof(attributes)) ||
      !GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard)) ||
      !GetFileInformationByHandleEx(handle, FileIdInfo, &id, sizeof(id)) ||
      !GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic))) {
    throw Failure("PROJECT_PATH_FORBIDDEN", "Private purge cannot identify a filesystem object.", GetLastError());
  }
  if (GetFileType(handle) != FILE_TYPE_DISK || standard.DeletePending || (!standard.Directory && standard.NumberOfLinks != 1) ||
      (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || basic.CreationTime.QuadPart <= 0) {
    throw Failure("PROJECT_PATH_FORBIDDEN", "Private purge refuses reparse points, hard links and unstable objects.");
  }
  if (std::all_of(std::begin(id.FileId.Identifier), std::end(id.FileId.Identifier), [](unsigned char byte) { return byte == 0; })) {
    throw Failure("PROJECT_PATH_FORBIDDEN", "Private purge object identity is unavailable.");
  }
  if (standard.Directory) {
    FILE_CASE_SENSITIVE_INFO sensitive{};
    if (!GetFileInformationByHandleEx(handle, FileCaseSensitiveInfo, &sensitive, sizeof(sensitive)) || sensitive.Flags != 0) {
      throw Failure("PROJECT_PATH_FORBIDDEN", "Private purge requires ordinary case-insensitive directories.");
    }
  }
  const napi_value security = WindowsSecurityForHandle(env, handle);
  bool pending = false; Check(napi_is_exception_pending(env, &pending));
  if (pending || !security) throw Failure("PROJECT_PATH_FORBIDDEN", "Private purge cannot validate object permissions.");
  napi_value safe; bool privateObject = false;
  Check(napi_get_named_property(env, security, "private", &safe)); Check(napi_get_value_bool(env, safe, &privateObject));
  if (!privateObject) throw Failure("PROJECT_PATH_FORBIDDEN", "Private purge requires current-user private permissions on every object.");
  Facts facts{}; facts.identity.volume = id.VolumeSerialNumber; facts.identity.created = basic.CreationTime.QuadPart;
  std::copy(std::begin(id.FileId.Identifier), std::end(id.FileId.Identifier), std::begin(facts.identity.id)); facts.directory = standard.Directory != FALSE;
  return facts;
}

std::wstring ChildName(napi_env env, napi_value value) {
  napi_valuetype type; Check(napi_typeof(env, value, &type)); if (type != napi_string) Invalid();
  size_t length = 0; Check(napi_get_value_string_utf16(env, value, nullptr, 0, &length)); if (!length || length > 255) Invalid();
  std::vector<char16_t> data(length + 1); Check(napi_get_value_string_utf16(env, value, data.data(), data.size(), &length));
  std::wstring name(reinterpret_cast<wchar_t*>(data.data()), length);
  if (name.find_first_of(L"\\/:") != std::wstring::npos) Invalid();
  // Reuse the exact common component rules instead of interpreting DOS names.
  const std::wstring synthetic = L"C:\\" + name;
  napi_value text; Check(napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(synthetic.data()), synthetic.size(), &text));
  try { WindowsPathArgument(env, text); } catch (const std::exception&) { Invalid(); }
  return name;
}

bool Matches(napi_env env, napi_value expected, const Identity& actual) {
  napi_valuetype type; Check(napi_typeof(env, expected, &type)); if (type != napi_object) Invalid();
  napi_value keys; Check(napi_get_all_property_names(env, expected, napi_key_own_only, napi_key_all_properties, napi_key_numbers_to_strings, &keys));
  uint32_t count = 0; Check(napi_get_array_length(env, keys, &count)); if (count != 5) Invalid();
  std::string id; constexpr char digits[] = "0123456789abcdef";
  for (unsigned char byte : actual.id) { id.push_back(digits[byte >> 4]); id.push_back(digits[byte & 15]); }
  const std::pair<const char*, std::string> fields[] = {{"platform", "win32"}, {"volumeSerial", std::to_string(actual.volume)},
    {"fileId", id}, {"creationTime", std::to_string(actual.created)}};
  for (const auto& field : fields) {
    napi_value value, expectedValue; Check(napi_get_named_property(env, expected, field.first, &value));
    Check(napi_create_string_utf8(env, field.second.data(), field.second.size(), &expectedValue));
    bool same = false; Check(napi_strict_equals(env, value, expectedValue, &same)); if (!same) return false;
  }
  napi_value version, one; Check(napi_get_named_property(env, expected, "version", &version)); Check(napi_create_uint32(env, 1, &one));
  bool same = false; Check(napi_strict_equals(env, version, one, &same)); return same;
}

Handle Open(HANDLE parent, const std::wstring& name, ACCESS_MASK access, ULONG disposition = 1,
            ULONG options = 0, PSECURITY_DESCRIPTOR security = nullptr) {
  using OpenFunction = NTSTATUS(NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
  using ErrorFunction = ULONG(WINAPI*)(NTSTATUS);
  const auto module = GetModuleHandleW(L"ntdll.dll");
  const auto open = reinterpret_cast<OpenFunction>(GetProcAddress(module, "NtCreateFile"));
  const auto error = reinterpret_cast<ErrorFunction>(GetProcAddress(module, "RtlNtStatusToDosError"));
  if (!open || !error) throw Failure("WINDOWS_NATIVE_UNAVAILABLE", "Relative private purge operations are unavailable.");
  UNICODE_STRING text{}; text.Buffer = const_cast<wchar_t*>(name.data()); text.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t)); text.MaximumLength = text.Length;
  OBJECT_ATTRIBUTES object{}; object.Length = sizeof(object); object.RootDirectory = parent; object.ObjectName = &text;
  object.Attributes = OBJ_CASE_INSENSITIVE; object.SecurityDescriptor = security;
  IO_STATUS_BLOCK io{}; HANDLE raw = INVALID_HANDLE_VALUE;
  const auto status = open(&raw, access | SYNCHRONIZE, &object, &io, nullptr, 0,
    FILE_SHARE_READ | FILE_SHARE_WRITE, disposition, options | 0x00200000 | 0x20, nullptr, 0);
  if (status < 0) throw Failure("PROJECT_PATH_FORBIDDEN", "Private purge could not exclusively bind an object.", error(status));
  return Handle(raw);
}

std::wstring PinName() {
  unsigned char bytes[16]{}; if (BCryptGenRandom(nullptr, bytes, sizeof(bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) {
    throw Failure("WINDOWS_NATIVE_UNAVAILABLE", "Private purge cannot generate a directory pin.");
  }
  std::wstring name = L".hcc-purge-pin-"; constexpr wchar_t digits[] = L"0123456789abcdef";
  for (auto byte : bytes) { name.push_back(digits[byte >> 4]); name.push_back(digits[byte & 15]); } return name;
}
struct Entry {
  Handle handle, sentinel; Facts facts{}; std::vector<std::unique_ptr<Entry>> children;
};
struct Context { napi_env env; ULONGLONG deadline = GetTickCount64() + 10000; uint32_t scanned = 0, deleted = 0; };
void Bound(Context& context, size_t depth) {
  if (depth > 64 || context.scanned > 10000 || GetTickCount64() > context.deadline) {
    throw Failure("WINDOWS_PRIVATE_PURGE_LIMIT", "Private purge exceeded its entry, depth or time limit.");
  }
}

std::unique_ptr<Entry> Preflight(Context& context, HANDLE parent, const std::wstring& name, size_t depth, napi_value expectedRoot = nullptr) {
  Bound(context, depth); ++context.scanned;
  auto entry = std::make_unique<Entry>();
  entry->handle = Open(parent, name, DELETE | FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL);
  entry->facts = Inspect(context.env, entry->handle.value);
  if (expectedRoot && (!entry->facts.directory || !Matches(context.env, expectedRoot, entry->facts.identity))) {
    throw Failure("PROJECT_PATH_CHANGED", "Private purge root differs from the expected directory identity.");
  }
  if (!entry->facts.directory) return entry;
  const auto sentinelName = PinName();
  PSECURITY_DESCRIPTOR security = WindowsPrivateSecurityDescriptor();
  try { entry->sentinel = Open(entry->handle.value, sentinelName, GENERIC_READ | GENERIC_WRITE | DELETE,
      2, 0x40 | 0x1000, security); }
  catch (...) { LocalFree(security); throw; }
  LocalFree(security);
  std::vector<unsigned char> buffer(65536); bool first = true;
  for (;;) {
    Bound(context, depth);
    if (!GetFileInformationByHandleEx(entry->handle.value, first ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo,
        buffer.data(), static_cast<DWORD>(buffer.size()))) {
      if (GetLastError() == ERROR_NO_MORE_FILES) break;
      throw Failure("PROJECT_PATH_FORBIDDEN", "Private purge cannot enumerate a retained directory.", GetLastError());
    }
    first = false; size_t offset = 0;
    for (;;) {
      if (offset + offsetof(FILE_ID_BOTH_DIR_INFO, FileName) > buffer.size()) throw Failure("PROJECT_PATH_FORBIDDEN", "Invalid directory response.");
      const auto* found = reinterpret_cast<const FILE_ID_BOTH_DIR_INFO*>(buffer.data() + offset);
      if (found->FileNameLength % sizeof(wchar_t) || offset + offsetof(FILE_ID_BOTH_DIR_INFO, FileName) + found->FileNameLength > buffer.size()) {
        throw Failure("PROJECT_PATH_FORBIDDEN", "Invalid private purge directory entry.");
      }
      const std::wstring child(found->FileName, found->FileNameLength / sizeof(wchar_t));
      if (child != L"." && child != L".." && child != sentinelName) entry->children.push_back(Preflight(context, entry->handle.value, child, depth + 1));
      if (!found->NextEntryOffset) break;
      if (found->NextEntryOffset < offsetof(FILE_ID_BOTH_DIR_INFO, FileName) || offset + found->NextEntryOffset <= offset) {
        throw Failure("PROJECT_PATH_FORBIDDEN", "Invalid private purge directory offset.");
      }
      offset += found->NextEntryOffset;
    }
  }
  if (!(Inspect(context.env, entry->handle.value).identity == entry->facts.identity)) throw Failure("PROJECT_PATH_CHANGED", "Private purge directory changed.");
  return entry;
}

void Remove(Context& context, Entry& entry, size_t depth) {
  Bound(context, depth);
  if (!(Inspect(context.env, entry.handle.value).identity == entry.facts.identity)) throw Failure("PROJECT_PATH_CHANGED", "Private purge object changed.");
  for (auto& child : entry.children) Remove(context, *child, depth + 1);
  entry.sentinel.close();
  if (!(Inspect(context.env, entry.handle.value).identity == entry.facts.identity)) throw Failure("PROJECT_PATH_CHANGED", "Private purge object changed before deletion.");
  FILE_DISPOSITION_INFO disposition{TRUE};
  if (!SetFileInformationByHandle(entry.handle.value, FileDispositionInfo, &disposition, sizeof(disposition))) {
    throw Failure("PROJECT_PATH_FORBIDDEN", "Private purge could not delete a retained object.", GetLastError());
  }
  ++context.deleted; entry.handle.close();
}

napi_value Purge(napi_env env, napi_callback_info info) {
  Context context{env};
  try {
    size_t count = 0; Check(napi_get_cb_info(env, info, &count, nullptr, nullptr, nullptr)); if (count != 3) Invalid();
    napi_value args[3]; Check(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    const auto name = ChildName(env, args[1]);
    WindowsWithPinnedDirectory(env, args[0], [&](HANDLE parent, const std::function<void()>& flush) {
      auto root = Preflight(context, parent, name, 0, args[2]);
      Remove(context, *root, 0); flush();
    });
    napi_value result, removed, deleted; Check(napi_create_object(env, &result)); Check(napi_get_boolean(env, true, &removed));
    Check(napi_create_uint32(env, context.deleted, &deleted)); Check(napi_set_named_property(env, result, "removed", removed));
    Check(napi_set_named_property(env, result, "deletedEntries", deleted)); return result;
  } catch (const std::exception& exception) {
    bool pending = false; napi_is_exception_pending(env, &pending);
    if (pending) { napi_value prior; napi_get_and_clear_last_exception(env, &prior); }
    const auto* failure = dynamic_cast<const Failure*>(&exception);
    napi_value message, error, deleted, partial;
    napi_create_string_utf8(env, exception.what(), NAPI_AUTO_LENGTH, &message); napi_create_error(env, nullptr, message, &error);
    napi_value code; napi_create_string_utf8(env, context.deleted ? "WINDOWS_PRIVATE_PURGE_UNCONFIRMED" : failure ? failure->code : "PROJECT_PATH_FORBIDDEN", NAPI_AUTO_LENGTH, &code);
    napi_set_named_property(env, error, "code", code); napi_create_uint32(env, context.deleted, &deleted); napi_set_named_property(env, error, "deletedEntries", deleted);
    napi_get_boolean(env, context.deleted > 0, &partial); napi_set_named_property(env, error, "partial", partial);
    if (failure && failure->win32) { napi_value native; napi_create_uint32(env, failure->win32, &native); napi_set_named_property(env, error, "win32Error", native); }
    napi_throw(env, error); return nullptr;
  }
}
}

napi_value RegisterPrivatePurge(napi_env env, napi_value exports) {
  napi_value function; Check(napi_create_function(env, "removePrivateDirectory", NAPI_AUTO_LENGTH, Purge, nullptr, &function));
  Check(napi_set_named_property(env, exports, "removePrivateDirectory", function)); return exports;
}
