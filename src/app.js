'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const config = require('./config');
const logger = require('./logger');
const apiRouter = require('./routes/api');
const uiRouter = require('./routes/ui');
const { requireUser, createAuthRouter } = require('./auth');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Behind a reverse proxy, req.ip must come from X-Forwarded-For or every
  // client shares the proxy's address in the login rate limit.
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);

  // HTMX is served from /vendor and the stylesheet from /css, so everything
  // stays same-origin. Helmet's default style-src allows inline styles and
  // https: hosts; both are tightened here because the app needs neither.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'style-src': ["'self'"],
          'font-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
        },
      },
    })
  );

  // Bounded body size to blunt trivial denial of service via huge payloads.
  app.use(express.json({ limit: config.bodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: config.bodyLimit }));

  app.use(createAuthRouter());
  app.use('/api', apiRouter);
  app.use('/ui', uiRouter);

  // Unknown /api paths return JSON, not the page shell.
  app.use('/api', (req, res) => res.status(404).json({ errors: ['Not found'] }));

  // The page shell needs a session in Supabase mode; its assets do not.
  // Matched on the decoded path, the same one express.static serves, so
  // /%69ndex.html cannot skip the check.
  const guardPage = requireUser('page');
  app.get('*', (req, res, next) => {
    let path = req.path;
    try {
      path = decodeURIComponent(path);
    } catch (_) {
      /* malformed escape: express.static rejects it too */
    }
    return path === '/' || path === '/index.html' ? guardPage(req, res, next) : next();
  });
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Centralized error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ errors: ['Request body too large'] });
    }
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({ errors: ['Invalid JSON body'] });
    }
    logger.error('Unhandled error', err);
    return res.status(500).json({ errors: ['Internal server error'] });
  });

  return app;
}

module.exports = { createApp };
