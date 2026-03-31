import React, { useState, useEffect, useCallback } from 'react';
import { Files, Home, FolderOpen, RefreshCw, ShieldCheck, ExternalLink, Folder, HardDrive, ChevronRight } from 'lucide-react';

// Hooks
import { useDropbox } from './hooks/useDropbox';
import { useGoogleDrive } from './hooks/useGoogleDrive';
import { useConverter } from './hooks/useConverter';
import { generateCodeVerifier, generateCodeChallenge } from './utils/pkce';
// Components
import { Sidebar } from './components/Sidebar';
import { ExplorerColumn } from './components/ExplorerColumn';
import { FileListItem } from './components/FileListItem';
import { EditorView } from './components/EditorView';
import { LogViewer } from './components/LogViewer';
import { StatusToast } from './components/StatusToast';
import { FolderPickerModal } from './components/FolderPickerModal';
import { isDesktopShell, usesBackendOAuth } from './utils/desktopEnv';

const App = () => {
  /** /api/app/shell 確定後に再レンダー（sessionStorage と Keychain 復元のため） */
  const [desktopShellRevision, setDesktopShellRevision] = useState(0);
  const DROPBOX_APP_KEY = import.meta.env.VITE_DROPBOX_APP_KEY;
  const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  const SCOPES =
    'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/documents';

  const [status, setStatus] = useState(null);
  const [activeTab, setActiveTab] = useState('scan');
  const [content, setContent] = useState('');
  const [logs, setLogs] = useState([]);
  /** デスクトップでは Keychain 復元が終わるまで Dropbox 初期化を遅らせる */
  const [desktopKeyringHydrated, setDesktopKeyringHydrated] = useState(
    () => !isDesktopShell()
  );
  const [desktopAppVersion, setDesktopAppVersion] = useState(null);
  const [desktopUpdateInfo, setDesktopUpdateInfo] = useState(null);
  const [desktopUpdateFetching, setDesktopUpdateFetching] = useState(false);
  const [desktopMemory, setDesktopMemory] = useState(null);
  const [desktopGcLoading, setDesktopGcLoading] = useState(false);

  const fetchDesktopMemory = useCallback(async () => {
    if (!isDesktopShell()) return;
    try {
      const r = await fetch('/api/app/memory');
      const j = await r.json();
      setDesktopMemory(j);
    } catch {
      setDesktopMemory(null);
    }
  }, []);

  const runDesktopGc = useCallback(async () => {
    if (!isDesktopShell()) return;
    setDesktopGcLoading(true);
    try {
      await fetch('/api/app/memory/gc', { method: 'POST' });
      await fetchDesktopMemory();
    } catch {
      await fetchDesktopMemory();
    } finally {
      setDesktopGcLoading(false);
    }
  }, [fetchDesktopMemory]);

  const runDesktopUpdateCheck = useCallback(async () => {
    if (!isDesktopShell()) return;
    setDesktopUpdateFetching(true);
    try {
      const r = await fetch('/api/app/update-check');
      const j = await r.json();
      setDesktopUpdateInfo(j);
    } catch (e) {
      setDesktopUpdateInfo({
        error: e?.message || 'アップデート確認に失敗しました',
      });
    } finally {
      setDesktopUpdateFetching(false);
    }
  }, []);

  useEffect(() => {
    if (!isDesktopShell()) return;
    let cancelled = false;
    (async () => {
      try {
        const vr = await fetch('/api/app/version');
        const vj = await vr.json();
        if (!cancelled) setDesktopAppVersion(vj.version);
      } catch {
        if (!cancelled) setDesktopAppVersion(null);
      }
      if (!cancelled) await runDesktopUpdateCheck();
    })();
    return () => {
      cancelled = true;
    };
  }, [runDesktopUpdateCheck]);

  useEffect(() => {
    if (!isDesktopShell()) return;
    fetchDesktopMemory();
    const t = setInterval(fetchDesktopMemory, 3000);
    return () => clearInterval(t);
  }, [fetchDesktopMemory]);

  // デスクトップシェルを /api/app/shell で確定（カスタムポート等で同期判定だけだと足りない場合）
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (sessionStorage.getItem('paperDesktopShell') === '1') {
        setDesktopShellRevision((n) => n + 1);
        return;
      }
    } catch {
      /* ignore */
    }
    let cancelled = false;
    fetch('/api/app/shell')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j?.desktop) return;
        const before = isDesktopShell();
        try {
          sessionStorage.setItem('paperDesktopShell', '1');
        } catch {
          /* ignore */
        }
        if (!before && isDesktopShell()) {
          setDesktopKeyringHydrated(false);
        }
        setDesktopShellRevision((n) => n + 1);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onReady = () => setDesktopShellRevision((n) => n + 1);
    window.addEventListener('pywebviewready', onReady);
    return () => window.removeEventListener('pywebviewready', onReady);
  }, []);

  const addLog = React.useCallback((log) => {
    const ensureTime = (l) => {
      if (l.time) return l;
      return { ...l, time: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) };
    };
    setLogs(prev => {
      if (log.id) {
        const existingIdx = prev.findIndex(l => l.id === log.id);
        if (existingIdx !== -1) {
          const newLogs = [...prev];
          const existing = newLogs[existingIdx];
          const merged = { ...existing };
          for (const k of Object.keys(log)) {
            if (log[k] !== undefined) merged[k] = log[k];
          }
          if (!merged.message && existing.message) merged.message = existing.message;
          // ファイル行の進捗更新でパスを消さないための特例（migrate- の完了メッセージまで巻き込まない）
          if (
            log.id?.startsWith('file-') &&
            merged.message &&
            !merged.message.includes('/') &&
            existing.message &&
            existing.message.includes('/')
          ) {
            merged.message = existing.message;
          }
          newLogs[existingIdx] = ensureTime(merged);
          return newLogs;
        }
      }
      const newLog = ensureTime(log);
      if (newLog.id && !newLog.message) newLog.message = '処理中...';
      const maxTotal = 200;
      if (prev.length < maxTotal - 1) return [...prev, newLog];
      const errors = prev.filter(l => l.type === 'error');
      const migrateLogs = prev.filter(l => l.id?.startsWith('migrate-'));
      const nonErrors = prev.filter(l => l.type !== 'error' && !l.id?.startsWith('migrate-'));
      const maxNonErrors = Math.max(0, maxTotal - 1 - errors.length - migrateLogs.length);
      const trimmedNonErrors = nonErrors.slice(-maxNonErrors);
      const nonErrorsSet = new Set(trimmedNonErrors);
      const trimmed = prev.filter(l => l.type === 'error' || l.id?.startsWith('migrate-') || nonErrorsSet.has(l));
      return [...trimmed, newLog];
    });
  }, []);

  const clearLogs = () => setLogs([]);
  const [currentFileName, setCurrentFileName] = useState('');
  const [currentFilePath, setCurrentFilePath] = useState('');
  const [googleClient, setGoogleClient] = useState(null);
  // Hooks Initialization
  const dropbox = useDropbox(setStatus);
  const refreshGoogleTokenRef = React.useRef(null);
  const gdrive = useGoogleDrive(setStatus, async () => {
    const fn = refreshGoogleTokenRef.current;
    if (typeof fn !== 'function') return null;
    try {
      return await fn();
    } catch {
      return null;
    }
  });

  const googleTokenRefreshTimerRef = React.useRef(null);
  const dropboxTokenRefreshTimerRef = React.useRef(null);
  const scheduleDropboxRefreshRef = React.useRef(null);
  const gDriveTokenRef = React.useRef(gdrive.gDriveToken);

  const setupDropboxRefreshTimer = useCallback((expiresIn) => {
    if (dropboxTokenRefreshTimerRef.current) clearInterval(dropboxTokenRefreshTimerRef.current);
    const refreshInterval = Math.max((expiresIn - 300) * 1000, 60000);
    console.log(`[Dropbox] Scheduling token refresh in ${refreshInterval / 1000}s`);
    dropboxTokenRefreshTimerRef.current = setInterval(async () => {
      console.log('[Dropbox] Refreshing token...');
      const data = await dropbox.refreshDropboxToken();
      if (data && data.access_token) {
        scheduleDropboxRefreshRef.current?.(data.expires_in || 14400);
      }
    }, refreshInterval);
  }, [dropbox]);
  scheduleDropboxRefreshRef.current = setupDropboxRefreshTimer;

  // Sync refs with state
  useEffect(() => { gDriveTokenRef.current = gdrive.gDriveToken; }, [gdrive.gDriveToken]);

  // Google token refresh promise resolver
  const gDriveRefreshResolverRef = React.useRef(null);

  const refreshGoogleToken = useCallback(async () => {
    if (gDriveRefreshResolverRef.current) {
      console.log('Skip duplicate refresh call');
      return gDriveRefreshResolverRef.current.promise;
    }

    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    gDriveRefreshResolverRef.current = { promise, resolve, reject };

    if (usesBackendOAuth()) {
      const refreshToken = localStorage.getItem('google_refresh_token');
      if (refreshToken) {
        console.log('[Auth] Refreshing server token...');
        let timeoutId;
        try {
          const controller = new AbortController();
          timeoutId = setTimeout(() => controller.abort(), 30000);
          const res = await fetch('/api/google/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: refreshToken }),
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          const data = await res.json();
          if (data.access_token) {
            console.log('[Auth] Google token リフレッシュ成功, expires_in=', data.expires_in);
            if (data.refresh_token) {
              localStorage.setItem('google_refresh_token', data.refresh_token);
            }
            gDriveTokenRef.current = data.access_token;
            gdrive.setGDriveToken(data.access_token);
            if (googleTokenRefreshTimerRef.current) clearInterval(googleTokenRefreshTimerRef.current);
            const refreshInterval = Math.max((data.expires_in - 300) * 1000, 60000);
            console.log(`[Google] Scheduling token refresh in ${refreshInterval / 1000}s`);
            googleTokenRefreshTimerRef.current = setInterval(refreshGoogleToken, refreshInterval);
            resolve(data.access_token);
            gDriveRefreshResolverRef.current = null;
            return promise;
          }
          if (!res.ok) {
            const errMsg = data.error || data.error_description || `Refresh failed (${res.status})`;
            reject(new Error(errMsg));
            gDriveRefreshResolverRef.current = null;
            return promise;
          }
          if (data.error) {
            const errMsg = data.error_description || data.error;
            reject(new Error(errMsg));
            gDriveRefreshResolverRef.current = null;
            return promise;
          }
        } catch (e) {
          clearTimeout(timeoutId);
          console.error('[Auth] Server token refresh failed:', e);
          reject(e);
          gDriveRefreshResolverRef.current = null;
          return promise;
        }
      }

      if (!googleClient) {
         reject('Google Client not initialized');
         gDriveRefreshResolverRef.current = null;
         return promise;
      }
      googleClient.requestCode();
    } else {
      // Client mode implicit refresh
      if (!googleClient) {
        reject('Google Client not initialized');
        gDriveRefreshResolverRef.current = null;
        return promise;
      }
      googleClient.requestAccessToken({ prompt: '' });
      setTimeout(() => {
        if (gDriveRefreshResolverRef.current) {
           gDriveRefreshResolverRef.current.reject('Token refresh timed out');
           gDriveRefreshResolverRef.current = null;
        }
      }, 30000);
    }

    return promise;
  }, [googleClient, gdrive]);

  React.useEffect(() => {
    refreshGoogleTokenRef.current = refreshGoogleToken;
  }, [refreshGoogleToken]);

  // WebView / ブラウザのバックグラウンドで setInterval が遅れるとアクセス切れになるため、フォアグラウンド復帰で先回りリフレッシュ
  React.useEffect(() => {
    let last = 0;
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - last < 120000) return;
      last = now;
      if (!usesBackendOAuth()) return;
      if (!localStorage.getItem('google_refresh_token')) return;
      refreshGoogleTokenRef.current?.().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Desktop: Keychain（トークン）+ 設定ファイル（フォルダ位置）を起動時に復元
  useEffect(() => {
    if (!isDesktopShell()) return;
    let cancelled = false;
    (async () => {
      try {
        const [rTok, rSet] = await Promise.all([
          fetch('/api/session/tokens'),
          fetch('/api/session/settings'),
        ]);
        if (!rTok.ok || !rSet.ok || cancelled) return;
        const d = await rTok.json();
        const s = await rSet.json();
        // フォルダ位置は設定ファイル → 先に localStorage / state へ（トークンより前）
        if (typeof s.dropbox_current_path === 'string') {
          localStorage.setItem('dropbox_current_path', s.dropbox_current_path);
          dropbox.setCurrentPath(s.dropbox_current_path);
        }
        if (s.gdrive_browser_path) {
          try {
            const parsed = JSON.parse(s.gdrive_browser_path);
            localStorage.setItem('gdrive_browser_path', s.gdrive_browser_path);
            gdrive.setGDriveBrowserPath(parsed);
          } catch (e) {
            console.warn('[session] gdrive_browser_path restore', e);
          }
        }
        if (typeof s.gdrive_selected_folder_id === 'string') {
          localStorage.setItem('gdrive_selected_folder_id', s.gdrive_selected_folder_id);
          gdrive.setSelectedFolderId(s.gdrive_selected_folder_id);
        }
        if (d.google_refresh) localStorage.setItem('google_refresh_token', d.google_refresh);
        if (d.google_access) gdrive.setGDriveToken(d.google_access);
        if (localStorage.getItem('google_refresh_token')) {
          try {
            await refreshGoogleToken();
          } catch (e) {
            console.warn('[session] keyring refresh', e);
          }
        }
        if (d.dropbox_refresh) dropbox.setDbRefreshToken(d.dropbox_refresh);
        if (d.dropbox_access) dropbox.setDbToken(d.dropbox_access);
        if (d.dropbox_ns_id) dropbox.setRootNamespaceId(d.dropbox_ns_id);
      } catch (e) {
        console.warn('[session] keyring restore', e);
      } finally {
        if (!cancelled) setDesktopKeyringHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 起動時 + シェル確定後の再試行
  }, [desktopShellRevision]);

  const converter = useConverter(
    gdrive.selectedFolderId,
    gdrive.gDriveBrowserPath,
    setStatus,
    setContent,
    setCurrentFileName,
    setCurrentFilePath,
    setActiveTab,
    gdrive.fetchGDriveContents,
    dropbox.getApiHeaders,
    dropbox.asciiSafeJson,
    dropbox.handleDropboxLogout,
    gdrive.handleGoogleLogout,
    dropbox.listFolderRecursive,
    dropbox.dbTokenRef,
    gDriveTokenRef,
    refreshGoogleToken,
    dropbox.refreshDropboxToken,
    addLog,
    dropbox.rootNamespaceId
  );

  // Google Services Index (GSI) Initialization
  useEffect(() => {
    const initGSI = () => {
      try {
        if (window.google) {
          let client;
          if (isDesktopShell()) {
            // デスクトップは GSI + PKCE がサーバー交換と噛み合わず redirect_uri_mismatch になりやすいため
            // /api/oauth/google/*（ブラウザ + 機密クライアント）を使う。Web では従来どおり GSI。
            client = null;
          } else if (usesBackendOAuth()) {
              client = window.google.accounts.oauth2.initCodeClient({
                client_id: GOOGLE_CLIENT_ID,
                scope: SCOPES,
                ux_mode: 'popup',
                callback: async (response) => {
                  if (response.code) {
                    try {
                      const res = await fetch('/api/google/token', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          code: response.code,
                          redirect_uri: 'postmessage',
                        }),
                      });
                      const data = await res.json();

                      if (data.access_token) {
                        gdrive.setGDriveToken(data.access_token);
                        if (data.refresh_token) {
                          localStorage.setItem('google_refresh_token', data.refresh_token);
                        }
                        setStatus({ type: 'success', message: 'Google ドライブに接続しました (Server Mode)' });

                        if (googleTokenRefreshTimerRef.current) clearInterval(googleTokenRefreshTimerRef.current);
                        const expiresIn = data.expires_in || 3600;
                        const refreshInterval = Math.max((expiresIn - 300) * 1000, 60000);
                        console.log(`[Google] Scheduling token refresh in ${refreshInterval / 1000}s`);
                        googleTokenRefreshTimerRef.current = setInterval(refreshGoogleToken, refreshInterval);

                        if (gDriveRefreshResolverRef.current) {
                          gDriveRefreshResolverRef.current.resolve(data.access_token);
                          gDriveRefreshResolverRef.current = null;
                        }
                      } else {
                        throw new Error(data.error || 'Token exchange failed');
                      }
                    } catch (err) {
                      console.error('Auth code exchange error:', err);
                      setStatus({ type: 'error', message: `認証エラー: ${err.message}` });
                      if (gDriveRefreshResolverRef.current) {
                        gDriveRefreshResolverRef.current.reject(err.message);
                        gDriveRefreshResolverRef.current = null;
                      }
                    }
                  }
                },
                error_callback: (err) => {
                  setStatus({ type: 'error', message: `GSIエラー: ${err.message}` });
                },
              });
          } else {
            // Implicit Flow (Client Mode - Default)
            client = window.google.accounts.oauth2.initTokenClient({
              client_id: GOOGLE_CLIENT_ID,
              scope: SCOPES,
              callback: (response) => {
                if (response.access_token) {
                  gdrive.setGDriveToken(response.access_token);
                  setStatus({ type: 'success', message: 'Google ドライブに接続しました' });

                  if (googleTokenRefreshTimerRef.current) clearInterval(googleTokenRefreshTimerRef.current);
                  const expiresIn = response.expires_in || 3600;
                  const refreshInterval = Math.max((expiresIn - 300) * 1000, 60000);
                  console.log(`[Google] Scheduling token refresh in ${refreshInterval / 1000}s`);
                  googleTokenRefreshTimerRef.current = setInterval(refreshGoogleToken, refreshInterval);

                  if (gDriveRefreshResolverRef.current) {
                    gDriveRefreshResolverRef.current.resolve(response.access_token);
                    gDriveRefreshResolverRef.current = null;
                  }
                } else if (response.error) {
                  if (gDriveRefreshResolverRef.current) {
                    gDriveRefreshResolverRef.current.reject(response.error_description || response.error);
                    gDriveRefreshResolverRef.current = null;
                  }
                  setStatus({ type: 'error', message: `認証エラー: ${response.error_description || response.error}` });
                }
              },
              error_callback: (err) => {
                setStatus({ type: 'error', message: `GSIエラー: ${err.message}` });
              }
            });
          }
          setGoogleClient(client);
        }
      } catch (err) {
        console.error('GSI Init Error:', err);
      }
    };

    let retryCount = 0;
    const checkInterval = setInterval(() => {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) {
        initGSI();
        clearInterval(checkInterval);
      } else {
        retryCount++;
        if (retryCount > 20) {
          clearInterval(checkInterval);
          setStatus({ type: 'error', message: 'Google APIの読み込みに失敗しました。ページを更新してください。' });
        }
      }
    }, 500);

    return () => {
      clearInterval(checkInterval);
      if (googleTokenRefreshTimerRef.current) {
        clearInterval(googleTokenRefreshTimerRef.current);
      }
      if (dropboxTokenRefreshTimerRef.current) {
        clearInterval(dropboxTokenRefreshTimerRef.current);
      }
    };
  }, []);

  // Status Auto-hide Logic
  useEffect(() => {
    if (status && status.message) {
      const timer = setTimeout(() => {
        setStatus(null);
      }, 5000); // 5 seconds
      return () => clearTimeout(timer);
    }
  }, [status]);

  // Desktop: OAuth トークンは Keychain（/api/session/sync）
  useEffect(() => {
    if (!isDesktopShell()) return;
    if (!desktopKeyringHydrated) return;
    const run = async () => {
      try {
        await fetch('/api/session/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            google_access: gdrive.gDriveToken,
            google_refresh: localStorage.getItem('google_refresh_token'),
            dropbox_access: dropbox.dbToken,
            dropbox_refresh: dropbox.dbRefreshToken,
            dropbox_ns_id: dropbox.rootNamespaceId,
          }),
        });
      } catch (e) {
        console.warn('[session] sync', e);
      }
    };
    run();
  }, [
    desktopKeyringHydrated,
    gdrive.gDriveToken,
    dropbox.dbToken,
    dropbox.dbRefreshToken,
    dropbox.rootNamespaceId,
  ]);

  // Desktop: フォルダ位置は設定ファイル（/api/session/settings/sync）
  useEffect(() => {
    if (!isDesktopShell()) return;
    if (!desktopKeyringHydrated) return;
    const run = async () => {
      try {
        await fetch('/api/session/settings/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dropbox_current_path: dropbox.currentPath ?? '',
            gdrive_browser_path: JSON.stringify(gdrive.gDriveBrowserPath),
            gdrive_selected_folder_id: gdrive.selectedFolderId ?? 'root',
          }),
        });
      } catch (e) {
        console.warn('[session] settings sync', e);
      }
    };
    run();
  }, [
    desktopKeyringHydrated,
    gdrive.gDriveBrowserPath,
    gdrive.selectedFolderId,
    dropbox.currentPath,
  ]);

  // Google セッション復元（Web のみ。デスクトップは上記 Keychain + 設定ファイル復元で処理）
  useEffect(() => {
    if (isDesktopShell()) return;
    const refreshToken = localStorage.getItem('google_refresh_token');
    if (usesBackendOAuth() && refreshToken) {
      refreshGoogleToken().then(() => {
        console.log('[Auth] Google session restored');
      }).catch((err) => {
        console.warn('[Auth] Google session restore failed:', err?.message || err);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dropbox Logic Initialization（デスクトップは Keychain 復元後に実行）
  useEffect(() => {
    if (isDesktopShell() && !desktopKeyringHydrated) return;

    const initDropbox = async () => {
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get('code');

      // デスクトップ: Dropbox は別 URL で完結。メインの ?code= は Google redirect の可能性あり（scope あり）
      if (isDesktopShell() && code) {
        const scope = urlParams.get('scope');
        if (scope && scope.includes('googleapis')) {
          return;
        }
        window.history.replaceState(null, null, window.location.pathname);
      } else if (code) {
        // Authorization Code Flow (PKCE)
        const codeVerifier = localStorage.getItem('dropbox_code_verifier');
        const redirectUri = (window.location.origin + window.location.pathname).replace(/\/$/, "");

        try {
          let data;
          if (usesBackendOAuth()) {
            const response = await fetch('/api/dropbox/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code, redirect_uri: redirectUri, code_verifier: codeVerifier })
            });
            if (!response.ok) throw new Error('Server token exchange failed');
            data = await response.json();
          } else {
            const response = await fetch('https://api.dropbox.com/oauth2/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: redirectUri,
                client_id: DROPBOX_APP_KEY,
                code_verifier: codeVerifier
              })
            });
            if (!response.ok) throw new Error('Token exchange failed');
            data = await response.json();
          }

          dropbox.setDbToken(data.access_token);
          if (data.refresh_token) {
            dropbox.setDbRefreshToken(data.refresh_token);
          }
          if (data.expires_in) {
            setupDropboxRefreshTimer(data.expires_in);
          }

          localStorage.removeItem('dropbox_code_verifier');
          // Clean URL
          window.history.replaceState(null, null, window.location.pathname);

          setStatus({ type: 'success', message: 'Dropboxに接続しました' });
          const nsId = await dropbox.checkConnection(data.access_token);
          const savedPath = localStorage.getItem('dropbox_current_path') || '';
          dropbox.listFolderContent(savedPath, nsId, data.access_token);
        } catch (err) {
          console.error('Dropbox token exchange error:', err);
          setStatus({ type: 'error', message: 'Dropbox 認証に失敗しました' });
        }
      } else if (dropbox.dbToken) {
        // Existing token
        const nsId = await dropbox.checkConnection();
        const savedPath = localStorage.getItem('dropbox_current_path') || '';
        dropbox.listFolderContent(savedPath, nsId);

        // Start refresh timer if refresh token exists
        if (dropbox.dbRefreshToken) {
           setupDropboxRefreshTimer(14400); // 4 hours as default
        }
      }
    };
    initDropbox();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 初回・Keychain 復元後・シェル確定後
  }, [desktopKeyringHydrated, desktopShellRevision]);

  // Functions
  const handleDropboxLogin = async () => {
    if (isDesktopShell()) {
      try {
        setStatus({
          type: 'info',
          message: 'ブラウザが開きます。Dropbox にログイン後、このアプリに戻ってください。',
        });
        const res = await fetch('/api/oauth/dropbox/start', { method: 'POST' });
        if (!res.ok) {
          const t = await res.text();
          throw new Error(t || '認証の開始に失敗しました');
        }
        const { oauth_state: oauthState } = await res.json();
        const pollMs = 600;
        const maxAttempts = 200;
        let oauthCompleted = false;
        for (let i = 0; i < maxAttempts; i++) {
          await new Promise((r) => setTimeout(r, pollMs));
          const pr = await fetch(
            `/api/oauth/dropbox/poll?state=${encodeURIComponent(oauthState)}`
          );
          const pj = await pr.json();
          if (pj.done) {
            if (pj.error) {
              setStatus({
                type: 'error',
                message:
                  pj.error === 'invalid_or_expired_state'
                    ? '認証セッションが切れました。もう一度お試しください。'
                    : `Dropbox: ${pj.error}`,
              });
              return;
            }
            oauthCompleted = true;
            break;
          }
        }
        if (!oauthCompleted) {
          setStatus({
            type: 'error',
            message: 'Dropbox 認証がタイムアウトしました。ブラウザでログインできたか確認してください。',
          });
          return;
        }
        const tr = await fetch('/api/session/tokens');
        const d = await tr.json();
        if (!d.dropbox_access) {
          setStatus({
            type: 'error',
            message: 'Dropbox 認証を完了できませんでした（タイムアウト）',
          });
          return;
        }
        dropbox.setDbToken(d.dropbox_access);
        if (d.dropbox_refresh) dropbox.setDbRefreshToken(d.dropbox_refresh);
        setStatus({ type: 'success', message: 'Dropboxに接続しました' });
        const nsId = await dropbox.checkConnection(d.dropbox_access);
        const savedPath = localStorage.getItem('dropbox_current_path') || '';
        dropbox.listFolderContent(savedPath, nsId, d.dropbox_access);
        if (d.dropbox_refresh) {
          setupDropboxRefreshTimer(14400);
        }
      } catch (e) {
        console.error(e);
        setStatus({
          type: 'error',
          message: e.message || 'Dropbox 認証に失敗しました',
        });
      }
      return;
    }

    const verifier = generateCodeVerifier();
    localStorage.setItem('dropbox_code_verifier', verifier);
    const challenge = await generateCodeChallenge(verifier);

    const redirectUri = (window.location.origin + window.location.pathname).replace(/\/$/, "");
    const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${DROPBOX_APP_KEY}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&token_access_type=offline`;
    window.location.href = authUrl;
  };

  const handleGoogleLogin = async () => {
    if (isDesktopShell()) {
      try {
        setStatus({
          type: 'info',
          message: 'ブラウザで Google にログインしてください（このウィンドウは開いたまま）',
        });
        const res = await fetch('/api/oauth/google/start', { method: 'POST' });
        if (!res.ok) {
          const t = await res.text();
          throw new Error(t || '認証の開始に失敗しました');
        }
        const { oauth_state: oauthState } = await res.json();
        const pollMs = 600;
        const maxAttempts = 200;
        let oauthCompleted = false;
        for (let i = 0; i < maxAttempts; i++) {
          await new Promise((r) => setTimeout(r, pollMs));
          const pr = await fetch(
            `/api/oauth/google/poll?state=${encodeURIComponent(oauthState)}`
          );
          const pj = await pr.json();
          if (pj.done) {
            if (pj.error) {
              setStatus({
                type: 'error',
                message:
                  pj.error === 'invalid_or_expired_state'
                    ? '認証セッションが切れました。もう一度お試しください。'
                    : `Google: ${pj.error}`,
              });
              return;
            }
            oauthCompleted = true;
            break;
          }
        }
        if (!oauthCompleted) {
          setStatus({
            type: 'error',
            message:
              'Google 認証がタイムアウトしました。ブラウザでログインできたか確認してください。',
          });
          return;
        }
        const tr = await fetch('/api/session/tokens');
        const d = await tr.json();
        if (!d.google_access) {
          setStatus({
            type: 'error',
            message: 'Google 認証を完了できませんでした',
          });
          return;
        }
        gdrive.setGDriveToken(d.google_access);
        if (d.google_refresh) {
          localStorage.setItem('google_refresh_token', d.google_refresh);
        }
        setStatus({ type: 'success', message: 'Google ドライブに接続しました (Server Mode)' });
        if (googleTokenRefreshTimerRef.current) {
          clearInterval(googleTokenRefreshTimerRef.current);
        }
        const refreshInterval = Math.max((3600 - 300) * 1000, 60000);
        googleTokenRefreshTimerRef.current = setInterval(
          refreshGoogleToken,
          refreshInterval
        );
        if (gdrive.fetchGDriveContents) gdrive.fetchGDriveContents('home');
      } catch (e) {
        console.error(e);
        setStatus({
          type: 'error',
          message: e.message || 'Google 認証に失敗しました',
        });
      }
      return;
    }

    if (googleClient) {
      if (usesBackendOAuth()) {
        googleClient.requestCode();
      } else {
        googleClient.requestAccessToken();
      }
    } else {
      setStatus({ type: 'error', message: 'Google 認証ライブラリを初期化中です。少々お待ちください。' });
    }
  };

  return (
    <div className="flex h-screen bg-slate-100 font-sans text-slate-900 overflow-hidden">
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        dbToken={dropbox.dbToken}
        gDriveToken={gdrive.gDriveToken}
        handleDropboxLogin={handleDropboxLogin}
        handleDropboxLogout={() => {
          dropbox.handleDropboxLogout(true);
          if (isDesktopShell()) {
            fetch('/api/session/clear-dropbox', { method: 'POST' }).catch(() => {});
          }
        }}
        handleGoogleLogin={handleGoogleLogin}
        handleGoogleLogout={() => {
          gdrive.handleGoogleLogout(true);
          if (isDesktopShell()) {
            fetch('/api/session/clear-google', { method: 'POST' }).catch(() => {});
          }
        }}
        isGDriveLoading={gdrive.isGDriveLoading}
        selectedFileIds={dropbox.selectedFileIds}
        setIsFolderPickerOpen={gdrive.setIsFolderPickerOpen}
        desktopAppVersion={desktopAppVersion}
        desktopUpdateInfo={desktopUpdateInfo}
        desktopUpdateFetching={desktopUpdateFetching}
        onDesktopUpdateCheck={runDesktopUpdateCheck}
        desktopMemory={desktopMemory}
        onDesktopGc={runDesktopGc}
        desktopGcLoading={desktopGcLoading}
      />

      <main className="flex-1 flex flex-col min-w-0 bg-white shadow-2xl relative z-10 transition-all duration-500 overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <div className="flex-1 flex min-h-0 overflow-hidden">
            {/* Main Content Area */}
            <div className={`flex-1 flex min-h-0 overflow-hidden transition-all duration-500`}>
              {activeTab === 'scan' ? (
                  <ExplorerColumn
                    title="Dropbox"
                    icon={Folder}
                    iconBg="bg-indigo-600"
                    breadcrumbs={dropbox.getBreadcrumbs()}
                    onBreadcrumbClick={(idx) => dropbox.handleFolderClick(dropbox.getBreadcrumbs()[idx].path)}
                    isLoading={dropbox.isProcessing}
                    loadingText="Dropbox 読み込み中..."
                    items={dropbox.folderFiles}
                    emptyIcon={Folder}
                    renderItem={(f, idx) => (
                      <FileListItem
                        key={idx}
                        item={f}
                        isFolder={f['.tag'] === 'folder'}
                        isSelected={dropbox.selectedFileIds.includes(f.path_lower)}
                        onToggleSelect={() => dropbox.toggleFileSelection(f.path_lower)}
                        onItemClick={() => f['.tag'] === 'folder' ? dropbox.handleFolderClick(f.path_display) : dropbox.toggleFileSelection(f.path_lower)}
                        showSelect={true}
                        showArrow={f['.tag'] !== 'folder'}
                        onArrowClick={() => converter.fetchAndExport(f.path_lower, f.name, f.is_downloadable === false)}
                        showFolderAction={f['.tag'] === 'folder' && !!gdrive.gDriveToken}
                        onFolderActionClick={() => gdrive.createGDriveFolder(gdrive.gDriveToken, gdrive.selectedFolderId, f.name)}
                        onRecursiveMigrateClick={() => converter.migrateFolderRecursively(f.path_lower, f.name, addLog)}
                        onRename={(newName) => dropbox.renameDropboxFolder(f.path_lower, newName)}
                        type="dropbox"
                      />
                    )}
                    infoBar={
                      <>
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={dropbox.selectedFileIds.length === dropbox.folderFiles.filter(f => f['.tag'] === 'file').length && dropbox.selectedFileIds.length > 0}
                            onChange={dropbox.toggleAllFiles}
                            className="w-3 h-3 rounded"
                          />
                          <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">{dropbox.selectedFileIds.length} 選択中</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <a
                            href={`https://www.dropbox.com/home${dropbox.currentPath === '/' ? '' : dropbox.currentPath}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1 hover:bg-indigo-100 rounded transition-all text-indigo-600"
                            title="Dropboxで開く"
                          >
                            <ExternalLink size={10} />
                          </a>
                          <button onClick={() => dropbox.listFolderContent(dropbox.currentPath)} className="p-1 hover:bg-indigo-100 rounded transition-all text-indigo-600">
                            <RefreshCw size={10} />
                          </button>
                        </div>
                      </>
                    }
                    actions={
                       dropbox.selectedFileIds.length > 0 && (
                        <button
                          onClick={() => converter.bulkSaveToGoogleDocs(dropbox.selectedFileIds, dropbox.folderFiles)}
                          disabled={converter.isGDriveProcessing}
                          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 disabled:opacity-50"
                        >
                          <ChevronRight size={14} strokeWidth={3} />
                          Bulk Convert ({dropbox.selectedFileIds.length})
                        </button>
                      )
                    }
                  >
                    {!dropbox.dbToken && (
                      <div className="h-full flex flex-col items-center justify-center text-slate-400 text-center space-y-4">
                        <div className="w-16 h-16 bg-slate-50 rounded-2xl flex items-center justify-center shadow-sm border border-slate-100 mb-2">
                          <Files size={28} className="text-slate-300" strokeWidth={1.5} />
                        </div>
                        <div className="space-y-1">
                          <h3 className="text-sm font-bold text-slate-700">
                            {dropbox.currentPath ? 'Dropbox セッション切れ' : 'Dropbox 未接続'}
                          </h3>
                          <p className="text-xs text-slate-500 leading-relaxed">
                            {dropbox.currentPath ? (
                              <>セッションが切れました。作業を再開するには、<br />再度ログインしてください。</>
                            ) : (
                              <>移行元のファイルを選択するには、<br />左サイドバーから Dropbox にログインしてください。</>
                            )}
                          </p>
                          {dropbox.currentPath && (
                            <button
                              onClick={handleDropboxLogin}
                              className="mt-4 px-4 py-2 bg-indigo-600 text-white text-[10px] font-bold uppercase tracking-widest rounded-lg hover:bg-indigo-700 transition-all"
                            >
                              再ログイン
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </ExplorerColumn>

              ) : (
                <EditorView
                  content={content}
                  setContent={setContent}
                  currentFileName={currentFileName}
                  saveToGoogleDocs={converter.saveToGoogleDocs}
                  downloadFile={converter.downloadFile}
                  isGDriveProcessing={converter.isGDriveProcessing}
                  currentFilePath={currentFilePath}
                  setActiveTab={setActiveTab}
                  gDriveToken={gdrive.gDriveToken}
                />
              )}

              {/* Vertical Divider */}
              <div className="w-[1px] bg-slate-100 shrink-0" />

              {/* Right: GDrive Explorer */}
                  <ExplorerColumn
                    title="Google Drive"
                    icon={HardDrive}
                    iconBg="bg-emerald-600"
                    headerBg="bg-emerald-50/30"
                    breadcrumbs={gdrive.gDriveBrowserPath}
                    onBreadcrumbClick={gdrive.navigateGDriveBrowserTo}
                    isLoading={gdrive.gDriveBrowserLoading}
                    loadingText="Google Drive 読み込み中..."
                    items={gdrive.gDriveBrowserFiles}
                    emptyIcon={HardDrive}
                    renderItem={(f, idx) => (
                      <FileListItem
                        key={idx}
                        item={f}
                        isFolder={f.mimeType === 'application/vnd.google-apps.folder'}
                        onItemClick={() => gdrive.navigateGDriveBrowser(f.id, f.name)}
                        showExternalLink={f.mimeType !== 'application/vnd.google-apps.folder'}
                        externalLink={f.webViewLink}
                        onRename={(newName) => gdrive.renameGDriveFolder(f.id, newName, gdrive.gDriveBrowserPath[gdrive.gDriveBrowserPath.length - 1].id)}
                        showDuplicateButton={f.mimeType === 'application/vnd.google-apps.folder' && !f.isRoot && !f.isSharedDrive}
                        onDuplicateClick={() => gdrive.duplicateGDriveFolder(f.id, f.name, gdrive.gDriveBrowserPath[gdrive.gDriveBrowserPath.length - 1].id)}
                        type="gdrive"
                      />
                    )}
                    infoBar={gdrive.gDriveToken ? (
                      <>
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] font-bold text-emerald-600 uppercase">保存先:</span>
                          <span className="text-[9px] font-black text-emerald-800 truncate max-w-[150px]">
                            {gdrive.selectedFolderId === 'root' ? 'マイドライブ' : (gdrive.gDriveBrowserPath[gdrive.gDriveBrowserPath.length - 1].name || '現在のフォルダ')}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <a
                            href={gdrive.selectedFolderId === 'root' ? 'https://drive.google.com/drive/my-drive' : `https://drive.google.com/drive/folders/${gdrive.selectedFolderId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1 hover:bg-emerald-100 rounded transition-all text-emerald-600"
                            title="Google Driveで開く"
                          >
                            <ExternalLink size={10} />
                          </a>
                          <button onClick={() => gdrive.fetchGDriveContents(gdrive.gDriveBrowserPath[gdrive.gDriveBrowserPath.length - 1].id)} className="p-1 hover:bg-emerald-100 rounded transition-all text-emerald-600">
                            <RefreshCw size={10} />
                          </button>
                        </div>
                      </>
                    ) : null}
                  >
                    {!gdrive.gDriveToken ? (
                      <div className="h-full flex flex-col items-center justify-center text-slate-400 text-center space-y-4">
                        <div className="w-16 h-16 bg-slate-50 rounded-2xl flex items-center justify-center shadow-sm border border-slate-100 mb-2">
                          <ShieldCheck size={28} className="text-slate-300" strokeWidth={1.5} />
                        </div>
                        <div className="space-y-1">
                          <h3 className="text-sm font-bold text-slate-700">
                             {gdrive.selectedFolderId !== 'root' ? 'Google ドライブ セッション切れ' : 'Google ドライブ 未接続'}
                          </h3>
                          <p className="text-xs text-slate-500 leading-relaxed">
                            {gdrive.selectedFolderId !== 'root' ? (
                                <>セッションが切れました。作業を再開するには、<br />再度ログインしてください。</>
                            ) : (
                                <>変換したファイルの保存先を指定するには、<br />左サイドバーから Google にログインしてください。</>
                            )}
                          </p>
                          {gdrive.selectedFolderId !== 'root' && (
                            <button
                              onClick={handleGoogleLogin}
                              className="mt-4 px-4 py-2 bg-emerald-600 text-white text-[10px] font-bold uppercase tracking-widest rounded-lg hover:bg-emerald-700 transition-all"
                            >
                              再ログイン
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <>
                        {/* Inline Folder Creation Overlay */}
                        {gdrive.isCreatingFolder && (
                          <div className="p-3 bg-emerald-50 rounded-xl border border-emerald-100 flex flex-col gap-2 mb-2">
                            <input
                              type="text"
                              value={gdrive.newFolderName}
                              onChange={(e) => gdrive.setNewFolderName(e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && gdrive.createGDriveFolder(gdrive.gDriveToken, gdrive.gDriveBrowserPath[gdrive.gDriveBrowserPath.length - 1].id, gdrive.newFolderName)}
                              placeholder="フォルダ名を入力..."
                              autoFocus
                              className="w-full bg-white border border-emerald-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none"
                            />
                            <div className="flex gap-2">
                              <button onClick={() => gdrive.createGDriveFolder(gdrive.gDriveToken, gdrive.gDriveBrowserPath[gdrive.gDriveBrowserPath.length - 1].id, gdrive.newFolderName)} className="flex-1 bg-emerald-600 text-white text-[10px] py-1.5 rounded-lg font-bold">作成</button>
                              <button onClick={() => gdrive.setIsCreatingFolder(false)} className="px-3 bg-white border border-slate-200 text-slate-400 text-[10px] py-1.5 rounded-lg">キャンセル</button>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </ExplorerColumn>

            </div>
          </div>

          {/* Bottom Console / Log Viewer */}
          <LogViewer
            logs={logs}
            onClear={clearLogs}
            onClose={() => setLogs([])}
          />
        </div>
      </main>

      <StatusToast status={status} setStatus={setStatus} />

      <FolderPickerModal
        isOpen={gdrive.isFolderPickerOpen}
        onClose={() => gdrive.setIsFolderPickerOpen(false)}
        gDriveFolders={gdrive.gDriveFolders}
        folderSearchTerm={gdrive.folderSearchTerm}
        selectedFolderId={gdrive.selectedFolderId}
        setSelectedFolderId={gdrive.setSelectedFolderId}
        pickerDriveType={gdrive.pickerDriveType}
        setPickerDriveType={gdrive.setPickerDriveType}
        pickerFolderId={gdrive.pickerFolderId}
        pickerBreadcrumbs={gdrive.pickerBreadcrumbs}
        gDriveDrives={gdrive.gDriveDrives}
        isGDriveLoading={gdrive.isGDriveLoading}
        isCreatingFolder={gdrive.isCreatingFolder}
        setIsCreatingFolder={gdrive.setIsCreatingFolder}
        newFolderName={gdrive.newFolderName}
        setNewFolderName={gdrive.setNewFolderName}
        createGDriveFolder={gdrive.createGDriveFolder}
        navigateToGDriveFolder={gdrive.navigateToGDriveFolder}
        gDriveToken={gdrive.gDriveToken}
      />

      {/* Bulk Save Global Action Overlay */}
      {dropbox.selectedFileIds.length > 0 && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[150] animate-in slide-in-from-bottom-10 duration-500">
           <button
             onClick={() => converter.bulkSaveToGoogleDocs(dropbox.selectedFileIds, dropbox.folderFiles)}
             disabled={converter.isGDriveProcessing}
             className="px-8 py-4 bg-slate-900 text-white rounded-[2rem] shadow-2xl flex items-center gap-4 hover:bg-emerald-600 transition-all border border-slate-800"
           >
             <div className="w-8 h-8 bg-emerald-500 rounded-xl flex items-center justify-center">
               <ShieldCheck size={18} />
             </div>
             <div className="text-left">
               <p className="text-[10px] font-black uppercase tracking-widest leading-none mb-1 text-emerald-400">Bulk Conversion</p>
               <p className="text-xs font-black">{dropbox.selectedFileIds.length} 個のファイルをマイドライブへ保存</p>
             </div>
             {converter.isGDriveProcessing && <RefreshCw className="animate-spin ml-4" size={20} />}
           </button>
        </div>
      )}
    </div>
  );
};

export default App;