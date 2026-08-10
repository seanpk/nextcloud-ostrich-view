#!/usr/bin/env node
//
// The one health probe. Docker's HEALTHCHECK runs it, and deploy.sh runs it
// inside the container when the host has no curl -- so "is it healthy?" has a
// single definition that follows PORT instead of three copies that drift.
//
// The slim image has no curl, and adding one just for this is a package we
// would then have to keep patched. Node 22 has a global fetch, so the runtime
// we already trust checks itself.
//
// Exit 0 = healthy, exit 1 = anything else (refused, timed out, non-2xx).

const port = process.env.PORT || 3000;
const url = `http://127.0.0.1:${port}/healthz`;

// Explicit timeout: fetch's default is "wait forever", which would leave the
// probe hanging on a process that accepted the connection and then wedged.
const TIMEOUT_MS = 3000;

try {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
