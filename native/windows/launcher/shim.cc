#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <string>
#include <vector>
#include <iostream>

namespace {
class Handle {
 public:
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value != INVALID_HANDLE_VALUE && value != nullptr) CloseHandle(value); }
};
std::wstring Quote(const std::wstring& argument) {
  std::wstring value = L"\""; size_t slashes = 0;
  for (wchar_t ch : argument) {
    if (ch == L'\\') { ++slashes; continue; }
    if (ch == L'"') { value.append(slashes * 2 + 1, L'\\'); value += ch; }
    else { value.append(slashes, L'\\'); value += ch; }
    slashes = 0;
  }
  value.append(slashes * 2, L'\\'); value += L'"'; return value;
}
std::wstring NodePath(const std::wstring& filename) {
  Handle file;
  file.value = CreateFileW(filename.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
    OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (file.value == INVALID_HANDLE_VALUE) throw "Cannot open the HCC launcher configuration";
  BY_HANDLE_FILE_INFORMATION info{}; LARGE_INTEGER size{};
  if (!GetFileInformationByHandle(file.value, &info) || !GetFileSizeEx(file.value, &size) ||
      (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) ||
      info.nNumberOfLinks != 1 || size.QuadPart < 8 || size.QuadPart > 65534 || size.QuadPart % 2) {
    throw "Invalid HCC launcher configuration";
  }
  std::vector<wchar_t> data(static_cast<size_t>(size.QuadPart / 2)); DWORD read = 0;
  if (!ReadFile(file.value, data.data(), static_cast<DWORD>(size.QuadPart), &read, nullptr) ||
      read != size.QuadPart || data[0] != 0xfeff) throw "Cannot read the HCC launcher configuration";
  std::wstring node(data.begin() + 1, data.end());
  if (node.size() < 4 || node[1] != L':' || node[2] != L'\\' ||
      node.find_first_of(L"\r\n\"") != std::wstring::npos || node.find(L'\0') != std::wstring::npos) {
    throw "The HCC launcher requires an absolute Node.js executable";
  }
  return node;
}
BOOL WINAPI IgnoreControl(DWORD event) {
  return event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT;
}
}

int wmain() {
  try {
    std::vector<wchar_t> filename(32768);
    const DWORD length = GetModuleFileNameW(nullptr, filename.data(), static_cast<DWORD>(filename.size()));
    if (!length || length >= filename.size()) throw "Cannot identify the HCC launcher";
    const std::wstring executable(filename.data(), length);
    const std::wstring node = NodePath(executable + L".nodepath");
    int argc = 0; wchar_t** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv) throw "Cannot read launcher arguments";
    std::wstring command = Quote(node) + L" " + Quote(executable + L".mjs");
    for (int index = 1; index < argc; ++index) command += L" " + Quote(argv[index]);
    LocalFree(argv);
    if (command.size() >= 32767) throw "The HCC launcher command is too long";
    STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION process{};
    if (!CreateProcessW(node.c_str(), command.data(), nullptr, nullptr, TRUE,
        0, nullptr, nullptr, &startup, &process)) throw "Cannot start the configured Node.js executable";
    Handle child, thread; child.value = process.hProcess; thread.value = process.hThread;
    // The delegated CLI owns cancellation and provider lifetime. Keep this thin
    // launcher alive to return its exit status when Ctrl+C is delivered to both.
    SetConsoleCtrlHandler(IgnoreControl, TRUE);
    if (WaitForSingleObject(child.value, INFINITE) != WAIT_OBJECT_0) throw "Cannot wait for the HCC launcher";
    DWORD status = 1; if (!GetExitCodeProcess(child.value, &status)) throw "Cannot read the HCC launcher status";
    return static_cast<int>(status);
  } catch (const char* message) { std::cerr << "hcc: " << message << "\n"; return 1; }
}
