/**
 * Dropbox OAuth 認証コード交換
 */
export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
  const appKey = process.env.VITE_DROPBOX_APP_KEY;
  const appSecret = process.env.VITE_DROPBOX_APP_SECRET;
  if (!appKey || !appSecret) {
    return new Response(JSON.stringify({ error: 'Server config: missing Dropbox OAuth credentials' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  try {
    const body = await req.json();
    const { code, redirect_uri, code_verifier } = body;
    const response = await fetch('https://api.dropbox.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code || '',
        grant_type: 'authorization_code',
        client_id: appKey,
        client_secret: appSecret,
        redirect_uri: redirect_uri || '',
        code_verifier: code_verifier || ''
      })
    });
    const data = await response.json();
    return new Response(JSON.stringify(data), {
      status: response.ok ? 200 : response.status,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
