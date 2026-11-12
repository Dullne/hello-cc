#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <node_api.h>
#include <string>
#include <vector>
#include <stdexcept>
#include "security.h"
#include "filesystem.h"

namespace {
struct WinFailure : std::runtime_error {
  const char* code;
  WinFailure(const char* value, const char* message) : std::runtime_error(message), code(value) {}
};
void Check(napi_status status) {
  if (status != napi_ok) throw WinFailure("WINDOWS_NATIVE_ERROR", "Node-API operation failed");
}
class Handle {
 public:
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value != INVALID_HANDLE_VALUE && value != nullptr) CloseHandle(value); }
};
class Local {
 public:
  HLOCAL value = nullptr;
  ~Local() { if (value) LocalFree(value); }
};
napi_value String(napi_env env, const std::wstring& text) {
  napi_value result;
  Check(napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(text.data()), text.size(), &result));
  return result;
}
void Bool(napi_env env, napi_value result, const char* name, bool value) {
  napi_value boolean;
  Check(napi_get_boolean(env, value, &boolean));
  Check(napi_set_named_property(env, result, name, boolean));
}
std::wstring Path(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  Check(napi_get_cb_info(env, info, &argc, nullptr, nullptr, nullptr));
  if (argc != 1) throw WinFailure("WINDOWS_PATH_INVALID", "Exactly one Windows path is required");
  napi_value arg;
  Check(napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr));
  try { return WindowsPathArgument(env, arg); }
  catch (const std::exception&) { throw WinFailure("WINDOWS_PATH_INVALID", "An unambiguous absolute local Windows path is required"); }
}
std::vector<BYTE> UserToken() {
  Handle token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value)) {
    throw WinFailure("WINDOWS_SECURITY_UNAVAILABLE", "Cannot inspect the current Windows identity");
  }
  DWORD size = 0;
  GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
  if (size == 0 || size > 65536) throw WinFailure("WINDOWS_SECURITY_UNAVAILABLE", "Invalid Windows identity size");
  std::vector<BYTE> bytes(size);
  if (!GetTokenInformation(token.value, TokenUser, bytes.data(), size, &size)) {
    throw WinFailure("WINDOWS_SECURITY_UNAVAILABLE", "Cannot read the current Windows identity");
  }
  return bytes;
}
std::wstring SidText(PSID sid) {
  LPWSTR text = nullptr;
  if (!sid || !IsValidSid(sid) || !ConvertSidToStringSidW(sid, &text)) {
    throw WinFailure("WINDOWS_SECURITY_UNAVAILABLE", "Cannot encode Windows ownership");
  }
  Local owned;
  owned.value = text;
  return std::wstring(text);
}
bool TrustedSid(PSID sid, PSID user) {
  return IsValidSid(sid) && (EqualSid(sid, user) || IsWellKnownSid(sid, WinLocalSystemSid) ||
    IsWellKnownSid(sid, WinBuiltinAdministratorsSid));
}
napi_value InspectHandle(napi_env env, HANDLE handle) {
  try {
    FILE_ATTRIBUTE_TAG_INFO attributes{};
    if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &attributes, sizeof(attributes))) {
      throw WinFailure("WINDOWS_SECURITY_UNAVAILABLE", "Cannot inspect path attributes");
    }
    if (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
      throw WinFailure("WINDOWS_REPARSE_FORBIDDEN", "Reparse points cannot hold private HCC state");
    }
    PSID owner = nullptr;
    PACL dacl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    const DWORD error = GetSecurityInfo(handle, SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &dacl, nullptr, &descriptor);
    Local owned;
    owned.value = descriptor;
    if (error != ERROR_SUCCESS) throw WinFailure("WINDOWS_SECURITY_UNAVAILABLE", "Cannot read path security");
    auto token = UserToken();
    const PSID user = reinterpret_cast<TOKEN_USER*>(token.data())->User.Sid;
    bool safe = owner && IsValidSid(owner) && EqualSid(owner, user) && dacl && IsValidAcl(dacl);
    bool userGranted = false;
    if (dacl && IsValidAcl(dacl)) {
      for (DWORD index = 0; index < dacl->AceCount; ++index) {
        void* raw = nullptr;
        if (!GetAce(dacl, index, &raw)) { safe = false; break; }
        const auto header = static_cast<ACE_HEADER*>(raw);
        // Deny ACEs do not broaden access. Unknown/object/callback grants are
        // conservatively refused instead of guessing their effective rights.
        if (header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
        if (header->AceType != ACCESS_ALLOWED_ACE_TYPE ||
            header->AceSize < sizeof(ACCESS_ALLOWED_ACE)) { safe = false; continue; }
        const auto ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
        PSID granted = const_cast<DWORD*>(&ace->SidStart);
        if (!TrustedSid(granted, user)) safe = false;
        if ((header->AceFlags & INHERIT_ONLY_ACE) == 0 && IsValidSid(granted) && EqualSid(granted, user) &&
            (ace->Mask & (FILE_READ_DATA | FILE_WRITE_DATA | GENERIC_ALL)) != 0) userGranted = true;
      }
    }
    SECURITY_DESCRIPTOR_CONTROL control{};
    DWORD revision = 0;
    if (!GetSecurityDescriptorControl(descriptor, &control, &revision)) {
      throw WinFailure("WINDOWS_SECURITY_UNAVAILABLE", "Cannot inspect security inheritance");
    }
    napi_value result;
    Check(napi_create_object(env, &result));
    Bool(env, result, "private", safe && userGranted);
    Bool(env, result, "protectedDacl", (control & SE_DACL_PROTECTED) != 0);
    Check(napi_set_named_property(env, result, "ownerSid", String(env, SidText(owner))));
    Check(napi_set_named_property(env, result, "userSid", String(env, SidText(user))));
    return result;
  } catch (const WinFailure& error) { napi_throw_error(env, error.code, error.what()); return nullptr; }
    catch (const std::exception&) { napi_throw_error(env, "WINDOWS_SECURITY_UNAVAILABLE", "Cannot inspect Windows security"); return nullptr; }
}
napi_value Inspect(napi_env env, napi_callback_info info) {
  try {
    const auto name = Path(env, info);
    Handle handle;
    handle.value = CreateFileW(name.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (handle.value == INVALID_HANDLE_VALUE) throw WinFailure("WINDOWS_SECURITY_UNAVAILABLE", "Cannot open path security");
    return InspectHandle(env, handle.value);
  } catch (const WinFailure& error) { napi_throw_error(env, error.code, error.what()); return nullptr; }
    catch (const std::exception&) { napi_throw_error(env, "WINDOWS_SECURITY_UNAVAILABLE", "Cannot inspect Windows security"); return nullptr; }
}

bool AncestorTrusted(HANDLE handle, PSID user, PSID installer) {
  PSID owner = nullptr; PACL dacl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr;
  const DWORD error = GetSecurityInfo(handle, SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &dacl, nullptr, &descriptor);
  Local owned; owned.value = descriptor;
  if (error != ERROR_SUCCESS || !owner || !dacl || !IsValidSid(owner) || !IsValidAcl(dacl)) return false;
  const auto trusted = [&](PSID sid) {
    return TrustedSid(sid, user) || (installer && IsValidSid(sid) && EqualSid(sid, installer));
  };
  if (!trusted(owner)) return false;
  for (DWORD index = 0; index < dacl->AceCount; ++index) {
    void* raw = nullptr;
    if (!GetAce(dacl, index, &raw)) return false;
    const auto header = static_cast<ACE_HEADER*>(raw);
    // Inherit-only rights apply to children; each existing child is inspected
    // separately. Directory creation alone cannot replace a retained child.
    if ((header->AceFlags & INHERIT_ONLY_ACE) || header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE || header->AceSize < sizeof(ACCESS_ALLOWED_ACE)) return false;
    const auto ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
    if (trusted(const_cast<DWORD*>(&ace->SidStart))) continue;
    DWORD mask = ace->Mask;
    GENERIC_MAPPING mapping{FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS};
    MapGenericMask(&mask, &mapping);
    constexpr DWORD mutation = FILE_WRITE_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES |
      FILE_DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER;
    if (mask & mutation) return false;
  }
  return true;
}

napi_value Ancestry(napi_env env, napi_callback_info info) {
  try {
    const auto name = Path(env, info);
    auto token = UserToken();
    const auto user = reinterpret_cast<TOKEN_USER*>(token.data())->User.Sid;
    DWORD sidBytes = 0, domainChars = 0; SID_NAME_USE use{};
    LookupAccountNameW(nullptr, L"NT SERVICE\\TrustedInstaller", nullptr, &sidBytes, nullptr, &domainChars, &use);
    std::vector<BYTE> installer;
    std::vector<wchar_t> domain;
    if (sidBytes > 0 && sidBytes <= SECURITY_MAX_SID_SIZE && domainChars <= 4096) {
      installer.resize(sidBytes); domain.resize(domainChars + 1);
      if (!LookupAccountNameW(nullptr, L"NT SERVICE\\TrustedInstaller", installer.data(), &sidBytes,
          domain.data(), &domainChars, &use)) installer.clear();
    }
    bool safe = true; uint32_t count = 0;
    WindowsInspectDirectoryChain(name, [&](HANDLE handle, bool) {
      ++count;
      if (!AncestorTrusted(handle, user, installer.empty() ? nullptr : installer.data())) safe = false;
    });
    napi_value result, number;
    Check(napi_create_object(env, &result)); Bool(env, result, "trusted", safe);
    Check(napi_create_uint32(env, count, &number)); Check(napi_set_named_property(env, result, "checkedDirectories", number));
    return result;
  } catch (const WinFailure& error) { napi_throw_error(env, error.code, error.what()); return nullptr; }
    catch (const std::exception&) { napi_throw_error(env, "WINDOWS_SECURITY_UNAVAILABLE", "Cannot validate directory ancestry"); return nullptr; }
}
napi_value Create(napi_env env, napi_callback_info info) {
  try {
    const auto name = Path(env, info);
    if (name.size() <= 3) throw WinFailure("WINDOWS_PATH_INVALID", "A private directory cannot be a volume root");
    PSECURITY_DESCRIPTOR descriptor = WindowsPrivateSecurityDescriptor();
    Local owned;
    owned.value = descriptor;
    SECURITY_ATTRIBUTES security{ sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE };
    if (!CreateDirectoryW(name.c_str(), &security)) {
      const auto error = GetLastError();
      throw WinFailure(error == ERROR_ALREADY_EXISTS ? "WINDOWS_PATH_EXISTS" : "WINDOWS_SECURITY_UNAVAILABLE",
        "Cannot create private Windows directory");
    }
    napi_value result;
    Check(napi_get_undefined(env, &result));
    return result;
  } catch (const WinFailure& error) { napi_throw_error(env, error.code, error.what()); return nullptr; }
    catch (const std::exception&) { napi_throw_error(env, "WINDOWS_SECURITY_UNAVAILABLE", "Cannot create private Windows directory"); return nullptr; }
}
}
napi_value WindowsSecurityForHandle(napi_env env, HANDLE handle) { return InspectHandle(env, handle); }
PSECURITY_DESCRIPTOR WindowsPrivateSecurityDescriptor() {
  auto token = UserToken();
  const auto user = SidText(reinterpret_cast<TOKEN_USER*>(token.data())->User.Sid);
  const auto sddl = L"O:" + user + L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + user + L")";
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) {
    throw WinFailure("WINDOWS_SECURITY_UNAVAILABLE", "Cannot construct private Windows permissions");
  }
  return descriptor;
}
napi_value RegisterSecurity(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    { "inspectPathSecurity", nullptr, Inspect, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "createPrivateDirectory", nullptr, Create, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "inspectDirectoryAncestry", nullptr, Ancestry, nullptr, nullptr, nullptr, napi_default, nullptr }
  };
  Check(napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods));
  return exports;
}
