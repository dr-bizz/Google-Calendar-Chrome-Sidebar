export default {
  async fetch(request, env) {
    const corsOrigin = env.EXTENSION_ID
      ? `chrome-extension://${env.EXTENSION_ID}`
      : '*';

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': corsOrigin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { 'Access-Control-Allow-Origin': corsOrigin },
      });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/github/token') {
      return new Response('Not found', {
        status: 404,
        headers: { 'Access-Control-Allow-Origin': corsOrigin },
      });
    }

    try {
      const { code } = await request.json();
      if (!code || typeof code !== 'string') {
        return Response.json({ error: 'Missing or invalid code' }, {
          status: 400,
          headers: { 'Access-Control-Allow-Origin': corsOrigin },
        });
      }

      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
        }),
      });

      const data = await tokenResponse.json();

      if (data.error) {
        return Response.json({ error: data.error_description || data.error }, {
          status: 400,
          headers: { 'Access-Control-Allow-Origin': corsOrigin },
        });
      }

      return Response.json({ access_token: data.access_token }, {
        headers: { 'Access-Control-Allow-Origin': corsOrigin },
      });
    } catch (e) {
      return Response.json({ error: 'Internal error' }, {
        status: 500,
        headers: { 'Access-Control-Allow-Origin': corsOrigin },
      });
    }
  },
};
