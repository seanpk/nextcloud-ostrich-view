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
import { InvalidPathError } from './lib/paths.js';
import { NextcloudError } from './nextcloud/client.js';
import registerAuthRoutes from './routes/auth.js';
import registerHomeRoutes from './routes/home.js';
import registerFileRoutes from './routes/files.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const VIEWS_DIR = join(HERE, 'views');
const PUBLIC_DIR = join(HERE, '..', 'public');

/** Paths reachable without a session. Everything else redirects to /login. */
const PUBLIC_ROUTES = new Set(['/login', '/healthz']);
const PUBLIC_PREFIXES = ['/public/'];

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

function isPublicPath(pathname) {
  if (PUBLIC_ROUTES.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Build the Fastify app. Exported (rather than built at import time) so tests
 * can boot a fully wired instance on an ephemeral port against the mock server.
 *
 * @param {{ config?: object, logger?: object|boolean }} [options]
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
  app.decorate('nextcloud', createClient(config.nextcloud));

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

    reply.code(status);
    return reply.view('error', {
      viewer: request.viewer,
      title: status === 404 ? 'Not found' : 'Something went wrong',
      // Never surface upstream detail to the browser; the log has it.
      message:
        status === 404
          ? "We couldn't find that folder. It may have been moved or unshared."
          : "Something went wrong on our end. Please try again in a moment.",
      backHref: '/',
    });
  });

  // --- Routes ---------------------------------------------------------------
  app.get('/healthz', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  });

  await app.register(registerAuthRoutes);
  await app.register(registerHomeRoutes);
  await app.register(registerFileRoutes);

  return app;
}

export default buildApp;
