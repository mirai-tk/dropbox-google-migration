/**
 * Google OAuth 認証コード交換
 * クライアントから受け取った code を access_token に交換する
 */
export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
  const clientId = process.env.VITE_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.VITE_GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return new Response(JSON.stringify({ error: 'Server config: missing Google OAuth credentials' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  try {
    const body = await req.json();
    const { code, redirect_uri } = body;
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code || '',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirect_uri || 'postmessage',
        grant_type: 'authorization_code'
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
