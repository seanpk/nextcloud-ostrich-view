import { matchViewer } from '../lib/auth.js';

/**
 * Login / logout.
 *
 * One field, one big button, no username -- the passphrase itself says who she
 * is. A wrong phrase re-renders the same page with a calm, non-technical
 * message; it never blames the user or mentions "credentials".
 */

const LOGIN_ATTEMPTS_PER_MINUTE = 5;
const GLOBAL_LOGIN_ATTEMPTS_PER_MINUTE = 30;

/**
 * Rate-limit key: behind the Cloudflare tunnel every request arrives from the
 * tunnel's address, so the real client is in CF-Connecting-IP. Fall back to
 * req.ip for LAN/dev use.
 */
function clientKey(request) {
  const header = request.headers['cf-connecting-ip'];
  if (typeof header === 'string' && header.trim() !== '') return header.trim();
  return request.ip;
}

/**
 * Global (key-independent) window over FAILED login attempts. The per-IP
 * bucket above is keyed on headers a client can forge when it reaches the
 * origin directly (LAN, or any path Cloudflare doesn't front), so rotating
 * CF-Connecting-IP would otherwise defeat the 5/min cap entirely. This cap
 * can't be dodged: it counts every failed attempt regardless of claimed
 * origin. Only failures count -- successful logins by the handful of real
 * viewers should never burn brute-force budget.
 */
export function createLoginWindow({ limit = GLOBAL_LOGIN_ATTEMPTS_PER_MINUTE, windowMs = 60_000 } = {}) {
  const failures = [];
  return {
    /** Is the window at capacity right now? Does not record anything. */
    isOver(now = Date.now()) {
      while (failures.length > 0 && now - failures[0] > windowMs) failures.shift();
      return failures.length >= limit;
    },
    /** Record one failed attempt. */
    recordFailure(now = Date.now()) {
      failures.push(now);
    },
  };
}

export default async function registerAuthRoutes(app) {
  // LOGIN_GLOBAL_LIMIT exists for the test suite, which legitimately fails
  // logins far faster than any human household.
  const globalLimit = Number(process.env.LOGIN_GLOBAL_LIMIT) || GLOBAL_LOGIN_ATTEMPTS_PER_MINUTE;
  const loginWindow = createLoginWindow({ limit: globalLimit });

  app.get('/login', async (request, reply) => {
    // Already signed in? Nothing to do here.
    if (request.session.get('viewer')) {
      return reply.redirect('/', 302);
    }
    return reply.view('login', { title: 'Welcome', error: null, showBack: false });
  });

  app.post(
    '/login',
    {
      config: {
        rateLimit: {
          max: LOGIN_ATTEMPTS_PER_MINUTE,
          timeWindow: '1 minute',
          keyGenerator: clientKey,
        },
      },
    },
    async (request, reply) => {
      if (loginWindow.isOver()) {
        request.log.warn({ ip: clientKey(request) }, 'global login window exceeded');
        reply.code(429);
        return reply.view('login', {
          title: 'Welcome',
          error: 'Too many tries right now. Please wait a minute and try again.',
          showBack: false,
        });
      }

      const passphrase = typeof request.body?.passphrase === 'string' ? request.body.passphrase : '';

      const viewer = await matchViewer(app.appConfig.viewers, passphrase.trim());

      if (!viewer) {
        loginWindow.recordFailure();
        request.log.warn({ ip: clientKey(request) }, 'failed login attempt');
        reply.code(401);
        return reply.view('login', {
          title: 'Welcome',
          error: "That passphrase didn't match. Please try typing it again.",
          showBack: false,
        });
      }

      // Drop anything the old session carried before adopting the new viewer.
      // (`delete()` would be wrong here: it flags the cookie for clearing on
      // send, so the values we set afterwards would never reach the browser.)
      request.session.regenerate();
      request.session.set('viewer', { name: viewer.name, label: viewer.label });
      request.session.set('loggedInAt', new Date().toISOString());

      request.log.info({ viewer: viewer.name }, 'login');
      // `/#today`, the same place the Latest toggle points at: the stream has
      // what is coming above the Today line and the history below it, and
      // signing in should put her on the line rather than at the top of next
      // month's tasks. A fragment in a Location header is honoured by every
      // browser, and it is the only "scroll to" mechanism available on a page
      // with no JavaScript.
      return reply.redirect('/#today', 302);
    }
  );

  app.post('/logout', async (request, reply) => {
    request.session.delete();
    return reply.redirect('/login', 302);
  });
}

export { clientKey, LOGIN_ATTEMPTS_PER_MINUTE };
