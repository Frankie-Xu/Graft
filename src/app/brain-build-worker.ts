/**
 * The process one repository read runs in.
 *
 * Forked by brain-build-process.ts, one per read, and it exits when the read
 * does. It receives the credential it needs rather than the App's private key,
 * for the same reason the reviewer's worker does: `ps` and `/proc/<pid>/environ`
 * are readable, and a key that never crosses the boundary cannot leak across it.
 *
 * Everything expensive happens here — the clone, the tree-sitter parse, the
 * pull-request walk — and none of it can reach the server's event loop.
 */
import { readRepository, type BrainBuildJob, type RepoReadAuth } from "./brain-build.js";

/** Parent → child, once, immediately after the fork. */
export interface StartMessage {
  t: "start";
  job: BrainBuildJob;
  auth: RepoReadAuth;
  api?: string;
  githubHost?: string;
}

/** Child → parent: a line for the App's log, so a read is still traceable. */
export interface LogMessage {
  t: "log";
  msg: string;
}

export interface DoneMessage {
  t: "done";
  result: Awaited<ReturnType<typeof readRepository>>;
}

export interface FailedMessage {
  t: "failed";
  message: string;
}

export type FromChild = LogMessage | DoneMessage | FailedMessage;

function send(msg: FromChild): void {
  if (!process.send) return;
  try {
    process.send(msg);
  } catch {
    /* parent went away; the exit is the report */
  }
}

process.on("message", (raw) => {
  const msg = raw as StartMessage;
  if (msg.t !== "start") return;
  void readRepository(msg.job, {
    // No creds: this half needs none. resolveRepoRead already did every call
    // that requires the App's identity, and its answer is in `auth`.
    creds: { appId: "", privateKey: "" },
    fetch: globalThis.fetch,
    api: msg.api,
    githubHost: msg.githubHost,
    log: (line: string) => send({ t: "log", msg: line }),
  }, msg.auth)
    .then((result) => {
      send({ t: "done", result });
      // The digest can be several megabytes and the channel is asynchronous, so
      // let the write drain rather than exiting out from under it.
      process.disconnect?.();
    })
    .catch((e: unknown) => {
      send({ t: "failed", message: e instanceof Error ? e.message : String(e) });
      process.disconnect?.();
    });
});
