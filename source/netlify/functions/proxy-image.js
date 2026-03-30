/**
 * 外部画像プロキシ（CORS回避）
 * Paper内の外部URL画像をサーバー経由で取得してクライアントに返す
 */
export default async (req) => {
  const url = new URL(req.url);
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl || (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://'))) {
    return new Response('Invalid URL', { status: 400 });
  }
  try {
    const res = await fetch(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return new Response(null, { status: res.status });
    const buf = await res.arrayBuffer();
    return new Response(buf, {
      headers: { 'Content-Type': res.headers.get('Content-Type') || 'image/jpeg' }
    });
  } catch (err) {
    return new Response(null, { status: 502 });
  }
};
