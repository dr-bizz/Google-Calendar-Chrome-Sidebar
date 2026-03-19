export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/github/token') {
      return new Response('Not found', { status: 404 });
    }

    try {
      const { code } = await request.json();
      if (!code) {
        return Response.json({ error: 'Missing code' }, { status: 400 });
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
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      }

      return Response.json({ access_token: data.access_token }, {
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    } catch (e) {
      return Response.json({ error: 'Internal error' }, {
        status: 500,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }
  },
};
