import { useState, useCallback, useEffect } from 'react';

export const useGoogleDrive = (setStatus) => {
  const [gDriveToken, setGDriveToken] = useState(localStorage.getItem('gdrive_token'));
  const [gDriveBrowserLoading, setGDriveBrowserLoading] = useState(false);
  const [gDriveBrowserFiles, setGDriveBrowserFiles] = useState([]);

  // Restore path from localStorage
  const savedPath = localStorage.getItem('gdrive_browser_path');
  const initialPath = savedPath ? JSON.parse(savedPath) : [{ id: 'home', name: 'Home' }];
  const [gDriveBrowserPath, setGDriveBrowserPath] = useState(initialPath);

  const savedSelectedId = localStorage.getItem('gdrive_selected_folder_id');
  const [selectedFolderId, setSelectedFolderId] = useState(savedSelectedId || 'root');

  const [gDriveFolders, setGDriveFolders] = useState([]);
  const [pickerFolderId, setPickerFolderId] = useState('root');
  const [pickerBreadcrumbs, setPickerBreadcrumbs] = useState([{ id: 'root', name: 'マイドライブ' }]);
  const [gDriveDrives, setGDriveDrives] = useState([]);
  const [pickerDriveType, setPickerDriveType] = useState('mydrive');
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [folderSearchTerm, setFolderSearchTerm] = useState('');
  const [isGDriveLoading, setIsGDriveLoading] = useState(false);
  const [isGDriveProcessing, setIsGDriveProcessing] = useState(false);

  useEffect(() => {
    if (gDriveToken) {
      localStorage.setItem('gdrive_token', gDriveToken);
    } else {
      localStorage.removeItem('gdrive_token');
    }
  }, [gDriveToken]);

  useEffect(() => {
    localStorage.setItem('gdrive_browser_path', JSON.stringify(gDriveBrowserPath));
  }, [gDriveBrowserPath]);

  useEffect(() => {
    localStorage.setItem('gdrive_selected_folder_id', selectedFolderId);
  }, [selectedFolderId]);

  // Google Drive 自動読み込み
  useEffect(() => {
    if (gDriveToken) {
      const currentId = gDriveBrowserPath[gDriveBrowserPath.length - 1].id;
      fetchGDriveContents(currentId);
    }
  }, [gDriveToken]);

  // GSI (Google Services Index) の初期化は App.jsx (EntryPoint) に残すか、ここで行うか。
  // ここで行う場合、window.google.accounts.oauth2.initTokenClient へのアクセスが必要。

  const handleGoogleLogout = useCallback((clearState = true) => {
    setGDriveToken(null);
    setGDriveBrowserFiles([]);
    if (clearState) {
      // フォルダ位置（gdrive_browser_path / selectedFolderId）は再ログイン後も戻せるよう保持する
      localStorage.removeItem('google_refresh_token');
      setStatus({ type: 'info', message: 'Google Drive からログアウトしました' });
    } else {
      setStatus({ type: 'warning', message: 'Google Drive のセッションが切れました。再接続が必要です。' });
    }
  }, [setStatus]);

  const fetchGDriveContents = useCallback(async (folderId = 'home') => {
    if (!gDriveToken) return;
    setGDriveBrowserLoading(true);

    try {
      // 'home' の場合はホーム画面（マイドライブへのリンク ＋ 共有ドライブの一覧）を表示
      if (folderId === 'home') {
        const folders = [{ id: 'root', name: 'マイドライブ', mimeType: 'application/vnd.google-apps.folder', isRoot: true }];
        const drives = await fetchGDriveDrives(gDriveToken);
        const sharedDrives = drives.map(d => ({
          id: d.id,
          name: d.name,
          mimeType: 'application/vnd.google-apps.folder',
          isSharedDrive: true
        }));
        setGDriveBrowserFiles([...folders, ...sharedDrives]);
      } else {
        const q = `'${folderId}' in parents and trashed=false`;
        const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime,size,webViewLink)&supportsAllDrives=true&includeItemsFromAllDrives=true&orderBy=folder,name&pageSize=200`, {
          headers: { 'Authorization': `Bearer ${gDriveToken}` }
        });

        if (response.status === 401) {
          handleGoogleLogout(false);
          return;
        }
        const data = await response.json();
        setGDriveBrowserFiles(data.files || []);
      }
    } catch (err) {
      console.error('Failed to fetch GDrive contents:', err);
      setStatus({ type: 'error', message: 'Google Drive の取得に失敗しました' });
    } finally {
      setGDriveBrowserLoading(false);
    }
  }, [gDriveToken, handleGoogleLogout, setStatus]);

  const fetchGDriveDrives = async (token) => {
    try {
      const response = await fetch('https://www.googleapis.com/drive/v3/drives?pageSize=100&fields=drives(id,name)', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (response.status === 401) {
        handleGoogleLogout();
        return [];
      }
      if (!response.ok) return [];
      const data = await response.json();
      return data.drives || [];
    } catch (err) {
      console.error('Failed to fetch shared drives:', err);
      return [];
    }
  };

  const createGDriveFolder = useCallback(async (token, parentId, name) => {
    if (!name.trim()) return;
    setIsGDriveLoading(true);
    try {
      const response = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: name,
          mimeType: 'application/vnd.google-apps.folder',
          parents: parentId === 'root' ? [] : [parentId]
        })
      });

      if (response.status === 401) {
        handleGoogleLogout();
        throw new Error('セッションが切れました。再度ログインしてください。');
      }
      if (!response.ok) throw new Error('フォルダ作成に失敗しました');

      setStatus({ type: 'success', message: `フォルダ "${name}" を作成しました` });
      setIsCreatingFolder(false);
      setNewFolderName('');

      // 再読み込み
      fetchGDriveContents(parentId);
      // ピッカー内のフォルダ一覧も更新（必要であれば）
      fetchGDriveFolders(token, parentId);

    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setIsGDriveLoading(false);
    }
  }, [fetchGDriveContents, setStatus]);

  const fetchGDriveFolders = useCallback(async (token, folderId = 'root') => {
    setIsGDriveLoading(true);
    try {
      if (folderId === 'root' && pickerDriveType === 'shared') {
        const drives = await fetchGDriveDrives(token);
        setGDriveDrives(drives);
        setGDriveFolders([]);
      } else {
        const q = folderId === 'root' ? "'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false" : `'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
        const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=100`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.status === 401) {
          handleGoogleLogout();
          return;
        }
        const data = await response.json();
        setGDriveFolders(data.files || []);
      }
    } catch (err) {
      console.error('Failed to fetch folders:', err);
    } finally {
      setIsGDriveLoading(false);
    }
  }, [pickerDriveType]);

  const navigateGDriveBrowserTo = useCallback((index) => {
    const newPath = gDriveBrowserPath.slice(0, index + 1);
    setGDriveBrowserPath(newPath);
    const targetId = newPath[newPath.length - 1].id;
    // 'home' の場合は保存先を 'root' (マイドライブ) とみなす
    setSelectedFolderId(targetId === 'home' ? 'root' : targetId);
    fetchGDriveContents(targetId);
  }, [gDriveBrowserPath, fetchGDriveContents]);

  const renameGDriveFolder = useCallback(async (folderId, newName, currentParentId = 'home') => {
    console.log('[useGDrive] renameGDriveFolder map:', { folderId, newName, currentParentId });
    setIsGDriveLoading(true);
    try {
      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}?supportsAllDrives=true`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${gDriveToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: newName })
      });

      console.log('[useGDrive] API response status:', response.status);

      if (response.status === 401) {
        handleGoogleLogout();
        throw new Error('セッションが切れました。再度ログインしてください。');
      }

      if (!response.ok) {
        const errText = await response.text();
        console.error('[useGDrive] API error response:', errText);
        throw new Error('フォルダ名の変更に失敗しました');
      }

      // 成功時、現在のディレクトリを再読み込みして表示を更新する
      console.log('[useGDrive] Rename successful, refreshing list for parent:', currentParentId);
      await fetchGDriveContents(currentParentId);
      return true;
    } catch (err) {
      console.error('Rename failed:', err);
      return false;
    } finally {
      setIsGDriveLoading(false);
    }
  }, [gDriveToken, handleGoogleLogout, fetchGDriveContents]);

  const navigateGDriveBrowser = useCallback((folderId, folderName) => {
    const newPath = [...gDriveBrowserPath, { id: folderId, name: folderName }];
    setGDriveBrowserPath(newPath);
    setSelectedFolderId(folderId === 'home' ? 'root' : folderId);
    fetchGDriveContents(folderId);
  }, [gDriveBrowserPath, fetchGDriveContents]);

  const duplicateGDriveFolder = useCallback(async (folderId, folderName, parentId) => {
    if (!gDriveToken) return;
    if (parentId === 'home') {
      setStatus({ type: 'error', message: 'この場所ではフォルダの複製ができません' });
      return;
    }
    setIsGDriveProcessing(true);
    setStatus({ type: 'info', message: `フォルダ「${folderName}」を複製中...` });
    try {
      const copyFolderName = `${folderName} コピー`;
      const listContents = async (fid) => {
        const all = [];
        let pageToken = null;
        do {
          const q = `'${fid}' in parents and trashed=false`;
          let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType),nextPageToken&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=200`;
          if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
          const res = await fetch(url, { headers: { 'Authorization': `Bearer ${gDriveToken}` } });
          if (!res.ok) throw new Error('フォルダ内容の取得に失敗しました');
          const data = await res.json();
          all.push(...(data.files || []));
          pageToken = data.nextPageToken || null;
        } while (pageToken);
        return all;
      };
      const createFolder = async (pId, name) => {
        const res = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${gDriveToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            mimeType: 'application/vnd.google-apps.folder',
            parents: pId === 'root' ? [] : [pId]
          })
        });
        if (!res.ok) throw new Error(`フォルダ作成に失敗: ${name}`);
        const data = await res.json();
        return data.id;
      };
      const copyFile = async (fileId, newParentId, fileName) => {
        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/copy?supportsAllDrives=true`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${gDriveToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parents: newParentId === 'root' ? [] : [newParentId],
            name: fileName
          })
        });
        if (!res.ok) throw new Error(`ファイルコピーに失敗: ${fileName}`);
      };
      const duplicateRecursive = async (srcId, destParentId, name) => {
        const newFolderId = await createFolder(destParentId, name);
        const items = await listContents(srcId);
        for (const item of items) {
          if (item.mimeType === 'application/vnd.google-apps.folder') {
            await duplicateRecursive(item.id, newFolderId, item.name);
          } else {
            await copyFile(item.id, newFolderId, item.name);
          }
        }
        return newFolderId;
      };
      await duplicateRecursive(folderId, parentId, copyFolderName);
      setStatus({ type: 'success', message: `フォルダ「${copyFolderName}」を作成しました` });
      await fetchGDriveContents(parentId);
    } catch (err) {
      console.error('Duplicate folder failed:', err);
      setStatus({ type: 'error', message: err.message || 'フォルダの複製に失敗しました' });
    } finally {
      setIsGDriveProcessing(false);
    }
  }, [gDriveToken, handleGoogleLogout, fetchGDriveContents, setStatus]);

  const navigateToGDriveFolder = useCallback((folderId, folderName) => {
    setPickerFolderId(folderId);
    let newCrumbs;
    if (folderId === 'root') {
      newCrumbs = [{ id: 'root', name: pickerDriveType === 'mydrive' ? 'マイドライブ' : '共有ドライブ一覧' }];
    } else {
      const existingIdx = pickerBreadcrumbs.findIndex(c => c.id === folderId);
      if (existingIdx !== -1) {
        newCrumbs = pickerBreadcrumbs.slice(0, existingIdx + 1);
      } else {
        newCrumbs = [...pickerBreadcrumbs, { id: folderId, name: folderName }];
      }
    }
    setPickerBreadcrumbs(newCrumbs);
    fetchGDriveFolders(gDriveToken, folderId);
  }, [gDriveToken, pickerBreadcrumbs, pickerDriveType, fetchGDriveFolders]);

  return {
    gDriveToken, setGDriveToken,
    gDriveBrowserLoading,
    gDriveBrowserFiles,
    gDriveBrowserPath,
    setGDriveBrowserPath,
    selectedFolderId, setSelectedFolderId,
    gDriveFolders,
    pickerFolderId,
    pickerBreadcrumbs,
    gDriveDrives,
    pickerDriveType, setPickerDriveType,
    isFolderPickerOpen, setIsFolderPickerOpen,
    isCreatingFolder, setIsCreatingFolder,
    newFolderName, setNewFolderName,
    folderSearchTerm, setFolderSearchTerm,
    isGDriveLoading,
    isGDriveProcessing, setIsGDriveProcessing,
    handleGoogleLogout,
    fetchGDriveContents,
    createGDriveFolder,
    fetchGDriveFolders,
    renameGDriveFolder,
    duplicateGDriveFolder,
    navigateGDriveBrowserTo,
    navigateGDriveBrowser,
    navigateToGDriveFolder
  };
};
