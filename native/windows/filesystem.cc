#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winternl.h>
#include <bcrypt.h>
#include <aclapi.h>
#include "filesystem.h"
#include "security.h"
#include <algorithm>
#include <cstdint>
#include <memory>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
#pragma comment(lib, "bcrypt.lib")

namespace {
constexpr DWORD kDirectoryFlags = FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT;
constexpr ULONG kOpenReparsePoint = 0x00200000;
constexpr ULONG kDirectoryFile = 0x00000001;
constexpr ULONG kNonDirectoryFile = 0x00000040;
constexpr ULONG kSynchronous = 0x00000020;
constexpr ULONG kDeleteOnClose = 0x00001000;
constexpr ULONG kWriteThrough = 0x00000002;
const napi_type_tag kLeaseTag{0x2e49126b376a4cd0ULL, 0x92e18050e8ec1a39ULL};
const napi_type_tag kCursorTag{0x8741b18eb42b4d31ULL, 0xa91b6510e7902504ULL};

struct Failure : std::runtime_error {
  const char* code;
  DWORD win32;
  Failure(const char* c, const char* message, DWORD error = 0) : std::runtime_error(message), code(c), win32(error) {}
};
[[noreturn]] void BadArguments() { throw Failure("BAD_ARGS", "Expected a bounded absolute Windows directory path and valid arguments."); }
void Check(napi_status status) { if (status != napi_ok) throw Failure("WINDOWS_NATIVE_ERROR", "Node-API operation failed."); }

class Handle {
 public:
  explicit Handle(HANDLE value = INVALID_HANDLE_VALUE) : value_(value) {}
  ~Handle() { close(); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value_(std::exchange(other.value_, INVALID_HANDLE_VALUE)) {}
  Handle& operator=(Handle&& other) noexcept { if (this != &other) { close(); value_ = std::exchange(other.value_, INVALID_HANDLE_VALUE); } return *this; }
  bool valid() const { return value_ != nullptr && value_ != INVALID_HANDLE_VALUE; }
  HANDLE get() const { return value_; }
  HANDLE release() { return std::exchange(value_, INVALID_HANDLE_VALUE); }
  void close() { if (valid()) CloseHandle(value_); value_ = INVALID_HANDLE_VALUE; }
 private:
  HANDLE value_;
};

struct Identity {
  uint64_t volume = 0;
  unsigned char id[16] = {};
  int64_t created = 0;
  bool operator==(const Identity& other) const {
    return volume == other.volume && created == other.created && std::equal(std::begin(id), std::end(id), std::begin(other.id));
  }
};

Identity DirectoryIdentity(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO attributes{}; FILE_STANDARD_INFO standard{}; FILE_ID_INFO id{}; FILE_BASIC_INFO basic{};
  FILE_CASE_SENSITIVE_INFO caseSensitive{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &attributes, sizeof(attributes)) ||
      !GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard)) ||
      !GetFileInformationByHandleEx(handle, FileIdInfo, &id, sizeof(id)) ||
      !GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic)) ||
      !GetFileInformationByHandleEx(handle, FileCaseSensitiveInfo, &caseSensitive, sizeof(caseSensitive))) {
    throw Failure("PROJECT_PATH_FORBIDDEN", "Directory identity is unavailable.", GetLastError());
  }
  if (!standard.Directory || standard.DeletePending || caseSensitive.Flags != 0 || (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      basic.CreationTime.QuadPart <= 0 || std::all_of(std::begin(id.FileId.Identifier), std::end(id.FileId.Identifier), [](unsigned char b) { return b == 0; })) {
    throw Failure("PROJECT_PATH_FORBIDDEN", "Directory must be a stable ordinary directory without reparse points.");
  }
  Identity result; result.volume = id.VolumeSerialNumber; result.created = basic.CreationTime.QuadPart;
  std::copy(std::begin(id.FileId.Identifier), std::end(id.FileId.Identifier), std::begin(result.id));
  return result;
}

std::wstring CanonicalPath(HANDLE handle) {
  const DWORD needed = GetFinalPathNameByHandleW(handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!needed || needed >= 32768) throw Failure("PROJECT_PATH_FORBIDDEN", "Directory canonical path is unavailable.", GetLastError());
  std::vector<wchar_t> data(static_cast<size_t>(needed) + 1);
  const DWORD length = GetFinalPathNameByHandleW(handle, data.data(), static_cast<DWORD>(data.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!length || length >= data.size()) throw Failure("PROJECT_PATH_FORBIDDEN", "Directory canonical path changed.", GetLastError());
  std::wstring result(data.data(), length);
  if (result.compare(0, 4, L"\\\\?\\") != 0 || result.size() < 7 || result[5] != L':') {
    throw Failure("PROJECT_PATH_FORBIDDEN", "Only local drive paths are supported by this directory primitive.");
  }
  return result.substr(4);
}

std::vector<napi_value> Arguments(napi_env env, napi_callback_info info, size_t minimum, size_t maximum, napi_value* receiver = nullptr) {
  size_t count = 0; Check(napi_get_cb_info(env, info, &count, nullptr, receiver, nullptr));
  if (count < minimum || count > maximum) BadArguments();
  std::vector<napi_value> values(count);
  if (count) Check(napi_get_cb_info(env, info, &count, values.data(), receiver, nullptr));
  return values;
}

std::wstring PathArgument(napi_env env, napi_value value) {
  napi_valuetype type; Check(napi_typeof(env, value, &type)); if (type != napi_string) BadArguments();
  size_t length = 0; Check(napi_get_value_string_utf16(env, value, nullptr, 0, &length));
  if (length < 3 || length >= 32760) BadArguments();
  std::vector<char16_t> data(length + 1); size_t copied = 0;
  Check(napi_get_value_string_utf16(env, value, data.data(), data.size(), &copied));
  if (copied != length) BadArguments();
  std::wstring result(reinterpret_cast<const wchar_t*>(data.data()), copied);
  for (size_t i = 0; i < result.size(); ++i) {
    const wchar_t c = result[i];
    if (c < 32 || c == 127 || c == L'<' || c == L'>' || c == L'"' || c == L'|' || c == L'?' || c == L'*' || (c == L':' && i != 1)) BadArguments();
    if (c >= 0xd800 && c <= 0xdbff) {
      if (++i >= result.size() || result[i] < 0xdc00 || result[i] > 0xdfff) BadArguments();
    } else if (c >= 0xdc00 && c <= 0xdfff) BadArguments();
  }
  std::replace(result.begin(), result.end(), L'/', L'\\');
  if (!((result[0] >= L'A' && result[0] <= L'Z') || (result[0] >= L'a' && result[0] <= L'z')) || result[1] != L':' || result[2] != L'\\') BadArguments();
  if (result.size() > 3 && result.back() == L'\\') result.pop_back();
  size_t start = 3, count = 0;
  while (start < result.size()) {
    size_t end = result.find(L'\\', start); if (end == std::wstring::npos) end = result.size();
    std::wstring component = result.substr(start, end - start);
    if (component.empty() || component.size() > 255 || component.back() == L'.' || component.back() == L' ' || ++count > 128) BadArguments();
    std::wstring stem = component.substr(0, component.find(L'.'));
    for (auto& c : stem) if (c >= L'a' && c <= L'z') c -= L'a' - L'A';
    if (stem == L"CON" || stem == L"PRN" || stem == L"AUX" || stem == L"NUL" || stem == L"CONIN$" || stem == L"CONOUT$" ||
        (stem.size() == 4 && (stem.compare(0, 3, L"COM") == 0 || stem.compare(0, 3, L"LPT") == 0) &&
         ((stem[3] >= L'0' && stem[3] <= L'9') || stem[3] == 0xb9 || stem[3] == 0xb2 || stem[3] == 0xb3))) BadArguments();
    start = end + 1;
  }
  return result;
}

bool PinArgument(napi_env env, napi_value value) {
  napi_valuetype type; Check(napi_typeof(env, value, &type));
  napi_value nullValue; Check(napi_get_null(env, &nullValue)); bool isNull = false, isArray = false;
  Check(napi_strict_equals(env, value, nullValue, &isNull)); Check(napi_is_array(env, value, &isArray));
  if (type != napi_object || isNull || isArray) BadArguments();
  napi_value names; Check(napi_get_all_property_names(env, value, napi_key_own_only, napi_key_all_properties, napi_key_numbers_to_strings, &names));
  uint32_t count = 0; Check(napi_get_array_length(env, names, &count)); if (count > 1) BadArguments();
  if (!count) return true;
  napi_value name, pinName; Check(napi_get_element(env, names, 0, &name)); Check(napi_create_string_utf8(env, "pin", 3, &pinName));
  bool matches = false; Check(napi_strict_equals(env, name, pinName, &matches)); if (!matches) BadArguments();
  napi_value pin; Check(napi_get_named_property(env, value, "pin", &pin)); Check(napi_typeof(env, pin, &type));
  if (type != napi_boolean) BadArguments(); bool result = false; Check(napi_get_value_bool(env, pin, &result)); return result;
}

Handle OpenRelative(HANDLE parent, const std::wstring& name, ACCESS_MASK access, ULONG sharing,
                    ULONG disposition, ULONG options, ULONG attributes, const char* code, PSECURITY_DESCRIPTOR security = nullptr) {
  using OpenFunction = NTSTATUS(NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
  using ErrorFunction = ULONG(WINAPI*)(NTSTATUS);
  HMODULE module = GetModuleHandleW(L"ntdll.dll");
  auto open = reinterpret_cast<OpenFunction>(GetProcAddress(module, "NtCreateFile"));
  auto errorCode = reinterpret_cast<ErrorFunction>(GetProcAddress(module, "RtlNtStatusToDosError"));
  if (!open || !errorCode) throw Failure("WINDOWS_NATIVE_UNAVAILABLE", "Handle-relative file operations are unavailable.");
  UNICODE_STRING nameString{}; nameString.Buffer = const_cast<wchar_t*>(name.data());
  nameString.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t)); nameString.MaximumLength = nameString.Length;
  OBJECT_ATTRIBUTES object{}; object.Length = sizeof(object); object.RootDirectory = parent; object.ObjectName = &nameString;
  object.SecurityDescriptor = security;
  // Win32-compatible lookup is used for this primitive. Case-sensitive NTFS
  // directories require explicit separate acceptance before product support.
  object.Attributes = OBJ_CASE_INSENSITIVE;
  IO_STATUS_BLOCK statusBlock{}; HANDLE raw = INVALID_HANDLE_VALUE;
  NTSTATUS status = open(&raw, access | SYNCHRONIZE, &object, &statusBlock, nullptr, attributes, sharing,
    disposition, options | kOpenReparsePoint | kSynchronous, nullptr, 0);
  if (status < 0) throw Failure(code, "Cannot open the directory object with required safety properties.", errorCode(status));
  return Handle(raw);
}

struct Chain {
  std::vector<Handle> handles;
  std::vector<Identity> identities;
  std::wstring canonical;
};

Chain OpenChain(const std::wstring& requested, bool pin) {
  const std::wstring drive = requested.substr(0, 3);
  const UINT kind = GetDriveTypeW(drive.c_str());
  if (kind != DRIVE_FIXED && kind != DRIVE_REMOVABLE) throw Failure("PROJECT_PATH_FORBIDDEN", "Directory leases require a local NTFS volume.");
  wchar_t volume[64] = {};
  if (!GetVolumeNameForVolumeMountPointW(drive.c_str(), volume, static_cast<DWORD>(std::size(volume)))) {
    throw Failure("PROJECT_PATH_FORBIDDEN", "Directory volume identity is unavailable.", GetLastError());
  }
  Chain result;
  const DWORD share = FILE_SHARE_READ | FILE_SHARE_WRITE | (pin ? 0 : FILE_SHARE_DELETE);
  Handle root(CreateFileW(volume, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL, share, nullptr, OPEN_EXISTING, kDirectoryFlags, nullptr));
  if (!root.valid()) throw Failure("PROJECT_PATH_FORBIDDEN", "Cannot capture the directory volume.", GetLastError());
  wchar_t filesystem[32] = {};
  if (!GetVolumeInformationByHandleW(root.get(), nullptr, 0, nullptr, nullptr, nullptr, filesystem, static_cast<DWORD>(std::size(filesystem))) ||
      std::wstring(filesystem) != L"NTFS") throw Failure("PROJECT_PATH_FORBIDDEN", "Directory leases require a local NTFS volume.");
  result.identities.push_back(DirectoryIdentity(root.get())); result.handles.push_back(std::move(root));
  size_t start = 3;
  while (start < requested.size()) {
    size_t end = requested.find(L'\\', start); if (end == std::wstring::npos) end = requested.size();
    Handle current = OpenRelative(result.handles.back().get(), requested.substr(start, end - start),
      FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL, share, 1, kDirectoryFile, 0, "PROJECT_PATH_FORBIDDEN");
    result.identities.push_back(DirectoryIdentity(current.get())); result.handles.push_back(std::move(current));
    start = end + 1;
  }
  result.canonical = CanonicalPath(result.handles.back().get());
  return result;
}

std::wstring SentinelName() {
  unsigned char bytes[16] = {};
  if (BCryptGenRandom(nullptr, bytes, sizeof(bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) {
    throw Failure("WINDOWS_DIRECTORY_PIN_UNAVAILABLE", "Cannot generate a directory lease identifier.");
  }
  static constexpr wchar_t digits[] = L"0123456789abcdef";
  std::wstring result = L".hcc-cwd-pin-";
  for (unsigned char b : bytes) { result.push_back(digits[b >> 4]); result.push_back(digits[b & 15]); }
  return result;
}

struct Lease {
  std::wstring requested;
  std::wstring sentinelName;
  Chain chain;
  Handle sentinel;
  bool pin = false;
  bool closed = false;
  void close() {
    if (closed) return; closed = true;
    sentinel.close();
    for (auto current = chain.handles.rbegin(); current != chain.handles.rend(); ++current) current->close();
    chain.handles.clear();
  }
  ~Lease() { close(); }
  void requireOpen() const { if (closed) throw Failure("WINDOWS_DIRECTORY_LEASE_CLOSED", "The directory lease is closed."); }
  void assertUnchanged() const {
    requireOpen();
    try {
      for (size_t i = 0; i < chain.handles.size(); ++i) if (!(DirectoryIdentity(chain.handles[i].get()) == chain.identities[i])) throw std::runtime_error("changed");
      Chain current = OpenChain(requested, false);
      if (current.identities != chain.identities || current.canonical != chain.canonical) throw std::runtime_error("changed");
      if (pin) {
        FILE_STANDARD_INFO standard{};
        if (!sentinel.valid() || !GetFileInformationByHandleEx(sentinel.get(), FileStandardInfo, &standard, sizeof(standard)) ||
            standard.Directory || standard.NumberOfLinks != 1) throw std::runtime_error("sentinel changed");
      }
    } catch (...) { throw Failure("PROJECT_PATH_CHANGED", "The selected directory changed while held."); }
  }
};

Handle Duplicate(HANDLE source) {
  HANDLE copy = INVALID_HANDLE_VALUE;
  if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &copy, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
    throw Failure("WINDOWS_NATIVE_ERROR", "Cannot retain the directory binding.", GetLastError());
  }
  return Handle(copy);
}

std::unique_ptr<Lease> Retain(const Lease& original) {
  original.assertUnchanged(); auto copy = std::make_unique<Lease>();
  copy->requested = original.requested; copy->pin = original.pin;
  copy->sentinelName = original.sentinelName;
  copy->chain.canonical = original.chain.canonical; copy->chain.identities = original.chain.identities;
  for (const Handle& handle : original.chain.handles) copy->chain.handles.push_back(Duplicate(handle.get()));
  if (original.sentinel.valid()) copy->sentinel = Duplicate(original.sentinel.get());
  return copy;
}

class ProcessDirectoryLease final : public WindowsProcessDirectoryLease {
 public:
  explicit ProcessDirectoryLease(std::unique_ptr<Lease> lease) : lease_(std::move(lease)) {}
  const std::wstring& canonical() const override { return lease_->chain.canonical; }
  std::vector<HANDLE> handles() const override {
    std::vector<HANDLE> result;
    for (const Handle& handle : lease_->chain.handles) result.push_back(handle.get());
    result.push_back(lease_->sentinel.get()); return result;
  }
  void assertUnchanged() const override { lease_->assertUnchanged(); }
 private:
  std::unique_ptr<Lease> lease_;
};

struct FileFacts {
  Identity identity;
  int64_t size = 0, modified = 0, changed = 0;
  DWORD links = 0, attributes = 0;
  bool operator==(const FileFacts& other) const {
    return identity == other.identity && size == other.size && modified == other.modified &&
      changed == other.changed && links == other.links && attributes == other.attributes;
  }
};

FileFacts InspectFile(HANDLE handle) {
  FILE_STANDARD_INFO standard{}; FILE_BASIC_INFO basic{}; FILE_ID_INFO id{}; FILE_ATTRIBUTE_TAG_INFO tag{};
  if (!GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard)) ||
      !GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic)) ||
      !GetFileInformationByHandleEx(handle, FileIdInfo, &id, sizeof(id)) ||
      !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag))) {
    throw Failure("PROJECT_FILE_FORBIDDEN", "File identity is unavailable.", GetLastError());
  }
  if (standard.Directory || standard.DeletePending || standard.NumberOfLinks != 1 ||
      (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || GetFileType(handle) != FILE_TYPE_DISK ||
      standard.EndOfFile.QuadPart < 0 || basic.CreationTime.QuadPart <= 0) {
    throw Failure("PROJECT_FILE_FORBIDDEN", "Only ordinary files with one link can be accessed.");
  }
  FileFacts result; result.identity.volume = id.VolumeSerialNumber; result.identity.created = basic.CreationTime.QuadPart;
  std::copy(std::begin(id.FileId.Identifier), std::end(id.FileId.Identifier), std::begin(result.identity.id));
  result.size = standard.EndOfFile.QuadPart; result.modified = basic.LastWriteTime.QuadPart; result.changed = basic.ChangeTime.QuadPart;
  result.links = standard.NumberOfLinks; result.attributes = tag.FileAttributes; return result;
}

std::vector<std::wstring> RelativeArgument(napi_env env, napi_value value, bool allowEmpty) {
  napi_valuetype type; Check(napi_typeof(env, value, &type)); if (type != napi_string) BadArguments();
  size_t length = 0; Check(napi_get_value_string_utf16(env, value, nullptr, 0, &length));
  if (length > 4096 || (!length && !allowEmpty)) BadArguments();
  std::vector<char16_t> data(length + 1); Check(napi_get_value_string_utf16(env, value, data.data(), data.size(), &length));
  std::wstring relative(reinterpret_cast<const wchar_t*>(data.data()), length);
  if (relative.find(L'\\') != std::wstring::npos || relative.find(L':') != std::wstring::npos ||
      (!relative.empty() && (relative.front() == L'/' || relative.back() == L'/'))) BadArguments();
  if (relative.empty()) return {};
  // Reuse strict component validation without opening or normalizing a path.
  napi_value checked; const std::wstring fake = L"C:\\" + relative;
  Check(napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(fake.data()), fake.size(), &checked));
  PathArgument(env, checked);
  std::vector<std::wstring> parts; size_t start = 0;
  while (start < relative.size()) {
    size_t end = relative.find(L'/', start); if (end == std::wstring::npos) end = relative.size();
    parts.push_back(relative.substr(start, end - start)); start = end + 1;
  }
  return parts;
}

[[noreturn]] void FileOpenFailure(const Failure& error, bool directory) {
  const char* code = error.win32 == ERROR_FILE_NOT_FOUND || error.win32 == ERROR_PATH_NOT_FOUND ? "PROJECT_FILE_NOT_FOUND" :
    directory && error.win32 == ERROR_DIRECTORY ? "PROJECT_FILE_NOT_DIRECTORY" : "PROJECT_FILE_FORBIDDEN";
  throw Failure(code, "The requested project path cannot be opened safely.", error.win32);
}

struct Cursor {
  std::unique_ptr<Lease> root;
  std::vector<std::wstring> parts, actual;
  std::vector<Handle> parents;
  std::vector<Identity> parentIdentities;
  Handle target;
  Handle sentinel;
  std::wstring sentinelName;
  Identity directoryIdentity;
  FileFacts file;
  std::wstring canonical;
  bool directory = false, mutableFile = false, appendFile = false, closed = false;
  void requireOpen() const { if (closed) throw Failure("WINDOWS_FILE_HANDLE_CLOSED", "The project file handle is closed."); }
  void close() {
    if (closed) return; closed = true; sentinel.close(); target.close();
    for (auto item = parents.rbegin(); item != parents.rend(); ++item) item->close();
    parents.clear(); root.reset();
  }
  ~Cursor() { close(); }
  void assertUnchanged() const {
    requireOpen(); root->assertUnchanged();
    try {
      for (size_t i = 0; i < parents.size(); ++i) if (!(DirectoryIdentity(parents[i].get()) == parentIdentities[i])) throw std::runtime_error("changed");
      if (directory) { if (!(DirectoryIdentity(target.get()) == directoryIdentity)) throw std::runtime_error("changed"); }
      else {
        const FileFacts current = InspectFile(target.get());
        if (mutableFile ? !(current.identity == file.identity) : !(current == file)) throw std::runtime_error("changed");
      }
      if (CanonicalPath(target.get()) != canonical) throw std::runtime_error("changed");
    } catch (...) { throw Failure("PROJECT_FILE_CHANGED", "The project path changed while held."); }
  }
};

std::unique_ptr<Cursor> RetainCursor(const Cursor& original) {
  original.assertUnchanged(); auto cursor = std::make_unique<Cursor>();
  cursor->root = Retain(*original.root); cursor->parts = original.parts; cursor->actual = original.actual;
  cursor->parentIdentities = original.parentIdentities; cursor->directoryIdentity = original.directoryIdentity;
  cursor->file = original.file; cursor->canonical = original.canonical; cursor->sentinelName = original.sentinelName;
  cursor->directory = original.directory; cursor->mutableFile = original.mutableFile; cursor->appendFile = original.appendFile;
  for (const Handle& parent : original.parents) cursor->parents.push_back(Duplicate(parent.get()));
  cursor->target = Duplicate(original.target.get());
  if (original.sentinel.valid()) cursor->sentinel = Duplicate(original.sentinel.get());
  return cursor;
}

class ProcessAppendLease final : public WindowsProcessAppendLease {
 public:
  explicit ProcessAppendLease(std::unique_ptr<Cursor> cursor) : cursor_(std::move(cursor)) {}
  HANDLE file() const override { return cursor_->target.get(); }
  std::vector<HANDLE> handles() const override {
    std::vector<HANDLE> result;
    for (const Handle& handle : cursor_->root->chain.handles) result.push_back(handle.get());
    result.push_back(cursor_->root->sentinel.get());
    for (const Handle& handle : cursor_->parents) result.push_back(handle.get());
    result.push_back(cursor_->target.get()); return result;
  }
  void assertUnchanged() const override { cursor_->assertUnchanged(); }
 private:
  std::unique_ptr<Cursor> cursor_;
};

std::unique_ptr<Cursor> OpenCursor(const Lease& original, std::vector<std::wstring> parts, bool directory, bool mutableFile = false, bool publishSource = false) {
  auto cursor = std::make_unique<Cursor>(); cursor->root = Retain(original); cursor->parts = std::move(parts); cursor->directory = directory;
  cursor->mutableFile = mutableFile;
  HANDLE parent = cursor->root->chain.handles.back().get();
  if (cursor->parts.empty()) { if (!directory) BadArguments(); cursor->target = Duplicate(parent); }
  for (size_t i = 0; i < cursor->parts.size(); ++i) {
    const bool final = i + 1 == cursor->parts.size(); const bool isDirectory = !final || directory;
    Handle current;
    try {
      // Attribute-only opens do not participate in Windows share checks. A
      // mutable binding still needs READ_DATA so omitting SHARE_DELETE pins it.
      current = OpenRelative(parent, cursor->parts[i], READ_CONTROL | FILE_READ_ATTRIBUTES | (isDirectory ? FILE_LIST_DIRECTORY : FILE_READ_DATA),
        FILE_SHARE_READ | (isDirectory || mutableFile ? FILE_SHARE_WRITE : 0) |
          (final && publishSource ? FILE_SHARE_DELETE : 0), 1, isDirectory ? kDirectoryFile : kNonDirectoryFile, 0, "PROJECT_FILE_FORBIDDEN");
    } catch (const Failure& error) { FileOpenFailure(error, isDirectory); }
    const std::wstring canonical = CanonicalPath(current.get());
    const std::wstring prefix = cursor->root->chain.canonical + (cursor->root->chain.canonical.back() == L'\\' ? L"" : L"\\");
    if (canonical.size() <= prefix.size() || CompareStringOrdinal(canonical.data(), static_cast<int>(prefix.size()),
        prefix.data(), static_cast<int>(prefix.size()), TRUE) != CSTR_EQUAL) {
      throw Failure("PROJECT_FILE_FORBIDDEN", "The opened file is outside the selected project.");
    }
    cursor->actual.push_back(canonical.substr(canonical.find_last_of(L'\\') + 1));
    if (final) cursor->target = std::move(current);
    else {
      try { cursor->parentIdentities.push_back(DirectoryIdentity(current.get())); }
      catch (const Failure& error) { FileOpenFailure(error, true); }
      cursor->parents.push_back(std::move(current)); parent = cursor->parents.back().get();
    }
  }
  try { if (directory) cursor->directoryIdentity = DirectoryIdentity(cursor->target.get()); else cursor->file = InspectFile(cursor->target.get()); }
  catch (const Failure& error) { FileOpenFailure(error, directory); }
  if (directory && cursor->root->pin && !cursor->parts.empty()) {
    cursor->sentinelName = SentinelName();
    cursor->sentinel = OpenRelative(cursor->target.get(), cursor->sentinelName, GENERIC_READ | GENERIC_WRITE | DELETE,
      FILE_SHARE_READ, 2, kNonDirectoryFile | kDeleteOnClose, FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_TEMPORARY,
      "WINDOWS_DIRECTORY_PIN_UNAVAILABLE");
  }
  cursor->canonical = CanonicalPath(cursor->target.get()); cursor->assertUnchanged(); return cursor;
}

napi_value Text(napi_env env, const std::string& value) { napi_value result; Check(napi_create_string_utf8(env, value.data(), value.size(), &result)); return result; }
napi_value WideText(napi_env env, const std::wstring& value) { napi_value result; Check(napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(value.data()), value.size(), &result)); return result; }
void Set(napi_env env, napi_value object, const char* key, napi_value value) { Check(napi_set_named_property(env, object, key, value)); }
napi_value IdentityValue(napi_env env, const Identity& source) {
  napi_value result, version; Check(napi_create_object(env, &result)); Check(napi_create_uint32(env, 1, &version));
  std::string encoded; static constexpr char digits[] = "0123456789abcdef";
  for (unsigned char byte : source.id) { encoded.push_back(digits[byte >> 4]); encoded.push_back(digits[byte & 15]); }
  Set(env, result, "platform", Text(env, "win32")); Set(env, result, "version", version);
  Set(env, result, "volumeSerial", Text(env, std::to_string(source.volume)));
  Set(env, result, "fileId", Text(env, encoded)); Set(env, result, "creationTime", Text(env, std::to_string(source.created)));
  return result;
}

napi_value Snapshot(napi_env env, const Lease& lease) {
  lease.requireOpen(); napi_value result, identity, version; Check(napi_create_object(env, &result)); Check(napi_create_object(env, &identity));
  const Identity& source = lease.chain.identities.back();
  Check(napi_create_uint32(env, 1, &version)); Set(env, identity, "version", version); Set(env, identity, "platform", Text(env, "win32"));
  Set(env, identity, "volumeSerial", Text(env, std::to_string(source.volume)));
  std::string id; static constexpr char digits[] = "0123456789abcdef";
  for (unsigned char b : source.id) { id.push_back(digits[b >> 4]); id.push_back(digits[b & 15]); }
  Set(env, identity, "fileId", Text(env, id)); Set(env, identity, "creationTime", Text(env, std::to_string(source.created)));
  Set(env, result, "identity", identity); Set(env, result, "canonical", WideText(env, lease.chain.canonical));
  Set(env, result, "requested", WideText(env, lease.requested)); Set(env, result, "mode", Text(env, lease.pin ? "pinned" : "observed"));
  if (lease.pin) Set(env, result, "sentinelName", WideText(env, lease.sentinelName));
  return result;
}

napi_value CursorSnapshotValue(napi_env env, const Cursor& cursor) {
  cursor.requireOpen(); napi_value result = Snapshot(env, *cursor.root);
  napi_value rootIdentity; Check(napi_get_named_property(env, result, "identity", &rootIdentity)); Set(env, result, "rootIdentity", rootIdentity);
  Set(env, result, "rootCanonical", WideText(env, cursor.root->chain.canonical)); Set(env, result, "canonical", WideText(env, cursor.canonical));
  const Identity& id = cursor.directory ? cursor.directoryIdentity : cursor.file.identity;
  napi_value identity, version; Check(napi_create_object(env, &identity)); Check(napi_create_uint32(env, 1, &version));
  Set(env, identity, "version", version); Set(env, identity, "platform", Text(env, "win32")); Set(env, identity, "volumeSerial", Text(env, std::to_string(id.volume)));
  std::string encoded; static constexpr char digits[] = "0123456789abcdef";
  for (unsigned char b : id.id) { encoded.push_back(digits[b >> 4]); encoded.push_back(digits[b & 15]); }
  Set(env, identity, "fileId", Text(env, encoded)); Set(env, identity, "creationTime", Text(env, std::to_string(id.created))); Set(env, result, "identity", identity);
  napi_value actual; Check(napi_create_array_with_length(env, cursor.actual.size(), &actual));
  for (size_t i = 0; i < cursor.actual.size(); ++i) Check(napi_set_element(env, actual, static_cast<uint32_t>(i), WideText(env, cursor.actual[i])));
  Set(env, result, "actualComponents", actual); Set(env, result, "type", Text(env, cursor.directory ? "directory" : "file"));
  if (cursor.directory && !cursor.sentinelName.empty()) Set(env, result, "sentinelName", WideText(env, cursor.sentinelName));
  if (!cursor.directory) {
    Set(env, result, "size", Text(env, std::to_string(cursor.file.size))); Set(env, result, "nlink", Text(env, std::to_string(cursor.file.links)));
    Set(env, result, "modifiedTime", Text(env, std::to_string(cursor.file.modified))); Set(env, result, "changeTime", Text(env, std::to_string(cursor.file.changed)));
    napi_value attributes; Check(napi_create_uint32(env, cursor.file.attributes, &attributes)); Set(env, result, "attributes", attributes);
  }
  return result;
}

napi_value Throw(napi_env env, const std::exception& exception) {
  bool pending = false; napi_is_exception_pending(env, &pending); if (pending) return nullptr;
  const auto* failure = dynamic_cast<const Failure*>(&exception);
  napi_value error; if (napi_create_error(env, nullptr, Text(env, exception.what()), &error) != napi_ok) return nullptr;
  Set(env, error, "code", Text(env, failure ? failure->code : "WINDOWS_NATIVE_ERROR"));
  if (failure && failure->win32) { napi_value code; Check(napi_create_uint32(env, failure->win32, &code)); Set(env, error, "win32Error", code); }
  napi_throw(env, error); return nullptr;
}

Lease* Receiver(napi_env env, napi_callback_info info) {
  napi_value receiver; Arguments(env, info, 0, 0, &receiver); napi_valuetype type; Check(napi_typeof(env, receiver, &type));
  if (type != napi_object) BadArguments(); bool matches = false;
  Check(napi_check_object_type_tag(env, receiver, &kLeaseTag, &matches)); if (!matches) BadArguments();
  Lease* lease = nullptr; Check(napi_unwrap(env, receiver, reinterpret_cast<void**>(&lease))); if (!lease) BadArguments(); return lease;
}

Cursor* CursorReceiver(napi_env env, napi_callback_info info, size_t minimum, size_t maximum, std::vector<napi_value>* args = nullptr) {
  napi_value receiver; auto values = Arguments(env, info, minimum, maximum, &receiver); napi_valuetype type; Check(napi_typeof(env, receiver, &type));
  if (type != napi_object) BadArguments(); bool matches = false;
  Check(napi_check_object_type_tag(env, receiver, &kCursorTag, &matches)); if (!matches) BadArguments();
  Cursor* cursor = nullptr; Check(napi_unwrap(env, receiver, reinterpret_cast<void**>(&cursor))); if (!cursor) BadArguments();
  if (args) *args = std::move(values); return cursor;
}

uint32_t BoundedNumber(napi_env env, napi_value value, uint32_t maximum) {
  napi_valuetype type; Check(napi_typeof(env, value, &type)); if (type != napi_number) BadArguments();
  double number = 0; Check(napi_get_value_double(env, value, &number));
  if (!(number >= 0 && number <= maximum) || number != static_cast<uint32_t>(number)) BadArguments();
  return static_cast<uint32_t>(number);
}

napi_value CursorSnapshot(napi_env env, napi_callback_info info) {
  try {
    Cursor* cursor = CursorReceiver(env, info, 0, 0); cursor->assertUnchanged();
    if (cursor->mutableFile) cursor->file = InspectFile(cursor->target.get());
    return CursorSnapshotValue(env, *cursor);
  } catch (const std::exception& e) { return Throw(env, e); }
}
napi_value CursorAssert(napi_env env, napi_callback_info info) {
  try { CursorReceiver(env, info, 0, 0)->assertUnchanged(); napi_value result; Check(napi_get_boolean(env, true, &result)); return result; } catch (const std::exception& e) { return Throw(env, e); }
}
napi_value CursorClose(napi_env env, napi_callback_info info) {
  try { CursorReceiver(env, info, 0, 0)->close(); napi_value result; Check(napi_get_undefined(env, &result)); return result; } catch (const std::exception& e) { return Throw(env, e); }
}
napi_value CursorRead(napi_env env, napi_callback_info info) {
  try {
    std::vector<napi_value> args; Cursor* cursor = CursorReceiver(env, info, 1, 1, &args); cursor->requireOpen(); if (cursor->directory || cursor->mutableFile) BadArguments();
    const uint32_t maximum = BoundedNumber(env, args[0], 10 * 1024 * 1024); cursor->assertUnchanged();
    const size_t length = static_cast<size_t>((std::min)(cursor->file.size, static_cast<int64_t>(maximum)));
    napi_value result; void* bytes = nullptr; Check(napi_create_buffer(env, length, &bytes, &result));
    LARGE_INTEGER zero{}; if (!SetFilePointerEx(cursor->target.get(), zero, nullptr, FILE_BEGIN)) throw Failure("PROJECT_FILE_CHANGED", "File position is unavailable.", GetLastError());
    size_t offset = 0;
    while (offset < length) {
      DWORD count = 0;
      if (!ReadFile(cursor->target.get(), static_cast<unsigned char*>(bytes) + offset, static_cast<DWORD>(length - offset), &count, nullptr) || count == 0) {
        throw Failure("PROJECT_FILE_CHANGED", "The project file changed during its bounded read.", GetLastError());
      }
      offset += count;
    }
    cursor->assertUnchanged(); return result;
  } catch (const std::exception& e) { return Throw(env, e); }
}

napi_value CursorList(napi_env env, napi_callback_info info) {
  try {
    std::vector<napi_value> args; Cursor* cursor = CursorReceiver(env, info, 1, 1, &args); cursor->requireOpen(); if (!cursor->directory) BadArguments();
    napi_valuetype type; Check(napi_typeof(env, args[0], &type)); if (type != napi_object) BadArguments();
    napi_value names; Check(napi_get_all_property_names(env, args[0], napi_key_own_only, napi_key_all_properties, napi_key_numbers_to_strings, &names));
    uint32_t keyCount = 0; Check(napi_get_array_length(env, names, &keyCount)); if (keyCount < 1 || keyCount > 2) BadArguments();
    napi_value limit; bool hasLimit = false; Check(napi_has_own_property(env, args[0], Text(env, "maxScanned"), &hasLimit)); if (!hasLimit) BadArguments();
    Check(napi_get_named_property(env, args[0], "maxScanned", &limit)); const uint32_t maximum = BoundedNumber(env, limit, 5000); if (!maximum) BadArguments();
    bool hasTimeBudget = false; Check(napi_has_own_property(env, args[0], Text(env, "timeBudgetMs"), &hasTimeBudget));
    if (keyCount != (hasTimeBudget ? 2u : 1u)) BadArguments();
    ULONGLONG deadline = (std::numeric_limits<ULONGLONG>::max)();
    if (hasTimeBudget) {
      napi_value budget; Check(napi_get_named_property(env, args[0], "timeBudgetMs", &budget));
      deadline = GetTickCount64() + BoundedNumber(env, budget, 60000);
    }
    cursor->assertUnchanged(); napi_value entries, omitted; Check(napi_create_array(env, &entries)); Check(napi_create_array(env, &omitted));
    uint32_t emitted = 0, scanned = 0, omissions = 0;
    bool truncated = false, first = true, finished = false, sentinelSeen = false; std::vector<unsigned char> buffer(65536);
    while (!finished) {
      if (GetTickCount64() >= deadline) { truncated = true; break; }
      if (!GetFileInformationByHandleEx(cursor->target.get(), first ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo,
        buffer.data(), static_cast<DWORD>(buffer.size()))) {
        if (GetLastError() == ERROR_NO_MORE_FILES) break;
        throw Failure("PROJECT_FILE_CHANGED", "Cannot enumerate the held directory.", GetLastError());
      }
      first = false; size_t offset = 0;
      for (;;) {
        if (offset + offsetof(FILE_ID_BOTH_DIR_INFO, FileName) > buffer.size()) throw Failure("PROJECT_FILE_CHANGED", "Invalid directory response.");
        const auto* entry = reinterpret_cast<const FILE_ID_BOTH_DIR_INFO*>(buffer.data() + offset);
        if ((entry->FileNameLength % sizeof(wchar_t)) != 0 || offset + offsetof(FILE_ID_BOTH_DIR_INFO, FileName) + entry->FileNameLength > buffer.size()) {
          throw Failure("PROJECT_FILE_CHANGED", "Invalid directory entry.");
        }
        std::wstring name(entry->FileName, entry->FileNameLength / sizeof(wchar_t));
        if (name != L"." && name != L"..") {
          if (GetTickCount64() >= deadline) { truncated = true; finished = true; break; }
          if (scanned++ == maximum) { truncated = true; finished = true; break; }
          if (cursor->root->pin && name == (cursor->parts.empty() ? cursor->root->sentinelName : cursor->sentinelName)) sentinelSeen = true;
          if (!(entry->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
            try {
              Handle object = OpenRelative(cursor->target.get(), name, FILE_READ_ATTRIBUTES | READ_CONTROL,
                FILE_SHARE_READ | FILE_SHARE_WRITE, 1, 0, 0, "PROJECT_FILE_CHANGED");
              FILE_STANDARD_INFO standard{};
              if (!GetFileInformationByHandleEx(object.get(), FileStandardInfo, &standard, sizeof(standard))) throw Failure("PROJECT_FILE_CHANGED", "Directory entry disappeared.", GetLastError());
              napi_value item; Check(napi_create_object(env, &item));
              Set(env, item, "name", WideText(env, name));
              if (standard.Directory) { DirectoryIdentity(object.get()); Set(env, item, "type", Text(env, "directory")); }
              else { FileFacts facts = InspectFile(object.get()); Set(env, item, "type", Text(env, "file")); napi_value size; Check(napi_create_double(env, static_cast<double>(facts.size), &size)); Set(env, item, "size", size); }
              Check(napi_set_element(env, entries, emitted++, item));
            } catch (const Failure& error) {
              if (error.win32 == ERROR_FILE_NOT_FOUND || error.win32 == ERROR_PATH_NOT_FOUND) throw Failure("PROJECT_FILE_CHANGED", "Directory entry changed.");
              if (std::string(error.code) != "PROJECT_FILE_FORBIDDEN" && std::string(error.code) != "PROJECT_PATH_FORBIDDEN" &&
                  error.win32 != ERROR_ACCESS_DENIED && error.win32 != ERROR_SHARING_VIOLATION) throw;
              Check(napi_set_element(env, omitted, omissions++, WideText(env, name)));
            }
          } else Check(napi_set_element(env, omitted, omissions++, WideText(env, name)));
        }
        if (!entry->NextEntryOffset) break;
        if (entry->NextEntryOffset < offsetof(FILE_ID_BOTH_DIR_INFO, FileName) || offset + entry->NextEntryOffset <= offset) throw Failure("PROJECT_FILE_CHANGED", "Invalid directory response offset.");
        offset += entry->NextEntryOffset;
      }
    }
    cursor->assertUnchanged(); napi_value result, flag; Check(napi_create_object(env, &result)); Check(napi_get_boolean(env, truncated, &flag));
    Set(env, result, "entries", entries); Set(env, result, "truncated", flag); Set(env, result, "omittedNames", omitted);
    napi_value count, owned; Check(napi_create_uint32(env, scanned, &count)); Check(napi_get_boolean(env, sentinelSeen, &owned));
    Set(env, result, "scanned", count); Set(env, result, "ownedSentinelSeen", owned); return result;
  } catch (const std::exception& e) { return Throw(env, e); }
}

class LocalDescriptor {
 public:
  PSECURITY_DESCRIPTOR value = nullptr;
  ~LocalDescriptor() { if (value) LocalFree(value); }
};

void RequireMutation(Cursor& cursor) {
  cursor.assertUnchanged();
  if (!cursor.directory || !cursor.root->pin || (!cursor.parts.empty() && !cursor.sentinel.valid())) {
    throw Failure("PROJECT_FILE_WRITE_UNAVAILABLE", "Mutation requires a pinned directory binding.");
  }
}

void FlushDirectory(Cursor& cursor) {
  RequireMutation(cursor);
  FILE_ID_DESCRIPTOR descriptor{}; descriptor.dwSize = sizeof(descriptor); descriptor.Type = ExtendedFileIdType;
  std::copy(std::begin(cursor.directoryIdentity.id), std::end(cursor.directoryIdentity.id), std::begin(descriptor.ExtendedFileId.Identifier));
  Handle writable(OpenFileById(cursor.root->chain.handles.front().get(), &descriptor, GENERIC_WRITE | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, kDirectoryFlags | FILE_FLAG_WRITE_THROUGH));
  if (!writable.valid()) throw Failure("PROJECT_FILE_WRITE_UNAVAILABLE", "Cannot reopen the held directory for metadata flush.", GetLastError());
  if (!(DirectoryIdentity(writable.get()) == cursor.directoryIdentity)) throw Failure("PROJECT_FILE_CHANGED", "Directory changed before flush.");
  if (!FlushFileBuffers(writable.get())) throw Failure("PROJECT_FILE_WRITE_UNAVAILABLE", "Directory metadata flush failed.", GetLastError());
  cursor.assertUnchanged();
}

napi_value CursorFlush(napi_env env, napi_callback_info info) {
  try { FlushDirectory(*CursorReceiver(env, info, 0, 0)); napi_value result; Check(napi_get_boolean(env, true, &result)); return result; }
  catch (const std::exception& e) { return Throw(env, e); }
}

std::vector<unsigned char> BufferArgument(napi_env env, napi_value value) {
  bool isBuffer = false; Check(napi_is_buffer(env, value, &isBuffer)); if (!isBuffer) BadArguments();
  void* data = nullptr; size_t length = 0; Check(napi_get_buffer_info(env, value, &data, &length));
  if (length > 10 * 1024 * 1024) throw Failure("PROJECT_FILE_TOO_LARGE", "File publication is limited to 10 MiB.");
  std::vector<unsigned char> result; if (length) result.assign(static_cast<unsigned char*>(data), static_cast<unsigned char*>(data) + length); return result;
}

std::vector<unsigned char> ReadWhole(HANDLE handle, const FileFacts& expected) {
  if (expected.size > 10 * 1024 * 1024) throw Failure("PROJECT_FILE_TOO_LARGE", "File validation is limited to 10 MiB.");
  std::vector<unsigned char> bytes(static_cast<size_t>(expected.size)); LARGE_INTEGER zero{};
  if (!SetFilePointerEx(handle, zero, nullptr, FILE_BEGIN)) throw Failure("PROJECT_FILE_CONFLICT", "Cannot read the expected file.", GetLastError());
  size_t offset = 0;
  while (offset < bytes.size()) {
    DWORD count = 0; if (!ReadFile(handle, bytes.data() + offset, static_cast<DWORD>(bytes.size() - offset), &count, nullptr) || !count) {
      throw Failure("PROJECT_FILE_CONFLICT", "File changed while validating content.", GetLastError());
    }
    offset += count;
  }
  if (!(InspectFile(handle) == expected)) throw Failure("PROJECT_FILE_CONFLICT", "File changed while validating content.");
  return bytes;
}

bool MatchesIdentity(napi_env env, napi_value expected, const Identity& actual) {
  napi_valuetype type; Check(napi_typeof(env, expected, &type)); if (type != napi_object) BadArguments();
  std::string id; static constexpr char digits[] = "0123456789abcdef";
  for (unsigned char b : actual.id) { id.push_back(digits[b >> 4]); id.push_back(digits[b & 15]); }
  const std::pair<const char*, std::string> fields[] = {{"platform", "win32"}, {"volumeSerial", std::to_string(actual.volume)}, {"fileId", id}, {"creationTime", std::to_string(actual.created)}};
  for (const auto& field : fields) {
    napi_value value; Check(napi_get_named_property(env, expected, field.first, &value)); bool same = false;
    Check(napi_strict_equals(env, value, Text(env, field.second), &same)); if (!same) return false;
  }
  napi_value version; Check(napi_get_named_property(env, expected, "version", &version)); return BoundedNumber(env, version, 1) == 1;
}

void ApplyDacl(HANDLE target, PSECURITY_DESCRIPTOR security) {
  PACL dacl = nullptr; BOOL present = FALSE, defaulted = FALSE; SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision = 0;
  if (!GetSecurityDescriptorDacl(security, &present, &dacl, &defaulted) || !present || !dacl ||
      !GetSecurityDescriptorControl(security, &control, &revision)) throw Failure("PROJECT_FILE_WRITE_UNAVAILABLE", "Cannot preserve the file access policy.");
  const DWORD error = SetSecurityInfo(target, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION |
    ((control & SE_DACL_PROTECTED) ? PROTECTED_DACL_SECURITY_INFORMATION : UNPROTECTED_DACL_SECURITY_INFORMATION), nullptr, nullptr, dacl, nullptr);
  if (error != ERROR_SUCCESS) throw Failure("PROJECT_FILE_WRITE_UNAVAILABLE", "Cannot apply the file access policy.", error);
}

void CopyDacl(HANDLE source, HANDLE target) {
  LocalDescriptor security;
  DWORD error = GetSecurityInfo(source, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, nullptr, nullptr, &security.value);
  if (error != ERROR_SUCCESS) throw Failure("PROJECT_FILE_WRITE_UNAVAILABLE", "Cannot inspect the original file access policy.", error);
  ApplyDacl(target, security.value);
}

void InheritFileDacl(HANDLE parent, HANDLE target) {
  LocalDescriptor parentSecurity;
  DWORD error = GetSecurityInfo(parent, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    nullptr, nullptr, nullptr, nullptr, &parentSecurity.value);
  if (error != ERROR_SUCCESS) throw Failure("PROJECT_FILE_WRITE_UNAVAILABLE", "Cannot inspect parent access policy.", error);
  HANDLE tokenRaw = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tokenRaw)) throw Failure("PROJECT_FILE_WRITE_UNAVAILABLE", "Cannot inspect current file creator.", GetLastError());
  Handle token(tokenRaw); GENERIC_MAPPING mapping{FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS};
  PSECURITY_DESCRIPTOR inherited = nullptr;
  if (!CreatePrivateObjectSecurityEx(parentSecurity.value, nullptr, &inherited, nullptr, FALSE, SEF_DACL_AUTO_INHERIT, token.get(), &mapping)) {
    throw Failure("PROJECT_FILE_WRITE_UNAVAILABLE", "Cannot derive inherited file permissions.", GetLastError());
  }
  try { ApplyDacl(target, inherited); } catch (...) { DestroyPrivateObjectSecurity(&inherited); throw; }
  DestroyPrivateObjectSecurity(&inherited);
}

napi_value CursorPublish(napi_env env, napi_callback_info info) {
  Handle temporary; bool attempted = false, published = false;
  try {
    std::vector<napi_value> args; Cursor* parent = CursorReceiver(env, info, 3, 3, &args); RequireMutation(*parent);
    const auto names = RelativeArgument(env, args[0], false); if (names.size() != 1) BadArguments();
    const auto bytes = BufferArgument(env, args[1]); napi_valuetype type; Check(napi_typeof(env, args[2], &type)); if (type != napi_object) BadArguments();
    napi_value keys; Check(napi_get_all_property_names(env, args[2], napi_key_own_only, napi_key_all_properties, napi_key_numbers_to_strings, &keys));
    uint32_t count = 0; Check(napi_get_array_length(env, keys, &count)); if (count < 1 || count > 4) BadArguments();
    for (uint32_t i = 0; i < count; ++i) {
      napi_value key; Check(napi_get_element(env, keys, i, &key)); bool allowed = false;
      for (const char* name : {"operation", "expectedIdentity", "expectedBytes", "private"}) { bool same = false; Check(napi_strict_equals(env, key, Text(env, name), &same)); allowed |= same; }
      if (!allowed) BadArguments();
    }
    napi_value operation; Check(napi_get_named_property(env, args[2], "operation", &operation)); bool replace = false, create = false;
    Check(napi_strict_equals(env, operation, Text(env, "replace"), &replace)); Check(napi_strict_equals(env, operation, Text(env, "create"), &create));
    if (!replace && !create) BadArguments();
    bool isPrivate = false, hasPrivate = false; Check(napi_has_own_property(env, args[2], Text(env, "private"), &hasPrivate));
    if (hasPrivate) { napi_value value; Check(napi_get_named_property(env, args[2], "private", &value)); Check(napi_typeof(env, value, &type)); if (type != napi_boolean) BadArguments(); Check(napi_get_value_bool(env, value, &isPrivate)); }
    if (count != (replace ? 3u : 1u) + (hasPrivate ? 1u : 0u)) BadArguments();
    Handle original; FileFacts before; std::vector<unsigned char> expectedBytes;
    if (replace) {
      napi_value expectedIdentity, expectedContent; Check(napi_get_named_property(env, args[2], "expectedIdentity", &expectedIdentity)); Check(napi_get_named_property(env, args[2], "expectedBytes", &expectedContent));
      expectedBytes = BufferArgument(env, expectedContent);
      try { original = OpenRelative(parent->target.get(), names[0], FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL,
        FILE_SHARE_READ | FILE_SHARE_DELETE, 1, kNonDirectoryFile, 0, "PROJECT_FILE_CONFLICT"); before = InspectFile(original.get()); }
      catch (const Failure& error) { if (error.win32 == ERROR_FILE_NOT_FOUND || error.win32 == ERROR_PATH_NOT_FOUND) throw Failure("PROJECT_FILE_CONFLICT", "The original file is missing."); throw; }
      if (!MatchesIdentity(env, expectedIdentity, before.identity) || ReadWhole(original.get(), before) != expectedBytes) throw Failure("PROJECT_FILE_CONFLICT", "The file changed since it was read.");
      const DWORD allowedAttributes = FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_ARCHIVE | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED | FILE_ATTRIBUTE_NORMAL;
      if (before.attributes & ~allowedAttributes) throw Failure("PROJECT_FILE_WRITE_UNAVAILABLE", "The file has unsupported attributes for replacement.");
      if (before.attributes & FILE_ATTRIBUTE_READONLY) throw Failure("PROJECT_FILE_WRITE_UNAVAILABLE", "A read-only file cannot be replaced.");
    }
    const std::wstring tempName = L".hcc-file-write-" + SentinelName().substr(13);
    LocalDescriptor privateSecurity; privateSecurity.value = WindowsPrivateSecurityDescriptor();
    temporary = OpenRelative(parent->target.get(), tempName, GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL | WRITE_DAC,
      FILE_SHARE_READ, 2, kNonDirectoryFile | kWriteThrough, FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_TEMPORARY, "PROJECT_FILE_WRITE_UNAVAILABLE", privateSecurity.value);
    size_t offset = 0;
    while (offset < bytes.size()) {
      DWORD written = 0; if (!WriteFile(temporary.get(), bytes.data() + offset, static_cast<DWORD>(bytes.size() - offset), &written, nullptr) || !written) {
        throw Failure("PROJECT_FILE_WRITE_UNAVAILABLE", "Writing the temporary file failed.", GetLastError());
      }
      offset += written;
    }
    if (!isPrivate) { if (replace) CopyDacl(original.get(), temporary.get()); else InheritFileDacl(parent->target.get(), temporary.get()); }
    FILE_BASIC_INFO basic{}; basic.FileAttributes = replace ? before.attributes : FILE_ATTRIBUTE_NORMAL;
    if (!SetFileInformationByHandle(temporary.get(), FileBasicInfo, &basic, sizeof(basic)) || !FlushFileBuffers(temporary.get())) {
      throw Failure("PROJECT_FILE_WRITE_UNAVAILABLE", "Flushing the prepared file failed.", GetLastError());
    }
    if (ReadWhole(temporary.get(), InspectFile(temporary.get())) != bytes) throw Failure("PROJECT_FILE_CHANGED", "Prepared file bytes changed.");
    RequireMutation(*parent);
    if (replace) {
      Handle current = OpenRelative(parent->target.get(), names[0], FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        1, kNonDirectoryFile, 0, "PROJECT_FILE_CONFLICT");
      if (!(InspectFile(current.get()) == before) || ReadWhole(original.get(), before) != expectedBytes) throw Failure("PROJECT_FILE_CONFLICT", "The file changed before publication.");
    }
    const size_t filenameBytes = names[0].size() * sizeof(wchar_t);
    std::vector<unsigned char> renameBytes(offsetof(FILE_RENAME_INFO, FileName) + filenameBytes + sizeof(wchar_t), 0);
    // POSIX replacement permits the old identity to remain held for byte and
    // identity validation while the new name is published atomically.
    auto* rename = reinterpret_cast<FILE_RENAME_INFO*>(renameBytes.data()); rename->Flags = replace ? 0x00000003 : 0;
    rename->RootDirectory = parent->target.get(); rename->FileNameLength = static_cast<DWORD>(filenameBytes); memcpy(rename->FileName, names[0].data(), filenameBytes);
    using SetInformationFunction = NTSTATUS(NTAPI*)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
    using StatusErrorFunction = ULONG(WINAPI*)(NTSTATUS);
    auto setInformation = reinterpret_cast<SetInformationFunction>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtSetInformationFile"));
    auto statusError = reinterpret_cast<StatusErrorFunction>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlNtStatusToDosError"));
    if (!setInformation || !statusError) throw Failure("WINDOWS_NATIVE_UNAVAILABLE", "Handle-relative rename is unavailable.");
    IO_STATUS_BLOCK renameStatus{}; attempted = true;
    const NTSTATUS status = setInformation(temporary.get(), &renameStatus, rename, static_cast<ULONG>(renameBytes.size()), static_cast<FILE_INFORMATION_CLASS>(65));
    if (status < 0) {
      const DWORD error = statusError(status);
      if (!replace && (error == ERROR_ALREADY_EXISTS || error == ERROR_FILE_EXISTS)) { attempted = false; throw Failure("PROJECT_FILE_EXISTS", "A file already exists at this path.", error); }
      throw Failure("PROJECT_FILE_WRITE_UNCONFIRMED", "Publication could not be confirmed.", error);
    }
    published = true;
    const FileFacts final = InspectFile(temporary.get());
    Handle visible = OpenRelative(parent->target.get(), names[0], FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, 1, kNonDirectoryFile, 0, "PROJECT_FILE_WRITE_UNCONFIRMED");
    if (!(InspectFile(visible.get()) == final) || ReadWhole(temporary.get(), final) != bytes) throw Failure("PROJECT_FILE_WRITE_UNCONFIRMED", "Published bytes could not be confirmed.");
    FlushDirectory(*parent);
    napi_value result, flag; Check(napi_create_object(env, &result)); Check(napi_get_boolean(env, true, &flag));
    Set(env, result, "published", flag); Set(env, result, "size", Text(env, std::to_string(final.size)));
    Set(env, result, "identity", IdentityValue(env, final.identity)); return result;
  } catch (const std::exception& error) {
    if (temporary.valid() && !attempted && !published) { FILE_DISPOSITION_INFO remove{TRUE}; SetFileInformationByHandle(temporary.get(), FileDispositionInfo, &remove, sizeof(remove)); }
    if (attempted || published) {
      const auto* cause = dynamic_cast<const Failure*>(&error);
      Failure uncertain("PROJECT_FILE_WRITE_UNCONFIRMED", error.what(), cause ? cause->win32 : 0); return Throw(env, uncertain);
    }
    return Throw(env, error);
  }
}

napi_value CursorRenameFile(napi_env env, napi_callback_info info) {
  bool attempted = false;
  try {
    std::vector<napi_value> args; Cursor* parent = CursorReceiver(env, info, 3, 3, &args); RequireMutation(*parent);
    const auto source = RelativeArgument(env, args[0], false), destination = RelativeArgument(env, args[1], false);
    if (source.size() != 1 || destination.size() != 1 || CompareStringOrdinal(source[0].data(), static_cast<int>(source[0].size()),
      destination[0].data(), static_cast<int>(destination[0].size()), TRUE) == CSTR_EQUAL) BadArguments();
    napi_valuetype type; Check(napi_typeof(env, args[2], &type)); if (type != napi_object) BadArguments();
    napi_value keys, expected; Check(napi_get_all_property_names(env, args[2], napi_key_own_only, napi_key_all_properties, napi_key_numbers_to_strings, &keys));
    uint32_t count = 0; Check(napi_get_array_length(env, keys, &count)); if (count != 1) BadArguments();
    bool hasIdentity = false; Check(napi_has_own_property(env, args[2], Text(env, "expectedIdentity"), &hasIdentity)); if (!hasIdentity) BadArguments();
    Check(napi_get_named_property(env, args[2], "expectedIdentity", &expected));
    Handle file = OpenRelative(parent->target.get(), source[0], DELETE | FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ, 1, kNonDirectoryFile, 0, "PROJECT_FILE_FORBIDDEN");
    const FileFacts before = InspectFile(file.get());
    if (!MatchesIdentity(env, expected, before.identity)) throw Failure("PROJECT_FILE_CONFLICT", "The file changed before rename.");
    if (before.attributes & FILE_ATTRIBUTE_READONLY) throw Failure("PROJECT_FILE_WRITE_UNAVAILABLE", "A read-only file cannot be renamed.");
    RequireMutation(*parent);
    const size_t filenameBytes = destination[0].size() * sizeof(wchar_t);
    std::vector<unsigned char> storage(offsetof(FILE_RENAME_INFO, FileName) + filenameBytes + sizeof(wchar_t), 0);
    auto* rename = reinterpret_cast<FILE_RENAME_INFO*>(storage.data()); rename->Flags = 0;
    rename->RootDirectory = parent->target.get(); rename->FileNameLength = static_cast<DWORD>(filenameBytes);
    memcpy(rename->FileName, destination[0].data(), filenameBytes);
    using SetInformationFunction = NTSTATUS(NTAPI*)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
    using StatusErrorFunction = ULONG(WINAPI*)(NTSTATUS);
    auto setInformation = reinterpret_cast<SetInformationFunction>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtSetInformationFile"));
    auto statusError = reinterpret_cast<StatusErrorFunction>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlNtStatusToDosError"));
    if (!setInformation || !statusError) throw Failure("WINDOWS_NATIVE_UNAVAILABLE", "Handle-relative rename is unavailable.");
    IO_STATUS_BLOCK statusBlock{}; attempted = true;
    const NTSTATUS status = setInformation(file.get(), &statusBlock, rename, static_cast<ULONG>(storage.size()), static_cast<FILE_INFORMATION_CLASS>(65));
    if (status < 0) {
      const DWORD error = statusError(status);
      if (error == ERROR_ALREADY_EXISTS || error == ERROR_FILE_EXISTS) { attempted = false; throw Failure("PROJECT_FILE_EXISTS", "A file already exists at the rename destination.", error); }
      throw Failure("PROJECT_FILE_WRITE_UNCONFIRMED", "File rename could not be confirmed.", error);
    }
    Handle visible = OpenRelative(parent->target.get(), destination[0], FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, 1, kNonDirectoryFile, 0, "PROJECT_FILE_WRITE_UNCONFIRMED");
    if (!(InspectFile(visible.get()).identity == before.identity) || !(InspectFile(file.get()).identity == before.identity)) {
      throw Failure("PROJECT_FILE_WRITE_UNCONFIRMED", "The renamed identity could not be confirmed.");
    }
    FlushDirectory(*parent);
    napi_value result, flag; Check(napi_create_object(env, &result)); Check(napi_get_boolean(env, true, &flag)); Set(env, result, "renamed", flag); return result;
  } catch (const std::exception& error) {
    if (attempted) {
      const auto* cause = dynamic_cast<const Failure*>(&error);
      Failure uncertain("PROJECT_FILE_WRITE_UNCONFIRMED", error.what(), cause ? cause->win32 : 0); return Throw(env, uncertain);
    }
    return Throw(env, error);
  }
}

napi_value CursorRemoveFile(napi_env env, napi_callback_info info) {
  bool attempted = false;
  try {
    std::vector<napi_value> args; Cursor* parent = CursorReceiver(env, info, 2, 2, &args); RequireMutation(*parent);
    const auto names = RelativeArgument(env, args[0], false); if (names.size() != 1) BadArguments();
    napi_valuetype type; Check(napi_typeof(env, args[1], &type)); if (type != napi_object) BadArguments();
    napi_value keys; Check(napi_get_all_property_names(env, args[1], napi_key_own_only, napi_key_all_properties, napi_key_numbers_to_strings, &keys));
    uint32_t count = 0; Check(napi_get_array_length(env, keys, &count)); if (count < 1 || count > 2) BadArguments();
    bool hasIdentity = false, hasBytes = false;
    Check(napi_has_own_property(env, args[1], Text(env, "expectedIdentity"), &hasIdentity));
    Check(napi_has_own_property(env, args[1], Text(env, "expectedBytes"), &hasBytes));
    if (!hasIdentity || count != (hasBytes ? 2u : 1u)) BadArguments();
    napi_value expectedIdentity; Check(napi_get_named_property(env, args[1], "expectedIdentity", &expectedIdentity));
    std::vector<unsigned char> expectedBytes;
    if (hasBytes) { napi_value value; Check(napi_get_named_property(env, args[1], "expectedBytes", &value)); expectedBytes = BufferArgument(env, value); }
    Handle file = OpenRelative(parent->target.get(), names[0], DELETE | FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ, 1, kNonDirectoryFile, 0, "PROJECT_FILE_FORBIDDEN");
    const FileFacts before = InspectFile(file.get());
    if (!MatchesIdentity(env, expectedIdentity, before.identity) || (hasBytes && ReadWhole(file.get(), before) != expectedBytes)) {
      throw Failure("PROJECT_FILE_CONFLICT", "The file changed before removal.");
    }
    if (before.attributes & FILE_ATTRIBUTE_READONLY) throw Failure("PROJECT_FILE_WRITE_UNAVAILABLE", "A read-only file cannot be removed.");
    RequireMutation(*parent);
    if (!(InspectFile(file.get()) == before)) throw Failure("PROJECT_FILE_CONFLICT", "The file changed before removal.");
    FILE_DISPOSITION_INFO remove{TRUE}; attempted = true;
    if (!SetFileInformationByHandle(file.get(), FileDispositionInfo, &remove, sizeof(remove))) {
      throw Failure("PROJECT_FILE_WRITE_UNCONFIRMED", "File removal could not be confirmed.", GetLastError());
    }
    file.close();
    try {
      Handle visible = OpenRelative(parent->target.get(), names[0], FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, 1, kNonDirectoryFile, 0, "PROJECT_FILE_WRITE_UNCONFIRMED");
      throw Failure("PROJECT_FILE_WRITE_UNCONFIRMED", "The removed name is still present.");
    } catch (const Failure& error) { if (error.win32 != ERROR_FILE_NOT_FOUND && error.win32 != ERROR_PATH_NOT_FOUND) throw; }
    FlushDirectory(*parent);
    napi_value result, flag; Check(napi_create_object(env, &result)); Check(napi_get_boolean(env, true, &flag)); Set(env, result, "removed", flag); return result;
  } catch (const std::exception& error) {
    if (attempted) {
      const auto* cause = dynamic_cast<const Failure*>(&error);
      Failure uncertain("PROJECT_FILE_WRITE_UNCONFIRMED", error.what(), cause ? cause->win32 : 0); return Throw(env, uncertain);
    }
    return Throw(env, error);
  }
}

napi_value CursorObject(napi_env env, std::unique_ptr<Cursor> cursor);
napi_value CursorOpenAppendFile(napi_env env, napi_callback_info info) {
  try {
    std::vector<napi_value> args; Cursor* parent = CursorReceiver(env, info, 2, 2, &args); RequireMutation(*parent);
    const auto names = RelativeArgument(env, args[0], false); if (names.size() != 1) BadArguments();
    napi_valuetype type; Check(napi_typeof(env, args[1], &type)); if (type != napi_object) BadArguments();
    napi_value keys, setting; Check(napi_get_all_property_names(env, args[1], napi_key_own_only, napi_key_all_properties, napi_key_numbers_to_strings, &keys));
    uint32_t count = 0; Check(napi_get_array_length(env, keys, &count)); if (count != 1) BadArguments();
    Check(napi_get_named_property(env, args[1], "private", &setting)); Check(napi_typeof(env, setting, &type)); if (type != napi_boolean) BadArguments();
    bool isPrivate = false; Check(napi_get_value_bool(env, setting, &isPrivate)); if (!isPrivate) BadArguments();
    LocalDescriptor security; security.value = WindowsPrivateSecurityDescriptor();
    Handle file = OpenRelative(parent->target.get(), names[0], FILE_APPEND_DATA | FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE, 3, kNonDirectoryFile | kWriteThrough, FILE_ATTRIBUTE_NORMAL, "PROJECT_FILE_FORBIDDEN", security.value);
    const FileFacts facts = InspectFile(file.get());
    napi_value inspected = WindowsSecurityForHandle(env, file.get()); if (!inspected) return nullptr;
    napi_value safe; Check(napi_get_named_property(env, inspected, "private", &safe)); Check(napi_get_value_bool(env, safe, &isPrivate));
    if (!isPrivate) throw Failure("WINDOWS_STATE_PERMISSIONS", "Append logs require a private file owned by the current user.");
    auto cursor = std::make_unique<Cursor>(); cursor->root = Retain(*parent->root);
    cursor->parts = parent->parts; cursor->parts.push_back(names[0]); cursor->actual = parent->actual;
    cursor->canonical = CanonicalPath(file.get()); cursor->actual.push_back(cursor->canonical.substr(cursor->canonical.find_last_of(L'\\') + 1));
    cursor->parentIdentities = parent->parentIdentities;
    for (const Handle& ancestor : parent->parents) cursor->parents.push_back(Duplicate(ancestor.get()));
    if (!parent->parts.empty()) { cursor->parents.push_back(Duplicate(parent->target.get())); cursor->parentIdentities.push_back(parent->directoryIdentity); }
    cursor->target = std::move(file); cursor->file = facts; cursor->mutableFile = true; cursor->appendFile = true;
    FlushDirectory(*parent); cursor->assertUnchanged(); return CursorObject(env, std::move(cursor));
  } catch (const std::exception& error) { return Throw(env, error); }
}

napi_value CursorWrite(napi_env env, napi_callback_info info) {
  try {
    std::vector<napi_value> args; Cursor* cursor = CursorReceiver(env, info, 1, 1, &args); cursor->assertUnchanged();
    if (!cursor->appendFile) BadArguments(); const auto bytes = BufferArgument(env, args[0]);
    size_t offset = 0;
    while (offset < bytes.size()) {
      DWORD written = 0;
      if (!WriteFile(cursor->target.get(), bytes.data() + offset, static_cast<DWORD>(bytes.size() - offset), &written, nullptr) || !written) {
        throw Failure("WINDOWS_LOG_WRITE_FAILED", "Appending the private log failed.", GetLastError());
      }
      offset += written;
    }
    cursor->assertUnchanged(); napi_value result; Check(napi_create_uint32(env, static_cast<uint32_t>(offset), &result)); return result;
  } catch (const std::exception& error) { return Throw(env, error); }
}

napi_value CursorCreateDirectory(napi_env env, napi_callback_info info) {
  bool created = false;
  try {
    std::vector<napi_value> args; Cursor* parent = CursorReceiver(env, info, 1, 2, &args); RequireMutation(*parent);
    const auto names = RelativeArgument(env, args[0], false); if (names.size() != 1) BadArguments();
    if (args.size() == 2) {
      napi_valuetype type; Check(napi_typeof(env, args[1], &type)); if (type != napi_object) BadArguments();
      napi_value keys, setting; Check(napi_get_all_property_names(env, args[1], napi_key_own_only, napi_key_all_properties, napi_key_numbers_to_strings, &keys));
      uint32_t count = 0; Check(napi_get_array_length(env, keys, &count)); if (count != 1) BadArguments();
      Check(napi_get_named_property(env, args[1], "private", &setting)); Check(napi_typeof(env, setting, &type)); if (type != napi_boolean) BadArguments();
      bool value = false; Check(napi_get_value_bool(env, setting, &value)); if (!value) BadArguments();
    }
    LocalDescriptor security; security.value = WindowsPrivateSecurityDescriptor(); Handle directory;
    try { directory = OpenRelative(parent->target.get(), names[0], FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE, 2, kDirectoryFile | kWriteThrough, FILE_ATTRIBUTE_DIRECTORY, "PROJECT_FILE_WRITE_UNAVAILABLE", security.value); }
    catch (const Failure& error) { if (error.win32 == ERROR_ALREADY_EXISTS || error.win32 == ERROR_FILE_EXISTS) throw Failure("PROJECT_FILE_EXISTS", "The directory already exists.", error.win32); throw; }
    created = true; DirectoryIdentity(directory.get()); FlushDirectory(*parent);
    auto parts = parent->parts; parts.push_back(names[0]);
    return CursorObject(env, OpenCursor(*parent->root, std::move(parts), true));
  } catch (const std::exception& error) {
    if (created) {
      const auto* cause = dynamic_cast<const Failure*>(&error);
      Failure uncertain("PROJECT_FILE_WRITE_UNCONFIRMED", error.what(), cause ? cause->win32 : 0); return Throw(env, uncertain);
    }
    return Throw(env, error);
  }
}

napi_value CursorSecurity(napi_env env, napi_callback_info info) {
  try { Cursor* cursor = CursorReceiver(env, info, 0, 0); cursor->assertUnchanged(); napi_value result = WindowsSecurityForHandle(env, cursor->target.get()); cursor->assertUnchanged(); return result; }
  catch (const std::exception& e) { return Throw(env, e); }
}
napi_value LeaseSecurity(napi_env env, napi_callback_info info) {
  try { Lease* lease = Receiver(env, info); lease->assertUnchanged(); napi_value result = WindowsSecurityForHandle(env, lease->chain.handles.back().get()); lease->assertUnchanged(); return result; }
  catch (const std::exception& e) { return Throw(env, e); }
}

napi_value CursorObject(napi_env env, std::unique_ptr<Cursor> cursor);
napi_value OpenFromLease(napi_env env, napi_callback_info info, bool directory, bool mutableFile = false) {
  try {
    napi_value receiver; const auto args = Arguments(env, info, 1, 1, &receiver); bool matches = false;
    Check(napi_check_object_type_tag(env, receiver, &kLeaseTag, &matches)); if (!matches) BadArguments();
    Lease* lease = nullptr; Check(napi_unwrap(env, receiver, reinterpret_cast<void**>(&lease))); if (!lease) BadArguments();
    return CursorObject(env, OpenCursor(*lease, RelativeArgument(env, args[0], directory), directory, mutableFile));
  } catch (const std::exception& e) { return Throw(env, e); }
}
napi_value LeaseOpenFile(napi_env env, napi_callback_info info) { return OpenFromLease(env, info, false); }
napi_value LeaseOpenDirectory(napi_env env, napi_callback_info info) { return OpenFromLease(env, info, true); }
napi_value LeaseOpenMutableFile(napi_env env, napi_callback_info info) { return OpenFromLease(env, info, false, true); }
napi_value OpenFromCursor(napi_env env, napi_callback_info info, bool directory, bool mutableFile = false, bool publishSource = false) {
  try {
    std::vector<napi_value> args; Cursor* cursor = CursorReceiver(env, info, 1, 1, &args); cursor->assertUnchanged(); if (!cursor->directory) BadArguments();
    auto parts = cursor->parts; auto extra = RelativeArgument(env, args[0], directory); parts.insert(parts.end(), extra.begin(), extra.end());
    if (directory && extra.empty()) return CursorObject(env, RetainCursor(*cursor));
    if (parts.size() > 128) BadArguments(); return CursorObject(env, OpenCursor(*cursor->root, std::move(parts), directory, mutableFile, publishSource));
  } catch (const std::exception& e) { return Throw(env, e); }
}
napi_value CursorOpenFile(napi_env env, napi_callback_info info) { return OpenFromCursor(env, info, false); }
napi_value CursorOpenDirectory(napi_env env, napi_callback_info info) { return OpenFromCursor(env, info, true); }
napi_value CursorOpenMutableFile(napi_env env, napi_callback_info info) { return OpenFromCursor(env, info, false, true); }
napi_value CursorOpenPublishSource(napi_env env, napi_callback_info info) { return OpenFromCursor(env, info, false, false, true); }
void FinalizeCursor(napi_env, void* data, void*) { delete static_cast<Cursor*>(data); }
napi_value CursorObject(napi_env env, std::unique_ptr<Cursor> cursor) {
  napi_value result; Check(napi_create_object(env, &result));
  const napi_property_descriptor properties[] = {
    {"snapshot", nullptr, CursorSnapshot, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"assertUnchanged", nullptr, CursorAssert, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, CursorClose, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"read", nullptr, CursorRead, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"list", nullptr, CursorList, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"security", nullptr, CursorSecurity, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"flush", nullptr, CursorFlush, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"publish", nullptr, CursorPublish, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"removeFile", nullptr, CursorRemoveFile, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"renameFile", nullptr, CursorRenameFile, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"openAppendFile", nullptr, CursorOpenAppendFile, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"write", nullptr, CursorWrite, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"createDirectory", nullptr, CursorCreateDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"openFile", nullptr, CursorOpenFile, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"openMutableFile", nullptr, CursorOpenMutableFile, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"openPublishSource", nullptr, CursorOpenPublishSource, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"openDirectory", nullptr, CursorOpenDirectory, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  Check(napi_define_properties(env, result, std::size(properties), properties)); Check(napi_type_tag_object(env, result, &kCursorTag));
  Check(napi_wrap(env, result, cursor.get(), FinalizeCursor, nullptr, nullptr)); cursor.release(); return result;
}
napi_value LeaseSnapshot(napi_env env, napi_callback_info info) {
  try { return Snapshot(env, *Receiver(env, info)); } catch (const std::exception& e) { return Throw(env, e); }
}
napi_value LeaseAssert(napi_env env, napi_callback_info info) {
  try { Receiver(env, info)->assertUnchanged(); napi_value result; Check(napi_get_boolean(env, true, &result)); return result; } catch (const std::exception& e) { return Throw(env, e); }
}
napi_value LeaseClose(napi_env env, napi_callback_info info) {
  try { Receiver(env, info)->close(); napi_value result; Check(napi_get_undefined(env, &result)); return result; } catch (const std::exception& e) { return Throw(env, e); }
}
void Finalize(napi_env, void* data, void*) { delete static_cast<Lease*>(data); }

std::unique_ptr<Lease> Capture(napi_env env, const std::vector<napi_value>& args, bool inspect) {
  auto lease = std::make_unique<Lease>(); lease->requested = PathArgument(env, args[0]);
  lease->pin = !inspect && (args.size() == 1 || PinArgument(env, args[1]));
  lease->chain = OpenChain(lease->requested, lease->pin);
  if (lease->pin) {
    lease->sentinelName = SentinelName();
    lease->sentinel = OpenRelative(lease->chain.handles.back().get(), lease->sentinelName, GENERIC_READ | GENERIC_WRITE | DELETE,
      FILE_SHARE_READ, 2, kNonDirectoryFile | kDeleteOnClose, FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_TEMPORARY,
      "WINDOWS_DIRECTORY_PIN_UNAVAILABLE");
  }
  lease->assertUnchanged(); return lease;
}
napi_value CaptureDirectory(napi_env env, napi_callback_info info) {
  try {
    auto lease = Capture(env, Arguments(env, info, 1, 2), false);
    napi_value result; Check(napi_create_object(env, &result));
    const napi_property_descriptor properties[] = {
      {"snapshot", nullptr, LeaseSnapshot, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"assertUnchanged", nullptr, LeaseAssert, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, LeaseClose, nullptr, nullptr, nullptr, napi_default, nullptr}
      ,{"security", nullptr, LeaseSecurity, nullptr, nullptr, nullptr, napi_default, nullptr}
      ,{"openFile", nullptr, LeaseOpenFile, nullptr, nullptr, nullptr, napi_default, nullptr}
      ,{"openMutableFile", nullptr, LeaseOpenMutableFile, nullptr, nullptr, nullptr, napi_default, nullptr}
      ,{"openDirectory", nullptr, LeaseOpenDirectory, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    Check(napi_define_properties(env, result, std::size(properties), properties)); Check(napi_type_tag_object(env, result, &kLeaseTag));
    Check(napi_wrap(env, result, lease.get(), Finalize, nullptr, nullptr)); lease.release(); return result;
  } catch (const std::exception& e) { return Throw(env, e); }
}
napi_value InspectDirectory(napi_env env, napi_callback_info info) {
  try { auto lease = Capture(env, Arguments(env, info, 1, 1), true); return Snapshot(env, *lease); } catch (const std::exception& e) { return Throw(env, e); }
}
}  // namespace

std::wstring WindowsPathArgument(napi_env env, napi_value value) {
  return PathArgument(env, value);
}

std::shared_ptr<WindowsProcessDirectoryLease> WindowsRetainDirectoryForProcess(napi_env env, napi_value value) {
  napi_valuetype type; Check(napi_typeof(env, value, &type)); if (type != napi_object) BadArguments();
  bool matches = false; Check(napi_check_object_type_tag(env, value, &kLeaseTag, &matches)); if (!matches) BadArguments();
  Lease* lease = nullptr; Check(napi_unwrap(env, value, reinterpret_cast<void**>(&lease)));
  if (!lease || !lease->pin) throw Failure("PINNED_CWD_UNAVAILABLE", "A pinned directory lease is required for process admission.");
  return std::make_shared<ProcessDirectoryLease>(Retain(*lease));
}

std::shared_ptr<WindowsProcessAppendLease> WindowsRetainAppendForProcess(napi_env env, napi_value value) {
  napi_valuetype type; Check(napi_typeof(env, value, &type)); if (type != napi_object) BadArguments();
  bool matches = false; Check(napi_check_object_type_tag(env, value, &kCursorTag, &matches)); if (!matches) BadArguments();
  Cursor* cursor = nullptr; Check(napi_unwrap(env, value, reinterpret_cast<void**>(&cursor)));
  if (!cursor || !cursor->appendFile || !cursor->root->pin) throw Failure("WINDOWS_LOG_UNAVAILABLE", "A private append resource is required.");
  return std::make_shared<ProcessAppendLease>(RetainCursor(*cursor));
}

void WindowsWithPinnedDirectory(napi_env env, napi_value value,
  const std::function<void(HANDLE, const std::function<void()>&)>& visitor) {
  napi_valuetype type; Check(napi_typeof(env, value, &type)); if (type != napi_object) BadArguments();
  bool matches = false; Check(napi_check_object_type_tag(env, value, &kCursorTag, &matches)); if (!matches) BadArguments();
  Cursor* cursor = nullptr; Check(napi_unwrap(env, value, reinterpret_cast<void**>(&cursor))); if (!cursor) BadArguments();
  RequireMutation(*cursor);
  visitor(cursor->target.get(), [&] { FlushDirectory(*cursor); });
  cursor->assertUnchanged();
}

void WindowsInspectDirectoryChain(const std::wstring& path, const std::function<void(HANDLE, bool)>& visitor) {
  Chain chain = OpenChain(path, false);
  for (size_t i = 0; i < chain.handles.size(); ++i) visitor(chain.handles[i].get(), i + 1 == chain.handles.size());
  for (size_t i = 0; i < chain.handles.size(); ++i) {
    if (!(DirectoryIdentity(chain.handles[i].get()) == chain.identities[i])) {
      throw Failure("PROJECT_PATH_CHANGED", "The inspected directory chain changed.");
    }
  }
}

napi_value RegisterFilesystem(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    {"captureDirectory", nullptr, CaptureDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"inspectDirectory", nullptr, InspectDirectory, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  Check(napi_define_properties(env, exports, std::size(properties), properties)); return exports;
}
