import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

function genericOAuthMiddleware(env) {
  return {
    name: 'oauth-middleware',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        // Google Token
        if (req.url === '/api/google/token' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => body += chunk.toString());
          req.on('end', async () => {
            try {
              const { code, redirect_uri } = JSON.parse(body);
              const response = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  code,
                  client_id: env.VITE_GOOGLE_CLIENT_ID,
                  client_secret: env.VITE_GOOGLE_CLIENT_SECRET,
                  redirect_uri: redirect_uri || 'postmessage',
                  grant_type: 'authorization_code'
                })
              });
              const data = await response.json();
              if (!response.ok) res.statusCode = response.status;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(data));
            } catch (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        // Google Refresh
        if (req.url === '/api/google/refresh' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => body += chunk.toString());
          req.on('end', async () => {
            try {
              const { refresh_token } = JSON.parse(body);
              console.log('[API] Google refresh token request received');
              if (!refresh_token) {
                console.warn('[API] Google refresh: no refresh_token in request');
              }
              const response = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  refresh_token,
                  client_id: env.VITE_GOOGLE_CLIENT_ID,
                  client_secret: env.VITE_GOOGLE_CLIENT_SECRET,
                  grant_type: 'refresh_token'
                })
              });
              const data = await response.json();
              if (data.access_token) {
                console.log('[API] Google refresh: success, expires_in=', data.expires_in);
              } else {
                console.warn('[API] Google refresh: failed', data.error || data.error_description || data);
              }
              if (!response.ok) res.statusCode = response.status;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(data));
            } catch (err) {
              console.error('[API] Google refresh error:', err.message);
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        // Dropbox Token
        if (req.url === '/api/dropbox/token' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => body += chunk.toString());
          req.on('end', async () => {
            try {
              const { code, redirect_uri, code_verifier } = JSON.parse(body);
              const response = await fetch('https://api.dropbox.com/oauth2/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  code,
                  grant_type: 'authorization_code',
                  client_id: env.VITE_DROPBOX_APP_KEY,
                  client_secret: env.VITE_DROPBOX_APP_SECRET,
                  redirect_uri,
                  code_verifier
                })
              });
              const data = await response.json();
              if (!response.ok) res.statusCode = response.status;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(data));
            } catch (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        // 外部画像プロキシ（CORS回避: Paper内の外部URL画像をサーバー経由で取得）
        if (req.url?.startsWith('/api/proxy-image')) {
          try {
            const q = req.url.indexOf('?');
            const params = q >= 0 ? new URLSearchParams(req.url.slice(q)) : null;
            const url = params?.get('url') ? decodeURIComponent(params.get('url')) : '';
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
              res.statusCode = 400;
              res.end('Invalid URL');
              return;
            }
            const imgRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!imgRes.ok) {
              res.statusCode = imgRes.status;
              res.end();
              return;
            }
            const buf = await imgRes.arrayBuffer();
            res.setHeader('Content-Type', imgRes.headers.get('Content-Type') || 'image/jpeg');
            res.end(Buffer.from(buf));
          } catch (err) {
            res.statusCode = 502;
            res.end();
          }
          return;
        }

        // Dropbox Refresh
        if (req.url === '/api/dropbox/refresh' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => body += chunk.toString());
          req.on('end', async () => {
            try {
              const { refresh_token } = JSON.parse(body);
              const response = await fetch('https://api.dropbox.com/oauth2/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  refresh_token,
                  grant_type: 'refresh_token',
                  client_id: env.VITE_DROPBOX_APP_KEY,
                  client_secret: env.VITE_DROPBOX_APP_SECRET
                })
              });
              const data = await response.json();
              if (!response.ok) res.statusCode = response.status;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(data));
            } catch (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }
        next();
      });
    }
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const isDesktop =
    mode === 'desktop' || env.VITE_DESKTOP === 'true';
  const desktopApiOrigin =
    env.VITE_DESKTOP_API_ORIGIN || 'http://127.0.0.1:8765';

  return {
    base: isDesktop ? './' : '/',
    // デスクトップビルドは本番経路を一本化（.env.desktop と併用可）
    define: isDesktop
      ? {
          'import.meta.env.VITE_DESKTOP': JSON.stringify('true'),
          'import.meta.env.VITE_USE_NATIVE_ENGINE': JSON.stringify('true'),
          'import.meta.env.VITE_DESKTOP_API_ORIGIN': JSON.stringify(
            env.VITE_DESKTOP_API_ORIGIN || 'http://127.0.0.1:8765'
          ),
        }
      : undefined,
    plugins: [
      react(),
      ...(isDesktop ? [] : [genericOAuthMiddleware(env)]),
    ],
    server: {
      proxy: isDesktop
        ? {
            '/api': {
              target: desktopApiOrigin,
              changeOrigin: true,
            },
            '/proxy': {
              target: desktopApiOrigin,
              changeOrigin: true,
            },
          }
        : {
            '/proxy/dropbox-image': {
              target: 'https://paper-attachments.dropboxusercontent.com',
              changeOrigin: true,
              rewrite: (path) =>
                path.replace(/^\/proxy\/dropbox-image/, ''),
            },
          },
    },
  };
});
