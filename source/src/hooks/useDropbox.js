import { useState, useCallback, useEffect, useRef } from 'react';
import { usesBackendOAuth } from '../utils/desktopEnv';
import { deriveDropboxAccess } from '../utils/accessLevel';

export const useDropbox = (setStatus) => {
  const [dbToken, setDbToken] = useState(localStorage.getItem('dropbox_token'));
  const [dbRefreshToken, setDbRefreshToken] = useState(localStorage.getItem('dropbox_refresh_token'));
  const [folderFiles, setFolderFiles] = useState([]);
  const [selectedFileIds, setSelectedFileIds] = useState([]);
  const savedPath = localStorage.getItem('dropbox_current_path');
  const [currentPath, setCurrentPath] = useState(savedPath || '');
  const [isProcessing, setIsProcessing] = useState(false);
  const [exportingId, setExportingId] = useState(null);
  const [rootNamespaceId, setRootNamespaceId] = useState(localStorage.getItem('dropbox_ns_id'));
  /** list_folder が 409 等で失敗したフォルダ path（小文字）。一覧でグレーアウト */
  const [inaccessiblePaths, setInaccessiblePaths] = useState(() => new Set());
  const dbTokenRef = useRef(dbToken);

  // トークン保存
  useEffect(() => {
    if (dbToken) {
      localStorage.setItem('dropbox_token', dbToken);
      dbTokenRef.current = dbToken;
    } else {
      localStorage.removeItem('dropbox_token');
      dbTokenRef.current = null;
    }
  }, [dbToken]);

  useEffect(() => {
    if (dbRefreshToken) localStorage.setItem('dropbox_refresh_token', dbRefreshToken);
    else localStorage.removeItem('dropbox_refresh_token');
  }, [dbRefreshToken]);

  useEffect(() => {
    if (rootNamespaceId) localStorage.setItem('dropbox_ns_id', rootNamespaceId);
    else localStorage.removeItem('dropbox_ns_id');
  }, [rootNamespaceId]);

  useEffect(() => {
    localStorage.setItem('dropbox_current_path', currentPath);
  }, [currentPath]);

  const asciiSafeJson = (obj) => {
    return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => {
      return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
    });
  };

  const getApiHeaders = useCallback((isContent = false, nsId = null, token = null) => {
    const activeToken = token || dbToken;
    const activeNsId = nsId || rootNamespaceId;

    const headers = {
      'Authorization': `Bearer ${activeToken}`
    };
    if (!isContent) headers['Content-Type'] = 'application/json';
    if (activeNsId) headers['Dropbox-API-Path-Root'] = asciiSafeJson({ ".tag": "root", "root": activeNsId });

    return headers;
  }, [dbToken, rootNamespaceId]);

  const handleDropboxLogout = useCallback((clearState = true) => {
    setDbToken(null);
    setDbRefreshToken(null);
    setFolderFiles([]);
    setInaccessiblePaths(new Set());
    if (clearState) {
      // カレントパス・名前空間 ID は再ログイン後も同じフォルダへ戻せるよう保持する
      setStatus({ type: 'info', message: 'Dropbox からログアウトしました' });
    } else {
      setStatus({ type: 'warning', message: 'Dropbox のセッションが切れました。再ログインが必要です。' });
    }
  }, [setStatus]);

  const refreshDropboxToken = useCallback(async () => {
    if (!dbRefreshToken) return null;
    const DROPBOX_APP_KEY = import.meta.env.VITE_DROPBOX_APP_KEY;

    try {
      let response;
      if (usesBackendOAuth()) {
        response = await fetch('/api/dropbox/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: dbRefreshToken })
        });
      } else {
        response = await fetch('https://api.dropbox.com/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: dbRefreshToken,
            client_id: DROPBOX_APP_KEY
          })
        });
      }

      if (!response.ok) {
        handleDropboxLogout(false);
        throw new Error('Dropbox トークンの更新に失敗しました');
      }

      const data = await response.json();
      if (data.access_token) {
        dbTokenRef.current = data.access_token;
      }
      setDbToken(data.access_token);
      return data; // Return full data to get expires_in
    } catch (err) {
      console.error('Dropbox refresh failed:', err);
      return null;
    }
  }, [dbRefreshToken, handleDropboxLogout]);

  const checkConnection = useCallback(async (token = null) => {
    const activeToken = token || dbToken;
    if (!activeToken) return null;

    const doFetch = (t) =>
      fetch('https://api.dropboxapi.com/2/users/get_current_account', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${t}` }
      });

    try {
      let response = await doFetch(activeToken);

      if (response.status === 401 && dbRefreshToken) {
        const refreshed = await refreshDropboxToken();
        if (refreshed?.access_token) {
          response = await doFetch(refreshed.access_token);
        }
      }

      if (response.status === 401) {
        handleDropboxLogout(false);
        return null;
      }

      const data = await response.json();
      let nsId = null;

      // ビジネスアカウントやチームスペース参加者の場合、root_info が存在する
      if (data.root_info && data.root_info.root_namespace_id) {
        nsId = data.root_info.root_namespace_id;
        setRootNamespaceId(nsId);
        console.log('Dropbox root namespace identified:', nsId);
        return nsId;
      }

      setRootNamespaceId(null);
      return null;
    } catch (err) {
      console.error('Connection check failed:', err);
      return null;
    }
  }, [dbToken, dbRefreshToken, refreshDropboxToken, handleDropboxLogout]);

  const listFolderContent = useCallback(async (path = '', nsId = null, token = null) => {
    let activeToken = token || dbToken;
    if (!activeToken) return;

    const pathKey = (path || '').toLowerCase();
    setIsProcessing(true);
    try {
      const doList = (t) =>
        fetch('https://api.dropboxapi.com/2/files/list_folder', {
          method: 'POST',
          headers: getApiHeaders(false, nsId, t),
          body: JSON.stringify({
            path: path,
            recursive: false,
            include_media_info: false,
            include_has_explicit_shared_members: false,
            include_mounted_folders: true
          })
        });

      let response = await doList(activeToken);

      if (response.status === 401 && dbRefreshToken) {
        const refreshed = await refreshDropboxToken();
        if (refreshed?.access_token) {
          activeToken = refreshed.access_token;
          response = await doList(activeToken);
        }
      }

      if (response.status === 401) {
        handleDropboxLogout(false);
        return;
      }
      if (!response.ok) {
        setInaccessiblePaths((prev) => new Set(prev).add(pathKey));
        const snippet = (await response.text()).slice(0, 400);
        throw new Error(
          snippet ? `フォルダリストの取得に失敗しました: ${snippet}` : 'フォルダリストの取得に失敗しました'
        );
      }

      let data = await response.json();
      let allEntries = [...(data.entries || [])];
      // list_folder は1回あたり最大約2000件。has_more を無視すると以降のエントリが一覧から消える
      while (data.has_more) {
        response = await fetch('https://api.dropboxapi.com/2/files/list_folder/continue', {
          method: 'POST',
          headers: getApiHeaders(false, nsId, activeToken),
          body: JSON.stringify({ cursor: data.cursor })
        });
        if (response.status === 401 && dbRefreshToken) {
          const refreshed = await refreshDropboxToken();
          if (refreshed?.access_token) {
            activeToken = refreshed.access_token;
            response = await fetch('https://api.dropboxapi.com/2/files/list_folder/continue', {
              method: 'POST',
              headers: getApiHeaders(false, nsId, activeToken),
              body: JSON.stringify({ cursor: data.cursor })
            });
          }
        }
        if (response.status === 401) {
          handleDropboxLogout(false);
          return;
        }
        if (!response.ok) {
          setInaccessiblePaths((prev) => new Set(prev).add(pathKey));
          const snippet = (await response.text()).slice(0, 400);
          throw new Error(
            snippet ? `フォルダリストの取得に失敗しました: ${snippet}` : 'フォルダリストの取得に失敗しました'
          );
        }
        data = await response.json();
        allEntries = [...allEntries, ...(data.entries || [])];
      }
      // フォルダ優先、その中で名前順にソート
      const sortedEntries = allEntries.sort((a, b) => {
        if (a['.tag'] === 'folder' && b['.tag'] !== 'folder') return -1;
        if (a['.tag'] !== 'folder' && b['.tag'] === 'folder') return 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });
      setFolderFiles(sortedEntries);
      setCurrentPath(path);
      setInaccessiblePaths((prev) => {
        const n = new Set(prev);
        n.delete(pathKey);
        return n;
      });
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setIsProcessing(false);
    }
  }, [dbToken, dbRefreshToken, getApiHeaders, refreshDropboxToken, handleDropboxLogout, setStatus]);

  const handleFolderClick = useCallback((path) => {
    listFolderContent(path);
  }, [listFolderContent]);

  const toggleFileSelection = useCallback((path) => {
    setSelectedFileIds(prev =>
      prev.includes(path) ? prev.filter(id => id !== path) : [...prev, path]
    );
  }, []);

  const toggleAllFiles = useCallback(() => {
    const filesOnly = folderFiles.filter(
      (f) => f['.tag'] === 'file' && deriveDropboxAccess(f, inaccessiblePaths) !== 'none'
    );
    if (selectedFileIds.length === filesOnly.length && filesOnly.length > 0) {
      setSelectedFileIds([]);
    } else {
      setSelectedFileIds(filesOnly.map((f) => f.path_lower));
    }
  }, [folderFiles, selectedFileIds, inaccessiblePaths]);

  const getBreadcrumbs = useCallback(() => {
    if (!currentPath || currentPath === '/') return [{ name: 'Home', path: '' }];
    const parts = currentPath.split('/').filter(Boolean);
    const crumbs = [{ name: 'Home', path: '' }];
    let accum = '';
    parts.forEach(p => {
      accum += '/' + p;
      crumbs.push({ name: p, path: accum });
    });
    return crumbs;
  }, [currentPath]);

  const renameDropboxFolder = useCallback(async (oldPath, newName) => {
    console.log('[useDropbox] renameDropboxFolder called. oldPath:', oldPath, 'newName:', newName);
    setIsProcessing(true);
    try {
      const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/'));
      const newPath = `${parentPath}/${newName}`;
      console.log('[useDropbox] Moving from', oldPath, 'to', newPath);

      const doMove = (t) =>
        fetch('https://api.dropboxapi.com/2/files/move_v2', {
          method: 'POST',
          headers: getApiHeaders(false, null, t),
          body: JSON.stringify({
            from_path: oldPath,
            to_path: newPath,
            autorename: false,
            allow_ownership_transfer: false
          })
        });

      let response = await doMove(dbToken);

      if (response.status === 401 && dbRefreshToken) {
        const refreshed = await refreshDropboxToken();
        if (refreshed?.access_token) {
          response = await doMove(refreshed.access_token);
        }
      }

      console.log('[useDropbox] API response status:', response.status);

      if (!response.ok) {
        const errText = await response.text();
        console.error('[useDropbox] API error response:', errText);
        throw new Error('フォルダ名の変更に失敗しました');
      }

      // Success, refresh current folder
      console.log('[useDropbox] Rename successful, refreshing list...');
      await listFolderContent(currentPath);
      return true;
    } catch (err) {
      console.error('Rename failed:', err);
      // Optional: error handling/toast here if needed
      return false;
    } finally {
      setIsProcessing(false);
    }
  }, [currentPath, dbToken, dbRefreshToken, getApiHeaders, listFolderContent, refreshDropboxToken]);

  const listFolderRecursive = useCallback(async (path = '') => {
    let activeToken = dbToken;
    if (!activeToken) return [];

    let allEntries = [];
    try {
      const doList = (t) =>
        fetch('https://api.dropboxapi.com/2/files/list_folder', {
          method: 'POST',
          headers: getApiHeaders(false, null, t),
          body: JSON.stringify({
            path: path,
            recursive: true,
            include_media_info: false,
            include_mounted_folders: true
          })
        });

      let response = await doList(activeToken);

      if (response.status === 401 && dbRefreshToken) {
        const refreshed = await refreshDropboxToken();
        if (refreshed?.access_token) {
          activeToken = refreshed.access_token;
          response = await doList(activeToken);
        }
      }

      if (response.status === 401) {
        handleDropboxLogout(false);
        throw new Error('Dropbox のセッションが切れています');
      }
      if (!response.ok) throw new Error('フォルダ内リストの取得に失敗しました');

      let data = await response.json();
      allEntries = [...data.entries];

      while (data.has_more) {
        response = await fetch('https://api.dropboxapi.com/2/files/list_folder/continue', {
          method: 'POST',
          headers: getApiHeaders(false, null, activeToken),
          body: JSON.stringify({ cursor: data.cursor })
        });
        if (response.status === 401 && dbRefreshToken) {
          const refreshed = await refreshDropboxToken();
          if (refreshed?.access_token) {
            activeToken = refreshed.access_token;
            response = await fetch('https://api.dropboxapi.com/2/files/list_folder/continue', {
              method: 'POST',
              headers: getApiHeaders(false, null, activeToken),
              body: JSON.stringify({ cursor: data.cursor })
            });
          }
        }
        if (!response.ok) throw new Error('フォルダ内リストの継続取得に失敗しました');
        data = await response.json();
        allEntries = [...allEntries, ...data.entries];
      }

      return allEntries;
    } catch (err) {
      console.error('Recursive listing failed:', err);
      setStatus({ type: 'error', message: err.message });
      return [];
    }
  }, [dbToken, dbRefreshToken, getApiHeaders, refreshDropboxToken, handleDropboxLogout, setStatus]);

  return {
    dbToken, setDbToken,
    dbRefreshToken, setDbRefreshToken,
    dbTokenRef,
    folderFiles,
    selectedFileIds, setSelectedFileIds,
    currentPath, setCurrentPath,
    isProcessing,
    exportingId, setExportingId,
    rootNamespaceId, setRootNamespaceId,
    asciiSafeJson,
    getApiHeaders,
    handleDropboxLogout,
    refreshDropboxToken,
    checkConnection,
    inaccessiblePaths,
    listFolderContent,
    handleFolderClick,
    toggleFileSelection,
    toggleAllFiles,
    getBreadcrumbs,
    renameDropboxFolder,
    listFolderRecursive
  };
};
