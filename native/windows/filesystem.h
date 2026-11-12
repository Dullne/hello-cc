#ifndef HCC_WINDOWS_FILESYSTEM_H
#define HCC_WINDOWS_FILESYSTEM_H
#include <node_api.h>
#include <windows.h>
#include <functional>
#include <memory>
#include <string>
#include <vector>
std::wstring WindowsPathArgument(napi_env env, napi_value value);
void WindowsInspectDirectoryChain(const std::wstring& path, const std::function<void(HANDLE, bool)>& visitor);
class WindowsProcessDirectoryLease {
 public:
  virtual ~WindowsProcessDirectoryLease() = default;
  virtual const std::wstring& canonical() const = 0;
  virtual std::vector<HANDLE> handles() const = 0;
  virtual void assertUnchanged() const = 0;
};
std::shared_ptr<WindowsProcessDirectoryLease> WindowsRetainDirectoryForProcess(napi_env env, napi_value value);
class WindowsProcessAppendLease {
 public:
  virtual ~WindowsProcessAppendLease() = default;
  virtual HANDLE file() const = 0;
  virtual std::vector<HANDLE> handles() const = 0;
  virtual void assertUnchanged() const = 0;
};
std::shared_ptr<WindowsProcessAppendLease> WindowsRetainAppendForProcess(napi_env env, napi_value value);
// The borrowed handle and flush closure are valid only during the synchronous visitor.
void WindowsWithPinnedDirectory(napi_env env, napi_value value,
  const std::function<void(HANDLE, const std::function<void()>&)>& visitor);
napi_value RegisterFilesystem(napi_env env, napi_value exports);
#endif
