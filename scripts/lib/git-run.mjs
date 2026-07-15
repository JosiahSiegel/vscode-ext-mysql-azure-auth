// scripts/lib/git-run.mjs
//
// Thin wrappers around Node's child_process so scan-history.mjs can stream
// `git rev-list --objects --all` line-by-line and run individual blob reads
// without buffering the whole object DB in memory.

import { spawn } from "node:child_process";

function procFactory(command, args, { allowExitCodes } = {}) {
  const allowed = allowExitCodes ?? new Set([0]);
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let settled = false;
  const settle = (cb) => {
    if (settled) return;
    settled = true;
    cb();
  };
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  const promise = new Promise((resolve, reject) => {
    child.on("error", (err) => settle(() => reject(err)));
    child.on("close", (code) => {
      const exitCode = code ?? -1;
      const result = {
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString("binary"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      };
      if (allowed.has(exitCode)) {
        settle(() => resolve(result));
      } else {
        settle(() => resolve({ ...result, exitCode }));
      }
    });
  });
  return { child, promise };
}

export function spawnFile(command, args, options) {
  return procFactory(command, args, options).promise;
}

export async function* spawnLine(command, args, options) {
  const { child, promise } = procFactory(command, args, options);
  let buffer = "";
  const queue = [];
  let done = false;
  let waiter = null;
  const pump = (chunk) => {
    buffer += chunk.toString("binary");
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/u, "");
      buffer = buffer.slice(nl + 1);
      queue.push(line);
      if (waiter) {
        const w = waiter;
        waiter = null;
        w();
      }
      nl = buffer.indexOf("\n");
    }
  };
  child.stdout.on("data", pump);
  child.on("close", () => {
    if (buffer.length > 0) queue.push(buffer);
    buffer = "";
    done = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  });
  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift();
      } else if (done) {
        return;
      } else {
        await new Promise((resolve) => {
          waiter = resolve;
        });
      }
    }
  } finally {
    await promise.catch(() => undefined);
  }
}
