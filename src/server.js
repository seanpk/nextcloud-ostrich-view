import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import Fastify from 'fastify';
import fastifyView from '@fastify/view';
import fastifySecureSession from '@fastify/secure-session';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import nunjucks from 'nunjucks';

import { loadConfig } from './config.js';
import { createClient } from './nextcloud/client.js';
import { createPreviewCache } from './nextcloud/previews.js';
import { createVisitStore } from './store/visits.js';
import { createNewSinceCache } from './lib/new-since.js';
import { InvalidPathError } from './lib/paths.js';
import { NC_UNREACHABLE, NextcloudError } from './nextcloud/client.js';
import registerAuthRoutes from './routes/auth.js';
import registerHomeRoutes from './routes/home.js';
import registerFileRoutes from './routes/files.js';
import registerMediaRoutes from './routes/media.js';
import registerTaskRoutes from './routes/tasks.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const VIEWS_DIR = join(HERE, 'views');
const PUBLIC_DIR = join(HERE, '..', 'public');

/**
 * Cache-busts `/public/` assets referenced from templates (`?v=`). `/public/`
 * is served with `maxAge: 7d` in production, so without this a phone that
 * loaded the page once could run a week-old stylesheet or script against
 * freshly deployed HTML. Falls back to the current time if package.json is
 * somehow unreadable, which still cache-busts -- it just also does so on
 * every restart instead of only on a version bump.
 */
const APP_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version ?? String(Date.now());
  } catch {
    return String(Date.now());
  }
})();

/** Paths reachable without a session. Everything else redirects to /login. */
const PUBLIC_ROUTES = new Set(['/login', '/healthz']);
const PUBLIC_PREFIXES = ['/public/'];

/**
 * One CSP for the whole app, including the pdf.js page under /public/pdfjs/.
 *
 * M2 loosened M1's policy in exactly two places, both for pdf.js, and nowhere
 * else. Everything is still same-origin; there is no 'unsafe-inline', no
 * 'unsafe-eval', and no remote origin anywhere in here.
 *
 *  - `'wasm-unsafe-eval'` in script-src. pdf.js decodes JBIG2 and JPEG 2000
 *    images -- the formats scanned lecture notes usually arrive in -- with
 *    WebAssembly, and *any* CSP that constrains script-src blocks WebAssembly
 *    compilation without this token (verified: with `script-src 'self'` alone,
 *    Chrome refuses `WebAssembly.compile` and names 'unsafe-eval'). It permits
 *    only WASM compilation: it does not enable eval() or new Function(), which
 *    is why the far broader `'unsafe-eval'` is not here. Our viewer also passes
 *    `isEvalSupported: false`, so pdf.js never reaches for eval to evaluate a
 *    PostScript function.
 *  - `data:` in font-src. pdf.js prefers the FontFace API (no CSP surface, and
 *    what Chrome takes), but falls back to an `@font-face` rule with a
 *    `url(data:font/opentype;...)` source on browsers where that path isn't
 *    available. A data: font is inert, and a phone that silently renders a PDF
 *    with no glyphs is the one failure this app cannot afford.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "style-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

/**
 * How long the "file server is taking a break" page asks the browser to wait,
 * in seconds. It is both the `Retry-After` header and the page's own meta
 * refresh, so an idle tab recovers by itself. A minute: long enough that a
 * rebooting Nextcloud is usually back, short enough that nobody is left staring
 * at a stale apology.
 */
const UPSTREAM_RETRY_AFTER_SECONDS = 60;

function isPublicPath(pathname) {
  if (PUBLIC_ROUTES.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Build the Fastify app. Exported (rather than built at import time) so tests
 * can boot a fully wired instance on an ephemeral port against the mock server.
 *
 * @param {{ config?: object, logger?: object|boolean,
 *           newSinceCache?: ReturnType<import('./lib/new-since.js').createNewSinceCache> }} [options]
 */
export async function buildApp(options = {}) {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    logger: options.logger ?? false,
    // Cloudflare fronts this app; without trustProxy req.ip is the tunnel's.
    trustProxy: true,
    // The only body we ever accept is a login form. 16 KB is generous.
    bodyLimit: 16 * 1024,
  });

  // Fastify ships JSON and text parsers only. The login form posts
  // application/x-www-form-urlencoded, which URLSearchParams handles without
  // pulling in another dependency.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (request, body, done) => {
      try {
        // Object.fromEntries defines own properties, so a `__proto__` field
        // in the body cannot poison the prototype chain.
        done(null, Object.fromEntries(new URLSearchParams(body)));
      } catch (err) {
        err.statusCode = 400;
        done(err);
      }
    }
  );

  app.decorate('appConfig', config);
  const nextcloud = createClient(config.nextcloud);
  app.decorate('nextcloud', nextcloud);

  // Runtime state directory. Created here rather than at first write so a
  // container with a broken volume mount fails at boot, loudly, instead of on
  // the first thumbnail request.
  mkdirSync(config.previewCacheDir, { recursive: true });
  app.decorate(
    'previewCache',
    createPreviewCache({ dir: config.previewCacheDir, client: nextcloud, log: app.log })
  );
  // "New since you last looked" state. Same directory, same volume: one mount
  // carries everything this app remembers between restarts.
  app.decorate('visits', createVisitStore({ dir: config.dataDir, log: app.log }));
  // The home route's short-lived memory of its last SEARCH answer. Built here
  // rather than inside the route so a test can hand in one with a short TTL and
  // a fake clock instead of waiting a minute for an entry to expire.
  app.decorate('newSinceCache', options.newSinceCache ?? createNewSinceCache());

  await app.register(fastifySecureSession, {
    key: config.sessionKey,
    cookieName: 'ostrich_session',
    cookie: {
      path: '/',
      httpOnly: true,
      // Behind the Cloudflare tunnel everything is HTTPS. Only an explicit
      // NODE_ENV of development/test (plain-HTTP LAN use) drops Secure --
      // a bare `npm start` must never issue a non-Secure cookie.
      secure: config.cookieSecure,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 90, // ~90 days: Mom should rarely retype the phrase
    },
  });

  // Applied per-route (login only) rather than globally: browsing folders on a
  // flaky phone connection shouldn't ever hit a limit.
  await app.register(fastifyRateLimit, { global: false });

  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/public/',
    index: false,
    list: false,
    cacheControl: true,
    maxAge: config.isProduction ? '7d' : 0,
  });

  await app.register(fastifyView, {
    engine: { nunjucks },
    root: VIEWS_DIR,
    viewExt: 'njk',
    options: {
      // Nunjucks caches compiled templates; in dev we want edits picked up.
      noCache: !config.isProduction,
    },
    defaultContext: {
      // Overridden per-render; declared here so templates never see `undefined`.
      viewer: null,
      backHref: null,
      breadcrumbs: [],
      immersive: false,
      appVersion: APP_VERSION,
    },
  });

  // --- Security headers -----------------------------------------------------
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', CSP);

    const contentType = String(reply.getHeader('content-type') ?? '');
    if (contentType.includes('text/html')) {
      // Pages are per-viewer and reflect live Nextcloud state: never cache.
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  // --- Authentication gate --------------------------------------------------
  app.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0];
    if (isPublicPath(pathname)) return;

    const viewer = request.session.get('viewer');
    if (
      viewer &&
      typeof viewer.name === 'string' &&
      // Re-check against the loaded viewers: a cookie for a viewer that has
      // been removed from viewers.json must stop working at the next restart,
      // not live out its ~90-day expiry.
      config.viewers.some((v) => v.name === viewer.name)
    ) {
      request.viewer = viewer;
      return;
    }

    // No session (or a revoked one): send her to the one page she can use.
    if (viewer) request.session.delete();
    reply.header('Cache-Control', 'no-store');
    return reply.redirect('/login', 302);
  });

  app.decorateRequest('viewer', null);

  // --- Errors ---------------------------------------------------------------
  // Registered BEFORE the routes: a plugin inherits whichever error handler is
  // in place when it is registered, so setting these afterwards would leave the
  // route plugins on Fastify's default JSON error output.
  app.setNotFoundHandler(async (request, reply) => {
    reply.code(404);
    return reply.view('error', {
      viewer: request.viewer,
      title: 'Not found',
      message: "We couldn't find that page.",
      backHref: '/',
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;

    if (error instanceof InvalidPathError) {
      request.log.warn({ err: error, url: request.url }, 'rejected unsafe path');
    } else if (error instanceof NextcloudError) {
      request.log.error({ err: error }, 'nextcloud request failed');
    } else if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
    }

    // A 404 from a task route must not talk about folders, and must send her
    // back to the task lists rather than to the file home. The upstream-failure
    // pages want the same distinction, so it is worked out before them.
    //
    // The PATHNAME, not the URL: `/tasks?utm_source=…` is still the task
    // section, and a link she opened from a message would otherwise get the
    // folder wording and a button back to the file home.
    const pathname = request.url.split('?')[0];
    const inTasks = pathname === '/tasks' || pathname.startsWith('/tasks/');
    const upstreamBackHref = inTasks ? '/tasks' : '/';

    // Nextcloud is not answering at all: refused, timed out, DNS gone, or the
    // Beelink rebooting while she happens to be looking. This is the ONE
    // self-healing failure, so it is the only one that gets the "come back in a
    // minute" page -- and it is recognised by the marker the client sets where
    // `fetch` itself threw, never by a missing status. A status-less error from
    // a response that DID arrive (a 207 we couldn't parse) is a
    // misconfiguration; promising it will fix itself would leave that page up
    // forever.
    if (error instanceof NextcloudError && error.code === NC_UNREACHABLE) {
      reply.code(503);
      // Both the header (for anything polite enough to read it) and the meta
      // refresh in the view (for the tab she has left open on the sofa).
      reply.header('Retry-After', String(UPSTREAM_RETRY_AFTER_SECONDS));
      return reply.view('upstream-error', {
        viewer: request.viewer,
        title: 'The file server is taking a break',
        message:
          'Your files live on another computer, and it isn’t answering right ' +
          'now. Nothing you did caused this, and nothing has been lost. ' +
          'Please try again in a few minutes — this page will check for you.',
        retryAfter: UPSTREAM_RETRY_AFTER_SECONDS,
        backHref: upstreamBackHref,
      });
    }

    // Nextcloud is there and something is wrong that waiting will not fix.
    // Three shapes, one page: the reader is told the same calm thing either way
    // -- only the single line addressed to whoever runs the site differs,
    // because only that line is actionable and it must point at the right thing.
    //
    //  401  the app password was revoked or expired, or the account is disabled;
    //  403  authenticated but not allowed *this* -- often a perfectly good app
    //       password against a share or a file-access rule that says no, so the
    //       note must not assert the password is the problem;
    //  no status  a response arrived and made no sense (not a multistatus, an
    //       HTML login page, a 207 that describes nothing we asked about) --
    //       which is what a wrong NC_BASE_URL or a proxy in the way looks like.
    const isMalformed = error instanceof NextcloudError && error.status === undefined;
    const needsAttention =
      isMalformed || (error instanceof NextcloudError && (error.status === 401 || error.status === 403));

    if (needsAttention) {
      let ownerNote;
      if (isMalformed) {
        ownerNote =
          'Whoever runs this site needs to check that NC_BASE_URL points at ' +
          'Nextcloud itself, and that nothing in front of it is rewriting the answer.';
      } else if (error.status === 401) {
        ownerNote = 'Whoever runs this site needs to check the app’s Nextcloud app-password.';
      } else {
        ownerNote =
          'Whoever runs this site needs to check the app’s Nextcloud access — ' +
          'start with the app password, then any file-access rules.';
      }

      reply.code(502);
      return reply.view('upstream-error', {
        viewer: request.viewer,
        title: 'The connection to the file server needs attention',
        message:
          'The file server is there, but it isn’t letting this site read your ' +
          'files at the moment. Nothing you did caused this, and nothing has ' +
          'been lost — it needs someone to sort out at the other end.',
        // Deliberately no credentials, hostnames, statuses or stack detail: the
        // log line above carries all of that, and this page is public to anyone
        // holding a passphrase.
        ownerNote,
        backHref: upstreamBackHref,
      });
    }

    // The per-IP login limiter throws a 429; it deserves the same calm
    // wait-a-minute message as the global window, not a "we broke" page.
    if (status === 429) {
      reply.code(429);
      return reply.view('login', {
        title: 'Welcome',
        error: 'Too many tries right now. Please wait a minute and try again.',
        showBack: false,
      });
    }

    const notFoundMessage = inTasks
      ? "We couldn't find that task list. It may have been unshared."
      : "We couldn't find that folder. It may have been moved or unshared.";

    reply.code(status);
    return reply.view('error', {
      viewer: request.viewer,
      title: status === 404 ? 'Not found' : 'Something went wrong',
      // Never surface upstream detail to the browser; the log has it.
      message:
        status === 404
          ? notFoundMessage
          : "Something went wrong on our end. Please try again in a moment.",
      backHref: inTasks ? '/tasks' : '/',
    });
  });

  // --- Routes ---------------------------------------------------------------
  /**
   * THIS app's liveness, and deliberately nothing else.
   *
   * It does not contact Nextcloud, and it must not start: Docker restarts a
   * container whose health check fails, so probing Nextcloud from here would
   * turn "Nextcloud is rebooting" into "the viewer restart-loops until it comes
   * back" -- taking down the login page and the friendly "file server is taking
   * a break" page, which are exactly what should still work at that moment.
   * A green /healthz means "the process booted and its config validated".
   */
  app.get('/healthz', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  });

  await app.register(registerAuthRoutes);
  await app.register(registerHomeRoutes);
  await app.register(registerFileRoutes);
  await app.register(registerMediaRoutes);
  await app.register(registerTaskRoutes);

  return app;
}

export default buildApp;
