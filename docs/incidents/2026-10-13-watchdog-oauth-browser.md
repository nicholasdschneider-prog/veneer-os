# Watchdog ownership and command-line OAuth browser finding

Status: tracked; prevention plan proposed, implementation awaiting approval.

## Durable repair owner

On October 13, 2026, the host-overload investigation restored the existing
watchdog maintenance chat around 17:12Z. A read-only database check in this
coordination turn confirmed `web_watchdog_state` still points to
`555cb2fd-f3d4-410c-9720-8290fd8d45f5`, owner user 1. The chat is unarchived,
its assistant is Platform Dev, and its owner has the active owner role. No
watchdog incident is open. The latest retained web sample at verification had
healthy HTTP, 1.84 ms latency, 16.01% attributed CPU and 65.5 ms event-loop delay.
These web metrics do not establish shared Chrome health.

## Reported Chrome finding

The host-overload investigation reports shared headless Chrome PID 606
(`com.veneer.chrome`, CDP port 9223) running near 100% CPU. Its process sample
shows an AppKit `sendEvent` / `NSMenu performKeyEquivalent` loop, with no CDP
client connected. Its only page reportedly opened October 12 at 16:40:36Z,
when chat a55ba28f, "Lyme Disease Content Hub", ran `clasp login`: the Mac's
default-browser handoff delivered the Google OAuth URL to headless Chrome.
This is a plausible trigger, not a proven root cause. This turn did not inspect
page content, collect OAuth URLs, or independently reproduce the Chrome spin.

## Proposed prevention plan — approval required

1. Inventory command-line sign-in flows and their launch environments, using
   read-only inspection. Identify which tools invoke the Mac default browser.
2. Prefer each tool's documented no-auto-browser mode; verify the installed
   clasp version's `login --no-localhost` behavior before adopting it. For tools
   without that mode, evaluate a narrowly scoped sandboxed `BROWSER` setting.
   Do not assume this variable intercepts macOS `open` or every CLI library.
3. Test the selected approach in an isolated fixture with a browser-launch spy,
   proving it never invokes the shared Chrome/default-browser path and keeps
   sign-in possible through the assigned authorized browser. Do not record
   credentials, codes, OAuth URLs or tokens in test reports.
4. After plan approval, queue any shared source, executable or configuration
   repair through `enqueue_build`. Update relevant operator guidance and the
   feature catalog if an ordinary bot capability changes.
5. Run focused checks while editing, then one full validation and build under
   the host-wide development lock with the existing single Vitest worker.
   Commit and push verified work. Report deployment pending unless Nick
   explicitly approves a maintenance window for the affected services.

Shared Chrome remains untouched; browser recovery belongs to the separate
recovery owner. Do not cancel business turns or change business jobs. Every
production restart requires an explicit Nick-approved window and the supported
`npm run restart -- --maintenance-approved <affected-service>` command, after
turns drain. Do not use signals, `launchctl`, unauthorized `--allow-active-turns`,
or a watcher that forces a restart on timeout. A lock refusal requires waiting
or coordination, never bypassing the development lock.

No implementation, deployment, restart or recovery action was performed for
this finding. The existing watchdog supplies incident follow-up; this record
does not create a replacement binding, schedule or grant.
