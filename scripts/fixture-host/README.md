# Harmless native process host acceptance

This staged macOS arm64 package boots real compiled C and Node 24 processes under
Seatbelt default-deny policies. It accepts no provider command, profile, auth,
customer input, or network destination. It is deliberately separate from the
unchanged unconditional native fixture admission gate. It starts no models.

Prerequisites: macOS arm64, /usr/bin/sandbox-exec, Xcode Command Line Tools clang
and otool, /usr/bin/python3 (standard library only), and the public Homebrew
Node 24 runtime at /opt/homebrew/opt/node@24/bin/node. No installation, service
restart, credential materialization, sign-in, or enrollment is required for this
harmless acceptance check on the prepared development host.

From the source checkout:

```sh
python3 scripts/fixture-host/bootstrap.py --receipt docs/reports/sms-native-test/my-new-host-receipt.json
python3 scripts/fixture-host/bootstrap_test.py -v
```

The receipt path must be new. The launcher rejects unsupported hosts, missing
runtime dependencies, unsuccessful bootstrap, missing positive controls, missing
denials, output overflow, and timeouts. No accepted receipt is written on failure.
Review the receipt bytes and exit statuses; an abort never proves enforcement.

The launcher creates mode-0700 temporary directories with mode-0600 files,
a private HOME/TMPDIR and empty OpenSSL configuration, an allowlisted environment,
closed inherited descriptors, ignored stdin, bounded captured stdout/stderr,
no core dumps, eight seconds CPU, ten seconds elapsed per child, 64 descriptors,
and a 1 MiB file limit. It uses no external packages or service connections.
Temporary synthetic resources are destroyed after observation.

The active C profile allows only its exact executable, public System/usr-lib
runtime reads, the literal root directory, sysctl reads, and private fixture
reads/writes. No network or process-fork grant exists. Node gets the same private
boundary with exact linked-library paths (including symlink intermediates),
literal ancestor directory reads needed for dyld traversal, and workspace
ancestor metadata. Unknown non-System dependency forms fail closed. The receipt
pins actual executable/library/source/profile hashes and retains raw process
output, exit code, elapsed duration, and UTC run bounds.

Synthetic controls prove the forbidden file/symlink/write and live TCP/Unix
socket targets were accessible outside the sandbox. A synthetic descriptor and
environment marker are explicitly inherited only by the unsandboxed positive
control. Active processes deny file/symlink/write access, TCP/Unix connections,
self-spawn, other executable/shell spawn, and C fork with EPERM. A separate
fork-enabled *diagnostic* profile observes file and TCP denials inherited by a
child; that profile is never an admission profile.

The without-root A/B profile differs only in the literal root-directory read.
On the tested macOS host it aborts; adding that narrow read permits bootstrap.
This identifies a reproducible resource omission, not the exact internal dyld
syscall. The abort is retained as launch failure, not counted as a denial.

Scope limits: public system/runtime code remains readable; this is not a claim
that every file is inaccessible. The harness assumes a trusted OS, source
checkout, public toolchain/runtime, and owner account. It does not defend against
a privileged administrator or owner altering that code/OS while it runs. Receipt
hashes provide reproducibility, not service-authenticated native manifest trust.
No production provider executable, protected authentication, fixture-only MCP
transport, pinned shared role training, customer sessions, or native telemetry
has been coupled or accepted by this package.

Next coupling must implement the dedicated provider-specific protected-auth
boundary, audited fixed provider command/resource inventory and tool transport
with no generic shared adapter, pinned training/profile materialization, and
authenticated lineage/telemetry. Keep admission unconditionally closed until
those boundaries and actual denied-effect tests pass. Only then can the actual
owner perform the provider's supported sign-in in the dedicated setup; no shared
credential copy or human impersonation is an alternative. This milestone needs
no owner action or architecture choice and authorizes no deployment.

Build 580 adds [callable Codex pre-auth and synthetic transport setup](./CODEX.md).
It also identifies and repairs a broad-sysctl process-environment inspection gap.
The build 579 file/socket/fork/FD tests remain valid within their tested scope,
but they do not establish protected credential isolation against that interface.
The narrowed profile adds mandatory synthetic process-environment denial checks.
Native authentication/model acceptance still requires the separate protected bridge and egress boundary.
