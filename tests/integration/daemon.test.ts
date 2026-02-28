/** Daemon E2E smoke test: exercises the full public surface through main.ts. */

import { assert, assertEquals } from "@std/assert";
import { startFixtureServer } from "./fixture-server.ts";

function findFreePort(): number {
  const listener = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function waitForHealth(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      await res.body?.cancel();
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`daemon did not become healthy within ${timeoutMs}ms`);
}

/** Resolve Deno's cache directory so it survives HOME override. */
async function denoDir(): Promise<string> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  });
  const { stdout } = await cmd.output();
  return JSON.parse(new TextDecoder().decode(stdout)).denoDir;
}

Deno.test("daemon E2E: start → navigate → snapshot → eval → stop", async () => {
  const tmpHome = await Deno.makeTempDir();
  const port = findFreePort();
  const fixtures = startFixtureServer();
  const env = { ...Deno.env.toObject(), HOME: tmpHome, DENO_DIR: await denoDir() };
  const base = `http://127.0.0.1:${port}`;

  const daemon = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "src/main.ts", "start", "--port", String(port)],
    env,
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // Drain stdout/stderr to prevent blocking — collect for diagnostics.
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  const drainStdout = (async () => {
    for await (const chunk of daemon.stdout) stdoutChunks.push(chunk);
  })();
  const drainStderr = (async () => {
    for await (const chunk of daemon.stderr) stderrChunks.push(chunk);
  })();

  const decode = (chunks: Uint8Array[]) =>
    new TextDecoder().decode(new Uint8Array(chunks.flatMap((c) => [...c])));

  try {
    await waitForHealth(port).catch((e) => {
      throw new Error(
        `${e.message}\ndaemon stdout: ${decode(stdoutChunks)}\ndaemon stderr: ${
          decode(stderrChunks)
        }`,
      );
    });

    // /health responds
    const healthRes = await fetch(`${base}/health`);
    assertEquals((await healthRes.json()).status, "ok");

    // Navigate to fixture page
    const navRes = await fetch(`${base}/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: fixtures.url("bestseller-table.html"), name: "smoke" }),
    });
    assertEquals(navRes.status, 200);
    await navRes.body?.cancel();

    // Snapshot — one structural marker
    const snapRes = await fetch(`${base}/snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "smoke" }),
    });
    assertEquals(snapRes.status, 200);
    const snap = await snapRes.json();
    assert(snap.yaml.includes("table"), "snapshot YAML should contain table role");

    // Eval — one JSON result
    const evalRes = await fetch(`${base}/eval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "smoke",
        expression: "document.querySelector('h1').textContent",
      }),
    });
    assertEquals(evalRes.status, 200);
    assertEquals((await evalRes.json()).result, "Top Bestselling Books");

    // Stop via CLI subprocess
    const stopResult = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", "src/main.ts", "stop"],
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(stopResult.code, 0, `stop failed: ${new TextDecoder().decode(stopResult.stderr)}`);

    // Daemon exited cleanly
    const status = await daemon.status;
    assertEquals(status.code, 0, "daemon should exit with code 0");

    // PID file removed
    try {
      await Deno.stat(`${tmpHome}/.scraper/daemon.json`);
      throw new Error("PID file should have been removed");
    } catch (e) {
      assert(e instanceof Deno.errors.NotFound, "PID file should not exist after stop");
    }
  } finally {
    try {
      const r = await fetch(`${base}/shutdown`, { method: "POST" });
      await r.body?.cancel();
    } catch { /* may already be stopped */ }
    try {
      daemon.kill("SIGTERM");
    } catch { /* may already be dead */ }
    try {
      await daemon.status;
    } catch { /* ignore */ }
    await Promise.allSettled([drainStdout, drainStderr]);
    await fixtures.close();
    try {
      await Deno.remove(tmpHome, { recursive: true });
    } catch { /* best effort */ }
  }
});
