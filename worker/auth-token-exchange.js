export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Derive CORS origin from the request — only allow chrome-extension:// origins
    const requestOrigin = request.headers.get('Origin') || '';
    const corsOrigin = requestOrigin.startsWith('chrome-extension://')
      ? requestOrigin
      : null;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      if (!corsOrigin) {
        return new Response('Forbidden', { status: 403 });
      }
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': corsOrigin,
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // For GET routes (auth/callback), extract extension ID from query param or cookie
    // For POST routes, derive from Origin header
    const extId = url.searchParams.get('ext_id')
      || getCookie(request, 'ext_id')
      || (corsOrigin ? corsOrigin.replace('chrome-extension://', '') : null);

    // Route table
    const routes = {
      '/google/auth': handleGoogleAuth,
      '/google/callback': handleGoogleCallback,
      '/google/refresh': handlePost(handleGoogleRefresh),
      '/github/auth': handleGitHubAuth,
      '/github/callback': handleGitHubCallback,
      '/github/retrieve': handlePost(handleGitHubRetrieve),
      '/revoke': handlePost(handleRevoke),
    };

    const handler = routes[path];
    if (!handler) {
      return new Response('Not found', {
        status: 404,
        headers: corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {},
      });
    }

    try {
      return await handler(request, url, env, corsOrigin, extId);
    } catch (e) {
      return Response.json({ error: 'Internal error' }, {
        status: 500,
        headers: corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {},
      });
    }
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const match = header.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`));
  return match ? match.split('=')[1] : null;
}

function extensionRedirect(extId, fragment) {
  if (!extId) {
    return new Response('Missing extension ID', { status: 400 });
  }
  const targetUrl = `chrome-extension://${extId}/oauth_callback.html#${fragment}`;
  // Serve an intermediate HTML page instead of a 302 redirect.
  // Brave (and some other browsers) block HTTP redirects to chrome-extension:// URLs.
  // Client-side navigation via window.location works in all browsers.
  const html = `<!DOCTYPE html>
<html><head><title>Completing sign-in...</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    display: flex; justify-content: center; align-items: center; min-height: 100vh;
    margin: 0; background: #f8f9fa; color: #202124; text-align: center; }
  .container { padding: 40px; }
  a { color: #1a73e8; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
<script>window.location.href = ${JSON.stringify(targetUrl)};</script>
</head><body><div class="container">
  <p>Completing sign-in...</p>
  <p><a href="${targetUrl.replace(/"/g, '&quot;')}">Click here if you are not redirected automatically</a></p>
</div></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function errorRedirect(extId, message, provider) {
  return extensionRedirect(extId, `error=${encodeURIComponent(message)}&provider=${provider}`);
}

/**
 * Wraps a POST-only handler: validates method, parses JSON body, adds CORS.
 */
function handlePost(handler) {
  return async (request, url, env, corsOrigin, extId) => {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', {
        status: 405,
        headers: corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {},
      });
    }

    if (!corsOrigin) {
      return Response.json({ error: 'Forbidden: invalid origin' }, { status: 403 });
    }

    let body = {};
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, {
        status: 400,
        headers: { 'Access-Control-Allow-Origin': corsOrigin },
      });
    }

    const result = await handler(body, request, url, env);
    return new Response(result.body, {
      status: result.status,
      headers: {
        ...Object.fromEntries(result.headers),
        'Access-Control-Allow-Origin': corsOrigin,
      },
    });
  };
}

// ---------------------------------------------------------------------------
// Google OAuth Routes
// ---------------------------------------------------------------------------

async function handleGoogleAuth(_request, url, env, _corsOrigin, extId) {
  if (!extId) {
    return new Response('Missing ext_id query parameter', { status: 400 });
  }

  const state = crypto.randomUUID();
  const redirectUri = `${url.origin}/google/callback`;

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  const headers = new Headers({
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
  });
  // Store state and extension ID in cookies for the callback
  headers.append('Set-Cookie', `google_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/`);
  headers.append('Set-Cookie', `ext_id=${extId}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/`);

  return new Response(null, { status: 302, headers });
}

async function handleGoogleCallback(request, url, env, _corsOrigin, extId) {
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (!extId) {
    return new Response('Missing extension ID', { status: 400 });
  }

  if (error) {
    return errorRedirect(extId, error, 'google');
  }

  // Validate CSRF state
  const cookieState = getCookie(request, 'google_oauth_state');
  if (!state || !cookieState || state !== cookieState) {
    return errorRedirect(extId, 'State mismatch - possible CSRF', 'google');
  }

  if (!code) {
    return errorRedirect(extId, 'Missing authorization code', 'google');
  }

  const redirectUri = `${url.origin}/google/callback`;

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });

  const tokenData = await tokenRes.json();

  if (tokenData.error) {
    return errorRedirect(extId, tokenData.error_description || tokenData.error, 'google');
  }

  if (!tokenData.refresh_token) {
    return errorRedirect(extId, 'No refresh token received. Please revoke app access in Google Account settings and try again.', 'google');
  }

  // Store refresh token in KV
  try {
    const sessionToken = crypto.randomUUID();
    await env.AUTH_TOKENS.put(`google:${sessionToken}`, JSON.stringify({
      refreshToken: tokenData.refresh_token,
      createdAt: Date.now(),
    }), { expirationTtl: 7776000 });

    const fragment = new URLSearchParams({
      session_token: sessionToken,
      access_token: tokenData.access_token,
      expires_in: String(tokenData.expires_in),
      provider: 'google',
    }).toString();

    return extensionRedirect(extId, fragment);
  } catch (e) {
    return errorRedirect(extId, 'Failed to save session. Please try again.', 'google');
  }
}

async function handleGoogleRefresh(body, _request, _url, env) {
  const { session_token } = body;
  if (!session_token) {
    return Response.json({ error: 'Missing session_token' }, { status: 400, headers: new Headers() });
  }

  const stored = await env.AUTH_TOKENS.get(`google:${session_token}`);
  if (!stored) {
    return Response.json({ error: 'Session not found' }, { status: 404, headers: new Headers() });
  }

  const { refreshToken } = JSON.parse(stored);

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const tokenData = await tokenRes.json();

  if (tokenData.error) {
    if (tokenData.error === 'invalid_grant') {
      await env.AUTH_TOKENS.delete(`google:${session_token}`);
    }
    return Response.json({ error: tokenData.error_description || tokenData.error }, {
      status: 400,
      headers: new Headers(),
    });
  }

  return Response.json({
    access_token: tokenData.access_token,
    expires_in: tokenData.expires_in,
  }, { headers: new Headers() });
}

// ---------------------------------------------------------------------------
// GitHub OAuth Routes
// ---------------------------------------------------------------------------

async function handleGitHubAuth(_request, url, env, _corsOrigin, extId) {
  if (!extId) {
    return new Response('Missing ext_id query parameter', { status: 400 });
  }

  const state = crypto.randomUUID();

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${url.origin}/github/callback`,
    scope: 'repo',
    state,
  });

  const headers = new Headers({
    Location: `https://github.com/login/oauth/authorize?${params}`,
  });
  headers.append('Set-Cookie', `github_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/`);
  headers.append('Set-Cookie', `ext_id=${extId}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/`);

  return new Response(null, { status: 302, headers });
}

async function handleGitHubCallback(request, url, env, _corsOrigin, extId) {
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (!extId) {
    return new Response('Missing extension ID', { status: 400 });
  }

  if (error) {
    return errorRedirect(extId, url.searchParams.get('error_description') || error, 'github');
  }

  // Validate CSRF state
  const cookieState = getCookie(request, 'github_oauth_state');
  if (!state || !cookieState || state !== cookieState) {
    return errorRedirect(extId, 'State mismatch - possible CSRF', 'github');
  }

  if (!code) {
    return errorRedirect(extId, 'Missing authorization code', 'github');
  }

  // Exchange code for access token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const tokenData = await tokenRes.json();

  if (tokenData.error) {
    return errorRedirect(extId, tokenData.error_description || tokenData.error, 'github');
  }

  // Store access token in KV
  try {
    const sessionToken = crypto.randomUUID();
    await env.AUTH_TOKENS.put(`github:${sessionToken}`, JSON.stringify({
      accessToken: tokenData.access_token,
      createdAt: Date.now(),
    }), { expirationTtl: 7776000 });

    const fragment = new URLSearchParams({
      session_token: sessionToken,
      provider: 'github',
    }).toString();

    return extensionRedirect(extId, fragment);
  } catch (e) {
    return errorRedirect(extId, 'Failed to save session. Please try again.', 'github');
  }
}

async function handleGitHubRetrieve(body, _request, _url, env) {
  const { session_token } = body;
  if (!session_token) {
    return Response.json({ error: 'Missing session_token' }, { status: 400, headers: new Headers() });
  }

  const stored = await env.AUTH_TOKENS.get(`github:${session_token}`);
  if (!stored) {
    return Response.json({ error: 'Session not found' }, { status: 404, headers: new Headers() });
  }

  const { accessToken } = JSON.parse(stored);
  return Response.json({ access_token: accessToken }, { headers: new Headers() });
}

// ---------------------------------------------------------------------------
// Revoke Route
// ---------------------------------------------------------------------------

async function handleRevoke(body, _request, _url, env) {
  const { session_token, provider } = body;
  if (!session_token || !provider) {
    return Response.json({ error: 'Missing session_token or provider' }, {
      status: 400,
      headers: new Headers(),
    });
  }

  if (provider !== 'google' && provider !== 'github') {
    return Response.json({ error: 'Invalid provider' }, { status: 400, headers: new Headers() });
  }

  const kvKey = `${provider}:${session_token}`;

  // For Google, also call their revoke endpoint (best-effort)
  if (provider === 'google') {
    const stored = await env.AUTH_TOKENS.get(kvKey);
    if (stored) {
      const { refreshToken } = JSON.parse(stored);
      if (refreshToken) {
        fetch(`https://oauth2.googleapis.com/revoke?token=${refreshToken}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }).catch(() => {});
      }
    }
  }

  await env.AUTH_TOKENS.delete(kvKey);

  return Response.json({ success: true }, { headers: new Headers() });
}
