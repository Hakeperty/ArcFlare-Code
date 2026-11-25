// On Windows harnesses launch through cmd.exe, so a folder or argument holding
// cmd.exe metacharacters must reach the tool as text, never as a second command.

const test = require("node:test");
const assert = require("node:assert");
const { cmdLine } = require("../lib/harness");

function asPlatform(platform, fn) {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try { return fn(); } finally { Object.defineProperty(process, "platform", real); }
}
const asWindows = (fn) => asPlatform("win32", fn);
// The tests that expect the POSIX behaviour must not depend on the OS the suite runs on.
const asLinux = (fn) => asPlatform("linux", fn);

// cmd.exe drops one caret before each character on every pass.
const unescape = (s) => s.replace(/\^(.)/g, "$1");
// Outside a caret every metacharacter is live; none may be left.
const live = (s) => s.replace(/\^./g, "").match(/[&|<>()%!"]/);

test("harness launches pass their arguments through as-is off Windows", () => {
  assert.deepStrictEqual(asLinux(() => cmdLine("/usr/bin/hermes", ["--in", "a & b"])), ["/usr/bin/hermes", ["--in", "a & b"]]);
});

test("a folder named with cmd.exe metacharacters cannot run a command on Windows", () => {
  const evil = 'C:\\work\\a" & calc & "b ^ (x) | y!';
  const [line, args] = asWindows(() => cmdLine("C:\\Program Files\\hermes\\hermes.exe", ["--in", evil]));
  assert.deepStrictEqual(args, []);
  assert.strictEqual(live(line), null);
  assert.strictEqual(unescape(line),
    'C:\\Program Files\\hermes\\hermes.exe "--in" "C:\\work\\a\\" & calc & \\"b ^ (x) | y!"');

  // A .cmd shim re-reads %* once more, so it is escaped twice.
  const [shim] = asWindows(() => cmdLine("C:\\npm\\codex.cmd", ["a&b"]));
  assert.strictEqual(live(unescape(shim)), null);
  assert.strictEqual(unescape(unescape(shim)), 'C:\\npm\\codex.cmd "a&b"');
});

test("trailing backslashes do not swallow the closing quote on Windows", () => {
  const [line] = asWindows(() => cmdLine("x.exe", ["C:\\dir\\"]));
  assert.strictEqual(unescape(line), 'x.exe "C:\\dir\\\\"');
});

// cmd.exe expands %VAR% before it reads any caret, so a % cannot be escaped.
test("a folder or argument with % is refused on Windows instead of being expanded", () => {
  assert.throws(() => asWindows(() => cmdLine("C:\\npm\\codex.cmd", ["--in", "C:\\work\\%PATH%"])), /cannot pass a "%"/);
  assert.throws(() => asWindows(() => cmdLine("x.exe", ["100%"])), /cannot pass a "%"/);
  assert.deepStrictEqual(asLinux(() => cmdLine("/usr/bin/hermes", ["%PATH%"])), ["/usr/bin/hermes", ["%PATH%"]]);
});
