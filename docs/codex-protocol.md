# Codex protocol generation and upgrade check / 协议升级检查

HCC uses the installed Codex App Server over stdio for structured Web sessions
and independent native workers. Before upgrading that executable, generate its
own protocol and check the HCC subset:

```sh
npm run codex:protocol -- --codex-bin /absolute/path/to/codex --out /tmp/hcc-protocol-new
```

The output directory must not exist, and its parent must exist. Without `--out`,
the script retains a new private temporary protocol directory and prints its
path. From an installed package, the same command is:

```sh
node /absolute/path/to/hello-cc/scripts/codex-protocol.mjs --codex-bin /absolute/path/to/codex --out /tmp/hcc-protocol-new
```

The script uses isolated HOME/CODEX_HOME directories and runs only `--version`,
`app-server generate-ts`, and `app-server generate-json-schema`. Both generators
include `--experimental` because HCC's interactive thread configuration exposes
experimental permission and user-input tools. It does not start an App Server,
call a model, read an account, or modify login/trust configuration.

The output contains:

- `typescript/`: official generated TypeScript bindings.
- `json-schema/`: official generated JSON Schema documents.
- `manifest.json`: Codex version, commands, per-file SHA-256, bundle fingerprint,
  57 HCC contract checks, and unsupported server requests.

The check covers method availability, the thread/turn notifications consumed by
HCC, human response fields and choices, MCP form/URL identity, and read-only account/quota methods, notifications and fields.
Account schemas are read from the official `json-schema/v2/` directory. A missing
contract or a new required response field returns exit code 1. Unsupported
requests remain listed separately even when the supported subset passes.
Optional fields do not fail this gate. It is a bounded compatibility check;
it does not validate every nested request type, replace runtime validation,
or prove transport/model/business acceptance. Keep the manifest and rerun the
installed acceptance scripts before accepting a new Codex version.

Official generator reference: <https://developers.openai.com/codex/app-server/>.
The local official-protocol fixture in `test/fixtures/codex-protocol-0.144.6.json`
was extracted from installed Codex 0.144.6 on 2026-10-03. It retains method
registries and the relevant interaction and account schemas, rather than claiming that
all generated methods are implemented.

## 中文说明

升级 Codex 前运行上述命令，生成的是指定已安装版本自身的协议。协议目录必须是
新目录；工具不覆盖旧证据。生成物包括官方 TypeScript、JSON Schema 和带版本/
文件指纹的检查清单。

当前检查覆盖 57 项交接契约：客户端方法、轮次通知、人工答复字段/可选决策、
MCP 表单/URL 请求身份，以及只读账号/限额的方法、通知和必要字段。账号 Schema
从官方生成的 `json-schema/v2/` 读取。缺少方法、改变关键决策或新增 HCC 无法答复的必填字段时
返回非零退出码。账号 token 刷新、动态工具、扩展验证等未接入请求会单独列出，
不会因为生成成功而被视为已支持。该检查没有把运行时整体迁移为强类型协议，也不
代表新版本已完成真实模型、外部账户授权、发布或设备验收。
