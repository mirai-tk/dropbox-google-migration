/**
 * デスクトップ（pywebview + FastAPI）かどうか。
 * pywebview の window.pywebview は注入が遅れることがあり、VITE_DESKTOP 未注入ビルドでは
 * OAuth が WebView 内 location 遷移になるため、オリジン・API でも判定する。
 */

const SHELL_KEY = 'paperDesktopShell';

export function isLoopbackDesktopDefaultPort() {
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  const p = window.location.port || '';
  if (h !== '127.0.0.1' && h !== 'localhost') return false;
  return p === '8765';
}

export function matchesDesktopApiOriginEnv() {
  if (typeof window === 'undefined') return false;
  const raw = import.meta.env.VITE_DESKTOP_API_ORIGIN;
  if (typeof raw !== 'string' || !raw.trim()) return false;
  try {
    const u = new URL(raw);
    const loc = window.location;
    const portMatch = (loc.port || '') === (u.port || '');
    const hostMatch =
      loc.hostname === u.hostname ||
      (u.hostname === '127.0.0.1' && loc.hostname === 'localhost') ||
      (u.hostname === 'localhost' && loc.hostname === '127.0.0.1');
    return hostMatch && portMatch;
  } catch {
    return false;
  }
}

function hasShellSessionFlag() {
  try {
    return typeof window !== 'undefined' && sessionStorage.getItem(SHELL_KEY) === '1';
  } catch {
    return false;
  }
}

export function isDesktopShell() {
  if (import.meta.env.VITE_DESKTOP === 'true') return true;
  if (typeof window !== 'undefined' && window.pywebview) return true;
  if (hasShellSessionFlag()) return true;
  if (isLoopbackDesktopDefaultPort()) return true;
  if (matchesDesktopApiOriginEnv()) return true;
  return false;
}

/**
 * FastAPI 経由で OAuth・トークン更新するか。
 * デスクトップは isDesktopShell() だけで常に true（VITE_AUTH_MODE は不要）。
 * ブラウザ単体デプロイだけ VITE_AUTH_MODE=server でサーバー交換を有効にする。
 */
export function usesBackendOAuth() {
  return (
    isDesktopShell() ||
    import.meta.env.VITE_AUTH_MODE === 'server'
  );
}
