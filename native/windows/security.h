#pragma once
#include <node_api.h>
#include <windows.h>
napi_value RegisterSecurity(napi_env env, napi_value exports);
napi_value WindowsSecurityForHandle(napi_env env, HANDLE handle);
// Caller owns the returned LocalAlloc buffer and must release it with LocalFree.
PSECURITY_DESCRIPTOR WindowsPrivateSecurityDescriptor();
