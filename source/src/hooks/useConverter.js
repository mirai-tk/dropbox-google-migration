import { useState, useCallback } from 'react';
import { cleanMarkdown, generateDocxBlob } from '../utils/markdownParser';
import { convertTaskMarkersToNativeChecklists } from '../utils/googleDocsChecklist';

// 軽量ファイルの同時処理数（80MB 超は直列・ネイティブエンジンと揃える）
const MIGRATION_POOL_SIZE = 5;
/** これを超える通常ファイルは Dropbox ストリーム → GDrive resumable。かつこの閾値超は同時1件のみ。 */
const STREAMING_MIGRATION_MIN_BYTES = 80 * 1024 * 1024;
const RESUMABLE_CHUNK_SIZE = 256 * 1024;

/** ファイルサイズが分かるときの DL/UL バイト表示用（％から近似） */
const transferBytesFields = (totalBytes, dlPct, ulPct) => {
  if (!totalBytes || totalBytes <= 0) return {};
  const t = Math.max(0, totalBytes);
  return {
    bytes_total: t,
    bytes_downloaded: Math.min(t, Math.round((t * dlPct) / 100)),
    bytes_uploaded: Math.min(t, Math.round((t * ulPct) / 100)),
  };
};

const asyncPool = async (poolLimit, array, iteratorFn) => {
  const ret = [];
  const executing = new Set();
  for (const item of array) {
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);
    executing.add(p);
    const clean = p.finally(() => executing.delete(p));
    if (executing.size >= poolLimit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(ret);
};

/** ログ表示: root 配下の相対パスを path_display のまま返す（path_lower の全面小文字を避ける） */
function dropboxRelativePathForLog(rootPath, entry) {
  const pl = (entry.path_lower || '').replace(/\/+$/, '');
  const pd = (entry.path_display || pl || '').replace(/\/+$/, '');
  const name = entry.name || '';
  const rp = (rootPath || '').replace(/\/+$/, '').toLowerCase();
  const plLc = pl.toLowerCase();
  if (rp && !plLc.startsWith(rp)) return name;
  const rpParts = rp.split('/').filter(Boolean);
  const depth = rpParts.length;
  const pdParts = pd.split('/').filter(Boolean);
  if (pdParts.length > depth) return pdParts.slice(depth).join('/');
  return name;
}

/** WebKit/pywebview で fetch/ストリーム失敗時に message が "Load failed" だけになることがある */
function formatNativeStreamFatalError(err) {
  const raw = err?.message != null ? String(err.message) : String(err);
  const name = err?.name ? String(err.name) : '';
  const prefix = name ? `[${name}] ` : '';
  if (raw === 'Load failed' || raw === 'Failed to fetch') {
    return {
      userMessage:
        '接続が切断されました（ネットワークの異常、または長時間転送で WebView がストリームを閉じた可能性があります）。desktop/logs/app_latest.log にサーバ側の記録がないか確認してください。',
      logLine: `${prefix}${raw}`,
    };
  }
  return { userMessage: raw, logLine: `${prefix}${raw}` };
}

/** ブラウザ移行完了時の OS 通知（ネイティブエンジン時は Python が通知するためスキップ） */
function notifyMigrationCompleteDesktop(rootFolderName) {
  if (import.meta.env.VITE_USE_NATIVE_ENGINE === 'true') return;
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return;
  const body = `「${rootFolderName}」の移行が完了しました`;
  const title = '移行完了';
  const run = () => {
    try {
      new Notification(title, { body });
    } catch {
      /* ignore */
    }
  };
  if (Notification.permission === 'granted') {
    run();
  } else if (Notification.permission === 'default') {
    void Notification.requestPermission().then((p) => {
      if (p === 'granted') run();
    });
  }
}

export const useConverter = (
  selectedFolderId,
  gDriveBrowserPath = [],
  setStatus,
  setContent,
  setCurrentFileName,
  setCurrentFilePath,
  setActiveTab,
  fetchGDriveContents,
  getApiHeaders,
  asciiSafeJson,
  handleDropboxLogout,
  handleGoogleLogout,
  listFolderRecursive,
  dbTokenRef,
  gDriveTokenRef,
  refreshGoogleToken,
  refreshDropboxToken,
  addLog,
  rootNamespaceId = null
) => {
  const [isGDriveProcessing, setIsGDriveProcessing] = useState(false);
  const [exportingId, setExportingId] = useState(null);

  const log = useCallback((msg, type = 'info', id = null, progress = null) => {
    if (addLog) {
      addLog({
        id: id,
        message: msg,
        type: type,
        progress: progress,
        time: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
      });
    }
  }, [addLog]);

  const gFetch = async (url, options = {}, retry = true) => {
    let response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${gDriveTokenRef.current}`
      }
    });

    if (response.status === 401 && retry && refreshGoogleToken) {
      console.log('[useConverter] GDrive token expired, refreshing...');
      try {
        const newToken = await refreshGoogleToken();
        // Retry with new token
        response = await fetch(url, {
          ...options,
          headers: {
            ...options.headers,
            'Authorization': `Bearer ${newToken}`
          }
        });
      } catch (err) {
        console.error('[useConverter] Token refresh failed:', err);
      }
    }
    return response;
  };

  // Streams APIでmultipartを組み立ててfetch（リアルタイム進捗・Chrome105+等で動作）
  const createMultipartStream = (metadata, fileBlob, filename, onProgress, progressRange) => {
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2, 14);
    const enc = new TextEncoder();
    const [min, max] = progressRange || [0, 100];
    const metaStr = JSON.stringify(metadata);
    const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaStr}\r\n`;
    const fileHeader = `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    const metaBytes = enc.encode(metaPart);
    const headerBytes = enc.encode(fileHeader);
    const footerBytes = enc.encode(footer);
    const totalSize = metaBytes.length + headerBytes.length + (fileBlob.size || 0) + footerBytes.length;
    let loaded = 0;
    const reportProgress = () => {
      if (onProgress && totalSize > 0) {
        const pct = (loaded / totalSize) * 100;
        const display = Math.round(min + (pct / 100) * (max - min));
        onProgress(display);
      }
    };
    let fileReader = null;
    let phase = 'meta';
    const stream = new ReadableStream({
      async pull(controller) {
        if (phase === 'meta') {
          controller.enqueue(metaBytes);
          loaded += metaBytes.length;
          reportProgress();
          controller.enqueue(headerBytes);
          loaded += headerBytes.length;
          reportProgress();
          phase = 'file';
          fileReader = fileBlob.stream().getReader();
          return;
        }
        if (phase === 'file') {
          const { done, value } = await fileReader.read();
          if (done) {
            fileReader.releaseLock();
            phase = 'footer';
            return;
          }
          loaded += value.length;
          reportProgress();
          controller.enqueue(value);
          return;
        }
        if (phase === 'footer') {
          controller.enqueue(footerBytes);
          loaded = totalSize;
          reportProgress();
          controller.close();
        }
      }
    });
    return { stream, boundary };
  };

  const GDRIVE_STREAM_UPLOAD_TIMEOUT_MS = 120000; // 2分でタイムアウト→FormDataにフォールバック
  const gUploadWithFetchStream = async (url, metadata, fileBlob, filename, logId, progressRange) => {
    console.log('[GDrive] multipart upload開始 (stream) size=', fileBlob?.size);
    const { stream, boundary } = createMultipartStream(metadata, fileBlob, filename, (p) => addLog && addLog({ id: logId, progress: p }), progressRange);
    const doUpload = async (token) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
        console.warn('[GDrive] stream upload タイムアウト、FormDataで再試行します');
      }, GDRIVE_STREAM_UPLOAD_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': `multipart/related; boundary=${boundary}`
          },
          body: stream,
          duplex: 'half',
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (res.status === 401 && refreshGoogleToken) {
          const newToken = await refreshGoogleToken();
          return doUpload(newToken);
        }
        return res;
      } catch (e) {
        clearTimeout(timeoutId);
        throw e;
      }
    };
    const res = await doUpload(gDriveTokenRef.current);
    if (logId && addLog) addLog({ id: logId, progress: progressRange[1] });
    console.log('[GDrive] multipart upload完了 (stream) status=', res?.status);
    try {
      return { ok: res.ok, status: res.status, json: () => res.json() };
    } catch {
      return { ok: res.ok, status: res.status, json: () => ({}) };
    }
  };

  // fetchベースのアップロード（Streams非対応時・シミュレーション進捗）
  const gUploadWithFetch = async (url, body, contentType, logId, progressRange = [0, 100]) => {
    const [min, max] = progressRange;
    console.log('[GDrive] multipart upload開始 (fetch)');
    if (logId && addLog) addLog({ id: logId, progress: min });
    const targetProgress = max - 2;
    let progressValue = min;
    const progressInterval = setInterval(() => {
      if (progressValue < targetProgress && logId && addLog) {
        progressValue = Math.min(progressValue + 2, targetProgress);
        addLog({ id: logId, progress: progressValue });
      }
    }, 300);
    try {
      const doUpload = async (token) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            ...(contentType && { 'Content-Type': contentType })
          },
          body
        });
        if (res.status === 401 && refreshGoogleToken) {
          const newToken = await refreshGoogleToken();
          return doUpload(newToken);
        }
        return res;
      };
      const res = await doUpload(gDriveTokenRef.current);
      if (logId && addLog) addLog({ id: logId, progress: max });
      console.log('[GDrive] multipart upload完了 (fetch) status=', res?.status);
      try {
        return { ok: res.ok, status: res.status, json: () => res.json() };
      } catch {
        return { ok: res.ok, status: res.status, json: () => ({}) };
      }
    } catch (e) {
      console.warn('[GDrive] multipart upload失敗:', e?.message);
      throw e;
    } finally {
      clearInterval(progressInterval);
    }
  };

  // 5MB以下はFormDataを直接使用（streamは一部環境でハングするため）
  const GDRIVE_STREAM_THRESHOLD = 5 * 1024 * 1024;
  // fetch + Streams APIでアップロード（streamOptsあり時）、失敗時はFormDataにフォールバック
  const gUpload = async (url, body, contentType, logId, progressRange, fileSizeBytes = 0, streamOpts = null) => {
    const useStream = streamOpts?.metadata && streamOpts?.fileBlob && streamOpts?.filename && fileSizeBytes > GDRIVE_STREAM_THRESHOLD;
    if (useStream) {
      try {
        return await gUploadWithFetchStream(url, streamOpts.metadata, streamOpts.fileBlob, streamOpts.filename, logId, progressRange);
      } catch (err) {
        if (addLog) addLog({ id: logId, message: 'Streams API失敗、FormDataで再試行...' });
      }
    }
    return gUploadWithFetch(url, body, contentType, logId, progressRange);
  };

  // Resumable Upload: XHRでLocationヘッダー取得（FetchはCORSで取得不可のため）
  const gDriveResumableInit = async (metadata, fileSize, mimeType) => {
    const doInit = async (tokenOverride = null) => {
      const token = tokenOverride ?? gDriveTokenRef.current;
      if (!token) throw new Error('Google Drive token required');
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true');
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
        xhr.setRequestHeader('X-Upload-Content-Length', String(fileSize));
        xhr.setRequestHeader('X-Upload-Content-Type', mimeType || 'application/octet-stream');
        xhr.onload = () => {
          if (xhr.status === 401 && refreshGoogleToken) {
            console.log('[useConverter] GDrive token expired (resumable init), refreshing...');
            refreshGoogleToken().then((newToken) => doInit(newToken).then(resolve).catch(reject)).catch(reject);
            return;
          }
          const location = xhr.getResponseHeader('Location');
          if (location) resolve(location);
          else reject(new Error('Resumable init failed: no Location header'));
        };
        xhr.onerror = () => {
          if (refreshGoogleToken) {
            console.log('[useConverter] Resumable init failed (network/CORS), trying token refresh...');
            refreshGoogleToken().then((newToken) => doInit(newToken).then(resolve).catch(reject)).catch(reject);
          } else {
            reject(new Error('Resumable init failed'));
          }
        };
        xhr.send(JSON.stringify(metadata));
      });
    };
    return doInit();
  };

  // Resumable Upload: チャンクをPUT（FetchのCORS制限を避けるためXHRを使用）
  const gDriveResumableChunkPut = async (uri, chunk, rangeStart, rangeEnd, totalSize) => {
    let token = gDriveTokenRef.current;
    const doPut = () => {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const putStartTime = Date.now();
        xhr.timeout = 300000; // 5分（最終チャンクでハング検知用）
        xhr.open('PUT', uri);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.setRequestHeader('Content-Range', `bytes ${rangeStart}-${rangeEnd - 1}/${totalSize}`);
        xhr.responseType = 'json';
        xhr.onload = () => {
          const elapsed = ((Date.now() - putStartTime) / 1000).toFixed(1);
          if (xhr.status === 401 && refreshGoogleToken) {
            console.log('[useConverter] GDrive token expired (chunk PUT), refreshing...');
            refreshGoogleToken().then((newToken) => {
              token = newToken;
              doPut().then(resolve).catch(reject);
            }).catch(reject);
            return;
          }
          if (xhr.status !== 200 && xhr.status !== 201 && xhr.status !== 308) {
            console.warn(`[Resumable] Chunk PUT 異常 status=${xhr.status} elapsed=${elapsed}s`);
          }
          resolve({ ok: xhr.status === 200 || xhr.status === 201 || xhr.status === 308, status: xhr.status, json: () => Promise.resolve(xhr.response || {}) });
        };
        xhr.ontimeout = () => {
          console.warn(`[Resumable] Chunk PUT タイムアウト elapsed=${((Date.now() - putStartTime) / 1000).toFixed(1)}s`);
        };
        xhr.onerror = () => {
          if (refreshGoogleToken) {
            console.log('[useConverter] Chunk PUT failed (network/CORS), trying token refresh...');
            refreshGoogleToken().then((newToken) => {
              token = newToken;
              doPut().then(resolve).catch(reject);
            }).catch(reject);
          } else {
            reject(new Error('Resumable chunk PUT failed'));
          }
        };
        xhr.send(chunk);
      });
    };
    return doPut();
  };

  // 400MB超: Dropboxからストリーム読み取り→GDrive Resumableで分割アップロード
  const streamUploadFromDropboxToGDrive = async (dropboxUrl, dropboxOptions, metadata, fileSize, mimeType, logId, progressRange) => {
    const [min, max] = progressRange || [0, 100];
    let chunkIndex = 0;
    const reportProgress = (uploadOffset, readTotal) => {
      const dlPct = fileSize > 0 ? Math.min(100, (readTotal / fileSize) * 100) : 0;
      const ulPct = fileSize > 0 ? Math.min(100, (uploadOffset / fileSize) * 100) : 0;
      const comb = (dlPct + ulPct) / 2;
      const display = Math.round(min + (comb / 100) * (max - min));
      if (addLog) {
        addLog({
          id: logId,
          progress: display,
          progress_download: Math.round(dlPct),
          progress_upload: Math.round(ulPct),
          ...transferBytesFields(fileSize, dlPct, ulPct),
        });
      }
    };
    if (addLog) addLog({ id: logId, message: '分割送信でアップロード中...' });
    console.log('[Resumable] 開始: ファイルサイズ=', fileSize, 'bytes, チャンク=', RESUMABLE_CHUNK_SIZE);
    const res = await dFetch(dropboxUrl, dropboxOptions);
    if (!res.ok) return { ok: false, status: res.status };
    const reader = res.body.getReader();
    console.log('[Resumable] Dropbox接続OK、init開始');
    const uploadUri = await gDriveResumableInit(metadata, fileSize, mimeType);
    console.log('[Resumable] GDrive init OK、チャンク送信開始');
    let offset = 0;
    let readBytes = 0;
    let buffer = [];
    let bufferedLen = 0;
    let lastPutRes = null;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        readBytes += value.byteLength;
        buffer.push(value);
        bufferedLen += value.byteLength;
        while (bufferedLen >= RESUMABLE_CHUNK_SIZE) {
          const chunkSize = Math.floor(bufferedLen / RESUMABLE_CHUNK_SIZE) * RESUMABLE_CHUNK_SIZE;
          const chunks = [];
          let remaining = chunkSize;
          while (remaining > 0 && buffer.length > 0) {
            const b = buffer[0];
            if (b.byteLength <= remaining) {
              chunks.push(b);
              remaining -= b.byteLength;
              buffer.shift();
            } else {
              chunks.push(b.slice(0, remaining));
              buffer[0] = b.slice(remaining);
              remaining = 0;
            }
          }
          bufferedLen -= chunkSize;
          const chunk = new Uint8Array(chunkSize);
          let pos = 0;
          for (const c of chunks) {
            chunk.set(c, pos);
            pos += c.byteLength;
          }
          const rangeEnd = Math.min(offset + chunkSize, fileSize);
          chunkIndex++;
          const isLastChunk = rangeEnd >= fileSize;
          console.log(`[Resumable] チャンク #${chunkIndex} PUT開始 bytes ${offset}-${rangeEnd - 1}/${fileSize}${isLastChunk ? ' (最終)' : ''}`);
          lastPutRes = await gDriveResumableChunkPut(uploadUri, chunk, offset, rangeEnd, fileSize);
          const pct = fileSize > 0 ? ((rangeEnd / fileSize) * 100).toFixed(1) : 0;
          console.log(`[Resumable] チャンク #${chunkIndex} PUT完了 status=${lastPutRes?.status} (進捗${pct}%)`);
          if (!lastPutRes.ok && lastPutRes.status !== 308) return { ok: false, status: lastPutRes.status };
          offset = rangeEnd;
          reportProgress(offset, readBytes);
        }
      }
      if (bufferedLen > 0) {
        const chunk = new Uint8Array(bufferedLen);
        let pos = 0;
        for (const b of buffer) {
          chunk.set(b, pos);
          pos += b.byteLength;
        }
        const rangeEnd = offset + bufferedLen;
        chunkIndex++;
        console.log(`[Resumable] 最終チャンク #${chunkIndex} PUT開始 bytes ${offset}-${rangeEnd - 1}/${fileSize}`);
        lastPutRes = await gDriveResumableChunkPut(uploadUri, chunk, offset, rangeEnd, fileSize);
        console.log(`[Resumable] 最終チャンク PUT完了 status=${lastPutRes?.status} (100%)`);
        if (!lastPutRes.ok) return { ok: false, status: lastPutRes.status };
        reportProgress(rangeEnd, readBytes);
      }
      console.log('[Resumable] 全チャンク送信完了、progress=max');
      if (addLog) {
        addLog({
          id: logId,
          progress: max,
          progress_download: 100,
          progress_upload: 100,
          ...transferBytesFields(fileSize, 100, 100),
        });
      }
      return { ok: lastPutRes?.ok ?? true, status: lastPutRes?.status ?? 200, json: () => lastPutRes?.json?.() ?? Promise.resolve({}) };
    } finally {
      reader.releaseLock();
    }
  };

  const dFetch = async (url, options = {}, retry = true) => {
    let response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${dbTokenRef.current}`
      }
    });

    if (response.status === 401 && retry && refreshDropboxToken) {
      console.log('[useConverter] Dropbox token expired, refreshing...');
      try {
        const newToken = await refreshDropboxToken();
        // Retry with new token
        response = await fetch(url, {
          ...options,
          headers: {
            ...options.headers,
            'Authorization': `Bearer ${newToken}`
          }
        });
      } catch (err) {
        console.error('[useConverter] Dropbox token refresh failed:', err);
      }
    }
    return response;
  };

  // fetch + Streams APIでDropboxダウンロード（リアルタイム進捗・Content-Lengthがある場合）
  const dFetchWithProgressStream = async (url, options, onProgress) => {
    const res = await dFetch(url, options);
    const contentLength = res.headers.get('Content-Length');
    if (!res.ok || !contentLength || !onProgress || !res.body) {
      console.log('[Dropbox] ダウンロード開始 (blob一括) Content-Lengthなし');
      const blob = await res.blob();
      console.log('[Dropbox] ダウンロード完了 (blob) size=', blob.size);
      return { ok: res.ok, status: res.status, blob: () => Promise.resolve(blob), text: () => blob.text() };
    }
    const total = parseInt(contentLength, 10) || 0;
    if (total <= 0) {
      const blob = await res.blob();
      return { ok: res.ok, status: res.status, blob: () => Promise.resolve(blob), text: () => blob.text() };
    }
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.length;
      onProgress(Math.round((loaded / total) * 100));
      chunks.push(value);
    }
    const blob = new Blob(chunks);
    console.log('[Dropbox] ダウンロード完了 size=', blob.size);
    return { ok: res.ok, status: res.status, blob: () => Promise.resolve(blob), text: () => blob.text() };
  };

  // リトライ付きDropboxダウンロード（fetch + Streams APIで進捗、最大5回リトライ）
  const DROPBOX_DOWNLOAD_MAX_RETRIES = 5;
  const dFetchWithProgressRetry = async (url, options = {}, onProgress, fileSizeBytes = 0) => {
    const isDownload = url.includes('/files/download');
    if (isDownload && fileSizeBytes > 0) console.log('[Dropbox] ダウンロード開始 size=', fileSizeBytes);
    const tryFetch = async () => {
      const res = await dFetch(url, options);
      return { ok: res.ok, status: res.status, blob: () => res.blob(), text: () => res.text() };
    };
    let lastError;
    for (let attempt = 0; attempt < DROPBOX_DOWNLOAD_MAX_RETRIES; attempt++) {
      try {
        let result;
        try {
          result = await dFetchWithProgressStream(url, options, onProgress);
        } catch (streamErr) {
          if (addLog) addLog({ id: options._logId, message: 'Streams API失敗、fetchで再試行...' });
          result = await tryFetch();
        }
        if (result.ok) return result;
        if (result.status === 401) return result;
        if (result.status === 0 || result.status >= 500 || result.status === 429) {
          lastError = new Error(result.status === 0 ? 'Dropbox connection failed' : `Dropbox API error: ${result.status}`);
          throw lastError;
        }
        return result;
      } catch (err) {
        lastError = err;
        if (attempt < DROPBOX_DOWNLOAD_MAX_RETRIES - 1) {
          const delayMs = Math.min(2000 * Math.pow(2, attempt), 30000);
          if (addLog) addLog({ id: options._logId, message: `リトライ ${attempt + 2}/${DROPBOX_DOWNLOAD_MAX_RETRIES} (${delayMs / 1000}秒後)...` });
          await new Promise((r) => setTimeout(r, delayMs));
        } else {
          throw lastError;
        }
      }
    }
    throw lastError;
  };

  const createGDriveFolderSilent = async (parentId, name) => {
    try {
      const response = await gFetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: name,
          mimeType: 'application/vnd.google-apps.folder',
          parents: parentId === 'root' ? [] : [parentId]
        })
      });
      if (!response.ok) throw new Error('Failed to create folder');
      const data = await response.json();
      return data.id;
    } catch (err) {
      console.error('Folder creation failed:', err);
      return null;
    }
  };



  const transferRawFileToGDrive = useCallback(async (targetPath, targetFileName) => {
    if (!gDriveTokenRef.current) {
      setStatus({ type: 'error', message: 'Google Driveにログインしてください。' });
      return false;
    }
    const transferId = `transfer-${targetPath}`;
    setExportingId(targetPath);
    setIsGDriveProcessing(true);
    log(`ファイル転送中: ${targetFileName}...`, 'info', transferId, 0);

    try {
      const response = await dFetch('https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: {
          ...getApiHeaders(true),
          'Dropbox-API-Arg': asciiSafeJson({ path: targetPath })
        }
      });

      if (response.status === 401) {
        handleDropboxLogout(false);
        throw new Error('Dropbox セッションが切れました。再度ログインしてください。');
      }
      if (!response.ok) throw new Error('Dropbox からのダウンロードに失敗しました');

      let fileBlob = await response.blob();
      const extMatch = targetFileName.match(/\.([^.]+)$/);
      const ext = extMatch ? extMatch[1].toLowerCase() : '';

      let mimeType = 'application/octet-stream';
      const mimeTypes = {
        'pdf': 'application/pdf',
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'txt': 'text/plain',
        'csv': 'text/csv',
        'zip': 'application/zip'
      };

      if (mimeTypes[ext]) {
        mimeType = mimeTypes[ext];
      } else if (fileBlob.type) {
        mimeType = fileBlob.type;
      }

      const metadata = {
        name: targetFileName,
        mimeType: mimeType,
        parents: selectedFolderId === 'root' ? [] : [selectedFolderId]
      };

      let form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', fileBlob);

      const uploadRes = await gUpload(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
        form, null, transferId, [0, 100], fileBlob.size || 0,
        { metadata, fileBlob, filename: targetFileName }
      );

      if (!uploadRes.ok) throw new Error('Google ドライブへのアップロードに失敗しました');

      fileBlob = form = null;
      setStatus({ type: 'success', message: `Google ドライブにアップロードしました: ${targetFileName}` });
      const basePath = gDriveBrowserPath?.length > 0 ? gDriveBrowserPath.map(p => p.name === 'Home' ? 'マイドライブ' : p.name).join('/') : (selectedFolderId === 'root' ? 'マイドライブ' : 'フォルダ');
      log(`ファイル転送完了: ${basePath}/${targetFileName}`, 'success', transferId, 100);
      if (fetchGDriveContents) fetchGDriveContents(selectedFolderId);
      return true;
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
      return false;
    } finally {
      setIsGDriveProcessing(false);
      setExportingId(null);
    }
  }, [gDriveTokenRef, getApiHeaders, asciiSafeJson, setStatus, handleDropboxLogout, handleGoogleLogout, selectedFolderId, gDriveBrowserPath, fetchGDriveContents, dFetch, gFetch]);

  const fetchAndExport = useCallback(async (targetPath, targetFileName, isPaperDocument = false) => {
    if (targetFileName.toLowerCase().endsWith('.web')) {
      setStatus({ type: 'warning', message: '.web 形式のファイルは非対応のためスキップしました' });
      return;
    }
    // 明示的にPaperドキュメントと指定されているか、拡張子が .paper の場合のみエクスポートを試みる
    if (!isPaperDocument && !targetFileName.toLowerCase().endsWith('.paper')) {
      return transferRawFileToGDrive(targetPath, targetFileName, pathDisplay ?? targetPath);
    }

    const exportId = `export-${targetPath}`;
    setExportingId(targetPath);
    setIsGDriveProcessing(true);
    setStatus({ type: 'info', message: `${targetFileName} を変換中...` });
    log(`変換開始: ${targetFileName}...`, 'info', exportId, 0);

    try {
      const response = await dFetch('https://content.dropboxapi.com/2/files/export', {
        method: 'POST',
        headers: {
          ...getApiHeaders(true),
          'Dropbox-API-Arg': asciiSafeJson({
            path: targetPath,
            export_format: 'markdown'
          })
        }
      });

      if (response.status === 401) {
        handleDropboxLogout(false);
        throw new Error('Dropbox セッションが切れました。再度ログインしてください。');
      }
      if (!response.ok) throw new Error('エクスポートに失敗しました。このファイルはPaperドキュメントではない可能性があります。');

      addLog({ id: exportId, progress: 50 });
      const markdownText = await response.text();
      setContent(cleanMarkdown(markdownText));
      setCurrentFileName(targetFileName.replace(/\.paper$/, ''));
      setCurrentFilePath(targetPath);
      setActiveTab('editor');
      setStatus({ type: 'success', message: 'Paperドキュメントの取得に成功しました' });
      log(`変換完了: ${targetPath}`, 'success', exportId, 100);

    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setIsGDriveProcessing(false);
      setExportingId(null);
    }
  }, [getApiHeaders, asciiSafeJson, handleDropboxLogout, setStatus, setContent, setCurrentFileName, setCurrentFilePath, setActiveTab, dFetch, transferRawFileToGDrive]);

  const saveToGoogleDocs = useCallback(async (content, currentFileName) => {
    if (!content || !gDriveTokenRef.current) return;

    const saveId = `save-${currentFileName}`;
    setIsGDriveProcessing(true);
    setStatus({ type: 'info', message: 'Google ドキュメントを作成中...' });
    log(`Google ドキュメント保存中: ${currentFileName}...`, 'info', saveId, 0);

    try {
      addLog({ id: saveId, progress: 10 });

      // Word(Docx)の形式として成形してからアップロードする。Markdown直ではなくDocx経由にすることで
      // Google Docs が改行やレイアウト、画像を解釈しやすくする。
      let docxBlob = await generateDocxBlob(currentFileName, content, dbTokenRef.current);

      const metadata = {
        name: currentFileName,
        mimeType: 'application/vnd.google-apps.document',
        parents: selectedFolderId !== 'root' ? [selectedFolderId] : []
      };

      let form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', docxBlob);

      const response = await gUpload(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
        form, null, saveId, [0, 100], docxBlob.size || 0,
        { metadata, fileBlob: docxBlob, filename: currentFileName }
      );

      if (!response.ok) throw new Error('Google ドライブへのアップロードに失敗しました');

      docxBlob = form = null;
      const data = await response.json();
      try {
        await convertTaskMarkersToNativeChecklists(data.id, gDriveTokenRef.current);
      } catch (e) {
        console.warn('[GDoc] チェックリスト API 後処理:', e?.message || e);
      }
      setStatus({ type: 'success', message: `Google ドキュメントを作成しました: ${currentFileName}` });
      const gDriveSavePath = (gDriveBrowserPath?.length > 0 ? gDriveBrowserPath.map(p => p.name === 'Home' ? 'マイドライブ' : p.name).join('/') : (selectedFolderId === 'root' ? 'マイドライブ' : 'フォルダ')) + '/' + currentFileName;
      log(`作成完了: ${gDriveSavePath}`, 'success', saveId, 100);
      window.open(`https://docs.google.com/document/d/${data.id}/edit`, '_blank');
      if (fetchGDriveContents) fetchGDriveContents(selectedFolderId);

    } catch (err) {
      if (err.message && !err.message.includes('401')) {
        setStatus({ type: 'error', message: err.message });
      }
    } finally {
      setIsGDriveProcessing(false);
    }
  }, [gDriveTokenRef, selectedFolderId, gDriveBrowserPath, setStatus, fetchGDriveContents, dbTokenRef]);

  const gDriveFileExists = async (folderId, fileName) => {
    const escaped = (fileName || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = `'${folderId}' in parents and name='${escaped}' and trashed = false`;
    try {
      const response = await gFetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id, size)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`);
      if (!response.ok) return null;
      const data = await response.json();
      const files = data.files || [];
      return files.length > 0 ? { id: files[0].id, size: files[0].size != null ? parseInt(files[0].size, 10) : null } : null;
    } catch {
      return null;
    }
  };

  const gDriveDeleteFile = async (fileId) => {
    try {
      const response = await gFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`, { method: 'DELETE' });
      return response.ok;
    } catch (err) {
      console.error('GDrive delete failed:', err);
      return false;
    }
  };

  const listGDriveFolder = async (folderId) => {
    try {
      const q = `'${folderId}' in parents and trashed = false`;
      const allFiles = [];
      let pageToken = null;
      do {
        let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id, name, mimeType), nextPageToken&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true`;
        if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
        const response = await gFetch(url);
        if (!response.ok) throw new Error('Failed to list GDrive folder');
        const data = await response.json();
        allFiles.push(...(data.files || []));
        pageToken = data.nextPageToken || null;
      } while (pageToken);
      return allFiles;
    } catch (err) {
      console.error('GDrive listing failed:', err);
      return [];
    }
  };

  const migrateFolderRecursively = useCallback(async (rootPath, rootFolderName) => {
    if (!gDriveTokenRef.current || !dbTokenRef.current) return;

    if (import.meta.env.VITE_USE_NATIVE_ENGINE === 'true') {
      const migrationId = `migrate-${Date.now()}`;
      setIsGDriveProcessing(true);
      setStatus({ type: 'info', message: 'Python エンジンで移行中...' });
      try {
        const res = await fetch('/api/engine/migrate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            root_path: rootPath,
            root_folder_name: rootFolderName,
            selected_folder_id: selectedFolderId,
            dropbox_token: dbTokenRef.current,
            dropbox_ns_id: rootNamespaceId || null,
            dropbox_refresh_token:
              typeof localStorage !== 'undefined'
                ? localStorage.getItem('dropbox_refresh_token')
                : null,
            google_token: gDriveTokenRef.current,
            google_refresh_token:
              typeof localStorage !== 'undefined'
                ? localStorage.getItem('google_refresh_token')
                : null,
            migration_id: migrationId,
          }),
        });
        if (!res.ok) {
          const t = await res.text();
          throw new Error(t || `HTTP ${res.status}`);
        }
        if (!res.body) {
          throw new Error('レスポンスボディがありません（ストリーミング未対応）');
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let firstStreamChunk = true;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (firstStreamChunk && value?.length) {
            firstStreamChunk = false;
            // 応答が遅いと「Python エンジンで移行中」の5秒タイマーだけが先に切れてトーストが空になるのを防ぐ
            setStatus({ type: 'info', message: 'Python エンジンで移行中...' });
          }
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            let ev;
            try {
              ev = JSON.parse(line);
            } catch {
              continue;
            }
            if (ev.type === 'ping') continue;
            if (ev.type === 'log' && addLog) {
              const level = ev.level === 'error' ? 'error' : ev.level === 'success' ? 'success' : 'info';
              addLog({
                id: ev.id,
                message: ev.message,
                type: level,
                progress: ev.progress,
                ...(typeof ev.progress_download === 'number'
                  ? { progress_download: ev.progress_download }
                  : {}),
                ...(typeof ev.progress_upload === 'number'
                  ? { progress_upload: ev.progress_upload }
                  : {}),
                ...(typeof ev.bytes_total === 'number' ? { bytes_total: ev.bytes_total } : {}),
                ...(typeof ev.bytes_downloaded === 'number'
                  ? { bytes_downloaded: ev.bytes_downloaded }
                  : {}),
                ...(typeof ev.bytes_uploaded === 'number' ? { bytes_uploaded: ev.bytes_uploaded } : {}),
              });
              const mid = ev.id && String(ev.id).startsWith('migrate-');
              const msg = ev.message || '';
              if (mid && (msg.includes('移行進捗') || msg.includes('移行開始'))) {
                setStatus({ type: 'info', message: msg });
              }
              // 同一チャンク内の複数ログが React にバッチされ、進捗バーが飛ぶのを防ぐ
              await new Promise((r) => setTimeout(r, 0));
            }
          }
        }
        setStatus({ type: 'success', message: `フォルダ "${rootFolderName}" の移行が完了しました` });
        if (fetchGDriveContents) fetchGDriveContents(selectedFolderId);
      } catch (err) {
        console.error('[Migration native]', err);
        const { userMessage, logLine } = formatNativeStreamFatalError(err);
        setStatus({ type: 'error', message: userMessage });
        log(`致命的なエラー: ${logLine}`, 'error', 'migration-native-fatal');
      } finally {
        setIsGDriveProcessing(false);
      }
      return;
    }

    const migrationId = `migrate-${Date.now()}`;
    setIsGDriveProcessing(true);
    setStatus({ type: 'info', message: 'フォルダ構造を解析中...' });
    console.log('[Migration] 移行開始:', rootFolderName, rootPath);
    log(`移行開始: ${rootFolderName} (${rootPath})`, 'info', migrationId, 0);

    try {
      const allEntries = await listFolderRecursive(rootPath);
      setStatus({ type: 'info', message: 'フォルダ構造を解析中...' });
      // Get all folders except the root folder itself (which we create separately)
      const folders = allEntries
        .filter(e => e['.tag'] === 'folder' && e.path_lower !== rootPath.toLowerCase())
        .sort((a, b) => {
          const aDepth = (a.path_lower.match(/\//g) || []).length;
          const bDepth = (b.path_lower.match(/\//g) || []).length;
          return aDepth - bDepth;
        });
      const files = allEntries.filter(e => e['.tag'] === 'file');

      log(`解析完了: フォルダ ${folders.length + 1}件, ファイル ${files.length}件 を検出`);
      setStatus({ type: 'info', message: `フォルダ作成中... (0/${folders.length + 1})` });

      // Root folder mapping
      log(`ルートフォルダを確認中: ${rootFolderName}...`);
      const rootLevelFiles = await listGDriveFolder(selectedFolderId);
      let gRootId = rootLevelFiles.find(f => f.name === rootFolderName && f.mimeType === 'application/vnd.google-apps.folder')?.id;

      if (gRootId) {
        log(`既存のルートフォルダを使用します: ID=${gRootId}`, 'info');
      } else {
        log(`ルートフォルダを新規作成します: ${rootFolderName}...`);
        gRootId = await createGDriveFolderSilent(selectedFolderId, rootFolderName);
        if (!gRootId) throw new Error('ルートフォルダの作成に失敗しました');
        log(`ルートフォルダ作成完了: ID=${gRootId}`, 'success');
      }

      const folderMap = { [rootPath.toLowerCase()]: gRootId };
      const gDriveChildrenCache = { [gRootId]: await listGDriveFolder(gRootId) };
      // ルート確認〜一覧取得が5秒超えてもトーストが消えたままにならないよう、同文言でタイマーをリセット
      setStatus({ type: 'info', message: `フォルダ作成中... (0/${folders.length + 1})` });

      let folderCount = 1;
      for (const folder of folders) {
        const parentPath = folder.path_lower.substring(0, folder.path_lower.lastIndexOf('/'));
        const gParentId = folderMap[parentPath] || selectedFolderId;

        // Check for existing folder in GDrive
        if (!gDriveChildrenCache[gParentId]) {
          gDriveChildrenCache[gParentId] = await listGDriveFolder(gParentId);
        }

        let gFolderId = gDriveChildrenCache[gParentId].find(f => f.name === folder.name && f.mimeType === 'application/vnd.google-apps.folder')?.id;

        if (gFolderId) {
          log(`既存のフォルダを使用: ${folder.path_display}`, 'info');
        } else {
          log(`フォルダ作成中: ${folder.path_display}...`);
          gFolderId = await createGDriveFolderSilent(gParentId, folder.name);
          if (gFolderId) {
            log(`フォルダ作成完了: ${folder.path_display}`, 'success');
            // Update cache for the parent
            gDriveChildrenCache[gParentId].push({ id: gFolderId, name: folder.name, mimeType: 'application/vnd.google-apps.folder' });
          } else {
            log(`フォルダ作成失敗: ${folder.path_display}`, 'error');
          }
        }

        if (gFolderId) {
          folderMap[folder.path_lower] = gFolderId;
        }

        folderCount++;
        const folderProgress = Math.round((folderCount / (folders.length + 1)) * 30); // フォルダ作成を全体の30%とする
        log(`移行進捗: フォルダ作成中 (${folderCount}/${folders.length + 1})`, 'info', migrationId, folderProgress);
        setStatus({ type: 'info', message: `フォルダ作成中... (${folderCount}/${folders.length + 1})` });
      }

      setStatus({ type: 'info', message: `ファイルを移行中... (0/${files.length})` });
      log(`移行進捗: ファイル移行中 (0/${files.length})`, 'info', migrationId, 30);

      let fileCount = 0;
      /** ファイル1件あたりの処理（DL+UL 含む）が終わったタイミングで全体進捗を更新（開始数ベースだと並列で先に100%になる） */
      const bumpFilePhaseProgress = () => {
        if (files.length === 0) return;
        fileCount++;
        const shouldReport =
          fileCount === 1 ||
          fileCount === files.length ||
          fileCount % MIGRATION_POOL_SIZE === 0;
        if (!shouldReport) return;
        const fp = 30 + Math.round((fileCount / files.length) * 70);
        log(`移行進捗: ファイル移行中 (${fileCount}/${files.length})`, 'info', migrationId, fp);
        setStatus({ type: 'info', message: `ファイルを移行中... (${fileCount}/${files.length})` });
      };

      const processFile = async (file) => {
        const parentPath = file.path_lower.substring(0, file.path_lower.lastIndexOf('/'));
        const gParentId = folderMap[parentPath] || selectedFolderId;
        const fileName = file.name;
        if (fileName.toLowerCase().endsWith('.web')) {
          const gDrivePathSkip = rootFolderName + '/' + (dropboxRelativePathForLog(rootPath, file) || fileName);
          const webSkipLogId = `file-${file.path_lower}`;
          log(`スキップ（.web・Dropbox Web 形式は非対応）: ${gDrivePathSkip}`, 'info', webSkipLogId, 100);
          bumpFilePhaseProgress();
          return;
        }
        const isPaperDocument = fileName.toLowerCase().endsWith('.paper') || file.is_downloadable === false || file.export_info != null;
        const baseFileName = isPaperDocument ? fileName.replace(/\.[^/.]+$/, "") : fileName;

        const existing = await gDriveFileExists(gParentId, baseFileName);
        const fileLogId = `file-${file.path_lower}`;
        if (existing) {
          const gDrivePathSkip = rootFolderName + '/' + (dropboxRelativePathForLog(rootPath, file) || fileName);
          if (isPaperDocument) {
            log(`スキップ（既存・同一）: ${gDrivePathSkip}`, 'info', fileLogId, 100);
            bumpFilePhaseProgress();
            return;
          }
          const dropboxSize = file.size != null ? parseInt(file.size, 10) : null;
          const gDriveSize = existing.size;
          const sameSize = dropboxSize != null && gDriveSize != null && dropboxSize === gDriveSize;
          if (sameSize) {
            log(`スキップ（既存・同一）: ${gDrivePathSkip}`, 'info', fileLogId, 100);
            bumpFilePhaseProgress();
            return;
          }
          const gDrivePathOver = rootFolderName + '/' + (dropboxRelativePathForLog(rootPath, file) || fileName);
          log(`上書き（容量が異なる）: ${gDrivePathOver}`, 'info');
          const deleted = await gDriveDeleteFile(existing.id);
          if (!deleted) {
            const gDrivePathDel = rootFolderName + '/' + (dropboxRelativePathForLog(rootPath, file) || fileName);
            log(`削除失敗のためスキップ: ${gDrivePathDel}`, 'error', fileLogId, 100);
            bumpFilePhaseProgress();
            return;
          }
        }

        const gDrivePathProgress = rootFolderName + '/' + (dropboxRelativePathForLog(rootPath, file) || fileName);
        log(`ファイル移行中: ${gDrivePathProgress}...`, 'info', fileLogId, 0);
        try {
          if (isPaperDocument) {
            const response = await dFetchWithProgressRetry(
              'https://content.dropboxapi.com/2/files/export',
              {
                method: 'POST',
                headers: {
                  ...getApiHeaders(true),
                  'Dropbox-API-Arg': asciiSafeJson({
                    path: file.path_lower,
                    export_format: 'markdown'
                  })
                },
                _logId: fileLogId
              },
              (p) => addLog && addLog({ id: fileLogId, progress: Math.round(p * 0.5) }),
              file.size || 0
            );
            if (response.ok) {
              let markdownText = await response.text();
              let textToSave = cleanMarkdown(markdownText);
              let docxBlob = await generateDocxBlob(baseFileName, textToSave, dbTokenRef.current);

              const metadata = {
                name: baseFileName,
                mimeType: 'application/vnd.google-apps.document',
                parents: gParentId !== 'root' ? [gParentId] : []
              };

              let form = new FormData();
              form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
              form.append('file', docxBlob);

              const uploadRes = await gUpload(
                'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
                form, null, fileLogId, [50, 100], docxBlob.size || 0,
                { metadata: { name: baseFileName, mimeType: 'application/vnd.google-apps.document', parents: gParentId !== 'root' ? [gParentId] : [] }, fileBlob: docxBlob, filename: baseFileName }
              );
              if (uploadRes.ok) {
                try {
                  const upData = await uploadRes.json();
                  if (upData.id) {
                    await convertTaskMarkersToNativeChecklists(upData.id, gDriveTokenRef.current);
                  }
                } catch (e) {
                  console.warn('[GDoc] チェックリスト API 後処理:', e?.message || e);
                }
              }
              const gDrivePath = rootFolderName + '/' + (dropboxRelativePathForLog(rootPath, file) || baseFileName);
              log(`Paper変換完了: ${gDrivePath}`, 'success', fileLogId, 100);
              markdownText = textToSave = docxBlob = form = null;
            } else {
              const gDrivePathFail = rootFolderName + '/' + (dropboxRelativePathForLog(rootPath, file) || baseFileName);
              log(`Paperエクスポート失敗: ${gDrivePathFail}`, 'error', fileLogId, 100);
            }
          } else {
            // direct transfer for regular files
            const fileSize = file.size || 0;
            const useResumable = fileSize > STREAMING_MIGRATION_MIN_BYTES;
            console.log(`[Migration] ${fileName} size=${fileSize} useResumable=${useResumable} (閾値${STREAMING_MIGRATION_MIN_BYTES})`);
            const dropboxOptions = {
              method: 'POST',
              headers: {
                ...getApiHeaders(true),
                'Dropbox-API-Arg': asciiSafeJson({ path: file.path_lower })
              },
              _logId: fileLogId
            };
            const onProgress = (p) => {
              if (!addLog) return;
              const fs = fileSize || 0;
              addLog({
                id: fileLogId,
                progress: Math.round(p * 0.5),
                progress_download: p,
                progress_upload: 0,
                ...transferBytesFields(fs, p, 0),
              });
            };

            if (useResumable) {
              const extMatch = fileName.match(/\.([^.]+)$/);
              const ext = extMatch ? extMatch[1].toLowerCase() : '';
              let mimeType = 'application/octet-stream';
              const mimeTypes = { 'pdf': 'application/pdf', 'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif', 'txt': 'text/plain', 'csv': 'text/csv', 'zip': 'application/zip' };
              if (mimeTypes[ext]) mimeType = mimeTypes[ext];

              const metadata = {
                name: fileName,
                mimeType,
                parents: gParentId !== 'root' ? [gParentId] : []
              };
              const response = await streamUploadFromDropboxToGDrive(
                'https://content.dropboxapi.com/2/files/download',
                dropboxOptions,
                metadata,
                fileSize,
                mimeType,
                fileLogId,
                [50, 100]
              );
              if (response.ok) {
                const gDrivePath = rootFolderName + '/' + (dropboxRelativePathForLog(rootPath, file) || fileName);
                log(`ファイル転送完了（分割送信）: ${gDrivePath}`, 'success', fileLogId, 100);
              } else {
                const gDrivePathFail = rootFolderName + '/' + (dropboxRelativePathForLog(rootPath, file) || fileName);
                log(`ファイル転送失敗: ${gDrivePathFail}`, 'error', fileLogId, 100);
              }
            } else {
              const response = await dFetchWithProgressRetry(
                'https://content.dropboxapi.com/2/files/download',
                dropboxOptions,
                onProgress,
                fileSize
              );
              if (response.ok) {
                let fileBlob = await response.blob();
                const extMatch = fileName.match(/\.([^.]+)$/);
                const ext = extMatch ? extMatch[1].toLowerCase() : '';
                let mimeType = 'application/octet-stream';
                const mimeTypes = { 'pdf': 'application/pdf', 'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif', 'txt': 'text/plain', 'csv': 'text/csv', 'zip': 'application/zip' };
                if (mimeTypes[ext]) mimeType = mimeTypes[ext];
                else if (fileBlob.type) mimeType = fileBlob.type;

                const metadata = {
                  name: fileName,
                  mimeType: mimeType,
                  parents: gParentId !== 'root' ? [gParentId] : []
                };
                let form = new FormData();
                form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
                form.append('file', fileBlob);
                await gUpload(
                  'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
                  form, null, fileLogId, [50, 100], fileBlob.size || file.size || 0,
                  { metadata: { name: fileName, mimeType, parents: gParentId !== 'root' ? [gParentId] : [] }, fileBlob, filename: fileName }
                );
                const gDrivePath = rootFolderName + '/' + (dropboxRelativePathForLog(rootPath, file) || fileName);
                log(`ファイル転送完了: ${gDrivePath}`, 'success', fileLogId, 100);
                fileBlob = form = null;
              } else {
                const gDrivePathFail = rootFolderName + '/' + (dropboxRelativePathForLog(rootPath, file) || fileName);
                log(`ファイルダウンロード失敗: ${gDrivePathFail}`, 'error', fileLogId, 100);
              }
            }
          }
        } catch (fileErr) {
          console.error(`Failed to migrate file ${fileName}:`, fileErr);
          const isMemoryOrFetch = /BLOB_OUT_OF_MEMORY|Failed to fetch|ERR_FAILED/i.test(String(fileErr.message || fileErr));
          const errMsg = isMemoryOrFetch
            ? `メモリ不足の可能性があります（ストレージの空き容量を確認してください）`
            : fileErr.message;
          const gDrivePathErr = rootFolderName + '/' + (dropboxRelativePathForLog(rootPath, file) || fileName);
          log(`ファイル移行エラー: ${gDrivePathErr} - ${errMsg}`, 'error', fileLogId, 100);
        }
        bumpFilePhaseProgress();
      };

      const smallFiles = [];
      const largeFiles = [];
      for (const f of files) {
        const sz = f.size != null ? parseInt(String(f.size), 10) : 0;
        const isWeb = f.name && f.name.toLowerCase().endsWith('.web');
        if (!isWeb && sz > STREAMING_MIGRATION_MIN_BYTES) largeFiles.push(f);
        else smallFiles.push(f);
      }
      await Promise.all([
        asyncPool(MIGRATION_POOL_SIZE, smallFiles, processFile),
        (async () => {
          for (const f of largeFiles) {
            await processFile(f);
          }
        })(),
      ]);

      log(`移行進捗: 移行完了 (${files.length}/${files.length})`, 'success', migrationId, 100);
      log(`✅ 全工程が完了しました: "${rootFolderName}" の移行完了`, 'success');
      notifyMigrationCompleteDesktop(rootFolderName);
      setStatus({ type: 'success', message: `フォルダ "${rootFolderName}" の移行が正常に完了しました` });
      if (fetchGDriveContents) fetchGDriveContents(selectedFolderId);
    } catch (err) {
      console.error('Recursive migration failed:', err);
      log(`致命的なエラーが発生しました: ${err.message}`, 'error');
      setStatus({ type: 'error', message: `移行失敗: ${err.message}` });
    } finally {
      setIsGDriveProcessing(false);
    }
  }, [gDriveTokenRef, dbTokenRef, selectedFolderId, listFolderRecursive, getApiHeaders, asciiSafeJson, setStatus, fetchGDriveContents, dFetch, gFetch, createGDriveFolderSilent, rootNamespaceId, addLog, log]);

  const bulkSaveToGoogleDocs = useCallback(async (selectedFileIds, folderFiles) => {
    if (selectedFileIds.length === 0 || !gDriveTokenRef.current) return;

    const bulkId = `bulk-${Date.now()}`;
    setIsGDriveProcessing(true);
    setStatus({ type: 'info', message: `${selectedFileIds.length} 個のファイルを一括変換中...` });
    log(`${selectedFileIds.length} 個のファイルを一括変換中...`, 'info', bulkId, 0);

    let successCount = 0;
    const savedBaseNames = new Set();
    try {
      let processedCount = 0;

      const processBulkFile = async (path) => {
        const file = folderFiles.find(f => f.path_lower === path);
        if (!file) return;
        const fileName = file.name;
        const isPaperDocument = fileName.toLowerCase().endsWith('.paper') || file.is_downloadable === false || file.export_info != null;

        try {
          if (isPaperDocument) {
            const baseFileName = fileName.replace(/\.[^/.]+$/, "");
            if (savedBaseNames.has(baseFileName)) {
              const basePath = gDriveBrowserPath?.length > 0 ? gDriveBrowserPath.map(p => p.name === 'Home' ? 'マイドライブ' : p.name).join('/') : (selectedFolderId === 'root' ? 'マイドライブ' : 'フォルダ');
              log(`スキップ（同一名）: ${basePath}/${baseFileName}`, 'info');
              processedCount++;
              const progress = Math.round((processedCount / selectedFileIds.length) * 100);
              log(`一括変換進捗: ${processedCount}/${selectedFileIds.length} 完了`, 'info', bulkId, progress);
              return;
            }
            const existing = await gDriveFileExists(selectedFolderId, baseFileName);
            if (existing) {
              const basePath = gDriveBrowserPath?.length > 0 ? gDriveBrowserPath.map(p => p.name === 'Home' ? 'マイドライブ' : p.name).join('/') : (selectedFolderId === 'root' ? 'マイドライブ' : 'フォルダ');
              log(`スキップ（既存・同一）: ${basePath}/${baseFileName}`, 'info');
              processedCount++;
              const progress = Math.round((processedCount / selectedFileIds.length) * 100);
              log(`一括変換進捗: ${processedCount}/${selectedFileIds.length} 完了`, 'info', bulkId, progress);
              return;
            }
            savedBaseNames.add(baseFileName);
            const response = await dFetch('https://content.dropboxapi.com/2/files/export', {
              method: 'POST',
              headers: {
                ...getApiHeaders(true),
                'Dropbox-API-Arg': asciiSafeJson({
                  path: path,
                  export_format: 'markdown'
                })
              }
            });
            if (!response.ok) throw new Error('エクスポート失敗');

            let markdownText = await response.text();
            let textToSave = cleanMarkdown(markdownText);
            await saveToGoogleDocs(textToSave, baseFileName);
            successCount++;
            markdownText = textToSave = null;
          } else {
            if (fileName.toLowerCase().endsWith('.web')) {
              const basePath = gDriveBrowserPath?.length > 0 ? gDriveBrowserPath.map(p => p.name === 'Home' ? 'マイドライブ' : p.name).join('/') : (selectedFolderId === 'root' ? 'マイドライブ' : 'フォルダ');
              log(`スキップ（.web非対応）: ${basePath}/${fileName}`, 'info');
            } else {
              const success = await transferRawFileToGDrive(path, fileName);
              if (success) successCount++;
            }
          }
        } catch (err) {
          console.error(`Error processing ${fileName}:`, err);
          const basePath = gDriveBrowserPath?.length > 0 ? gDriveBrowserPath.map(p => p.name === 'Home' ? 'マイドライブ' : p.name).join('/') : (selectedFolderId === 'root' ? 'マイドライブ' : 'フォルダ');
          const targetName = isPaperDocument ? fileName.replace(/\.[^/.]+$/, '') : fileName;
          log(`変換失敗: ${basePath}/${targetName}`, 'error');
        }

        processedCount++;
        const progress = Math.round((processedCount / selectedFileIds.length) * 100);
        log(`一括変換進捗: ${processedCount}/${selectedFileIds.length} 完了`, 'info', bulkId, progress);
      };

      const smallIds = [];
      const largeIds = [];
      for (const path of selectedFileIds) {
        const file = folderFiles.find((ff) => ff.path_lower === path);
        const sz = file && file.size != null ? parseInt(String(file.size), 10) : 0;
        const isWeb = file?.name && file.name.toLowerCase().endsWith('.web');
        if (file && !isWeb && sz > STREAMING_MIGRATION_MIN_BYTES) largeIds.push(path);
        else smallIds.push(path);
      }
      await Promise.all([
        asyncPool(MIGRATION_POOL_SIZE, smallIds, processBulkFile),
        (async () => {
          for (const path of largeIds) {
            await processBulkFile(path);
          }
        })(),
      ]);
      setStatus({ type: 'success', message: `${successCount} 個のファイルの変換と保存が完了しました。` });
      log(`一括変換完了: ${successCount}/${selectedFileIds.length} 成功`, 'success', bulkId, 100);
      log(`✅ 一括変換完了: ${successCount}/${selectedFileIds.length} 成功`, 'success');
      if (fetchGDriveContents) fetchGDriveContents(selectedFolderId);
    } catch (err) {
      setStatus({ type: 'error', message: `一括変換中にエラーが発生しました: ${err.message}` });
    } finally {
      setIsGDriveProcessing(false);
    }
  }, [gDriveTokenRef, selectedFolderId, gDriveBrowserPath, getApiHeaders, asciiSafeJson, setStatus, fetchGDriveContents, dbTokenRef, dFetch, saveToGoogleDocs, transferRawFileToGDrive, gDriveFileExists]);

  const downloadFile = useCallback(async (type, content, currentFileName) => {
    if (!content) return;
    try {
      const blobToBase64 = (blob) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const dataUrl = reader.result;
            const i = typeof dataUrl === 'string' ? dataUrl.indexOf(',') : -1;
            resolve(i >= 0 ? dataUrl.slice(i + 1) : '');
          };
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });

      if (type === 'docx') {
        const blob = await generateDocxBlob(currentFileName, content, dbTokenRef.current);
        const api = typeof window !== 'undefined' && window.pywebview?.api;
        if (api && typeof api.save_download === 'function') {
          const b64 = await blobToBase64(blob);
          const ok = await api.save_download(`${currentFileName}.docx`, b64);
          if (!ok) return;
        } else {
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${currentFileName}.docx`;
          a.click();
          window.URL.revokeObjectURL(url);
        }
      } else {
        const blob = new Blob([content], { type: 'text/markdown' });
        const api = typeof window !== 'undefined' && window.pywebview?.api;
        if (api && typeof api.save_download === 'function') {
          const b64 = await blobToBase64(blob);
          const ok = await api.save_download(`${currentFileName}.md`, b64);
          if (!ok) return;
        } else {
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${currentFileName}.md`;
          a.click();
          window.URL.revokeObjectURL(url);
        }
      }
    } catch (err) {
      setStatus({ type: 'error', message: `ダウンロード失敗: ${err.message}` });
    }
  }, [dbTokenRef, setStatus]);

  return {
    isGDriveProcessing,
    exportingId,
    fetchAndExport,
    saveToGoogleDocs,
    bulkSaveToGoogleDocs,
    migrateFolderRecursively,
    downloadFile
  };
};
