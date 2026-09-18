# macOS installer and two-iPhone acceptance

Status: desktop 12/12 and system 800/800 automated tests pass on the Windows
development host; the system production dependency audit reports 0 known
vulnerabilities and the packaging runtime preflight passes.
The DMG build and this physical acceptance sequence are not yet verified on the
Mac mini or real iPhones.

## Preconditions

- Install the generated DMG by dragging Phone Farm.app to Applications.
- Complete Apple signing for WebDriverAgent once if required.
- Enable Developer Mode and trust the Mac on each authorized iPhone once.
- Keep proxy routing disabled for this acceptance unless it is being tested as
  a separate, explicitly configured feature.

## Required normal-launch validation

A. Start with Phone Farm closed.

B. No manual iproxy process running.

C. Xcode closed.

D. Terminal not required for normal app operation.

E. Connect two already-trusted iPhones.

F. Open Phone Farm.app from Applications.

G. Both phones are detected.

H. WDA starts automatically for both.

I. Separate iproxy tunnels start automatically.

J. Both devices become available.

K. Open Phone A and verify tap.

L. Verify swipe.

M. Verify typing.

N. Verify Home.

O. Open Phone B and repeat basic control.

P. Quit Phone Farm completely.

Q. Relaunch Phone Farm.

R. Both devices recover automatically.

S. Unplug Phone A.

T. Phone B remains operational.

U. Reconnect Phone A.

V. Phone A recovers automatically.

Record the DMG filename, macOS version, Mac architecture, Phone Farm commit,
iOS versions, and pass/fail evidence. A successful screenshot/render and input
test does not by itself validate video monitoring or network/proxy routing.

## Failure-path validation

Run each case independently and confirm the UI explains the problem rather
than showing an unexplained empty fleet or endlessly restarting:

- Developer Mode disabled: the affected phone shows that Developer Mode must
  be enabled and waits for an admin retry.
- Phone not trusted: the affected phone asks the operator to trust the Mac and
  waits for retry.
- WDA signing broken: the affected phone explains that WDA signing must be
  configured once in Xcode and waits for retry.
- iproxy unavailable: Host setup marks iproxy as needing attention and says to
  install libusbmuxd.
- WDA repo unavailable: Host setup says WebDriverAgent was not found and
  explains `~/WebDriverAgent` / `WDA_REPO_PATH`.

Also confirm that a failure for Phone A does not stop Phone B, and that client
mode can open its configured remote host without exposing `desktopApi` to the
remote page.
