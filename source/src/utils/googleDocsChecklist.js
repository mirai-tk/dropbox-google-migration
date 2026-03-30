/**
 * DOCX→GDoc 変換後、段落先頭の ☐ / ☑ マーカーを削除し、
 * Google Docs API のネイティブチェックリスト（BULLET_CHECKBOX）に置き換える。
 *
 * ☑ 行は API が箇条書きの「チェック済み」状態を設定できないため、ラベルに取り消し線を付けて完了を表す。
 *
 * @see https://developers.google.com/docs/api/how-tos/lists
 */

const UNCHECKED = '\u2610'; // BALLOT BOX（docx 側の未チェックマーカー）
const CHECKED = '\u2611'; // BALLOT BOX WITH CHECK（docx 側のチェック済みマーカー）

/** GCP で Google Docs API が無効なとき、全ファイルで同じ 403 が繰り返されるのを防ぐ */
let docsApiServiceDisabled = false;

function isDocsApiServiceDisabled(status, bodyText) {
  if (status !== 403 || !bodyText) return false;
  try {
    const data = JSON.parse(bodyText);
    const err = data.error || {};
    const details = err.details || [];
    for (const d of details) {
      if (d.reason === 'SERVICE_DISABLED') return true;
    }
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('docs.googleapis.com') && msg.includes('disabled')) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function walkStructuralElements(elements, out) {
  if (!elements) return;
  for (const el of elements) {
    if (el.paragraph) out.push(el);
    if (el.table) {
      for (const row of el.table.tableRows || []) {
        for (const cell of row.tableCells || []) {
          walkStructuralElements(cell.content, out);
        }
      }
    }
  }
}

function paragraphPlainText(paragraph) {
  return (paragraph.elements || []).map((e) => e.textRun?.content || '').join('');
}

/** Google Docs のインデックスは UTF-16 コードユニット。連結テキスト（textRun のみ）のオフセットを絶対 startIndex に変換 */
function mapUtf16OffsetToDocumentIndex(paragraph, utf16Offset) {
  let u = 0;
  for (const el of paragraph.elements || []) {
    const tr = el.textRun;
    if (!tr?.content) continue;
    const content = tr.content;
    if (utf16Offset < u + content.length) {
      return el.startIndex + (utf16Offset - u);
    }
    u += content.length;
  }
  return null;
}

/** ☐ の直後に続く区切り（通常スペース・NBSP・改行・タブ・薄スペース・和字間隔など） */
function isSpaceAfterCheckbox(ch) {
  return /[ \n\r\t\u00a0\u2009\u3000]/.test(ch);
}

/**
 * @param {string} documentId
 * @param {string} accessToken
 * @returns {Promise<boolean>} 成功したら true
 */
export async function convertTaskMarkersToNativeChecklists(documentId, accessToken) {
  if (!documentId || !accessToken) return false;
  if (docsApiServiceDisabled) return false;

  const getRes = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const getBody = await getRes.text();
  if (!getRes.ok) {
    if (isDocsApiServiceDisabled(getRes.status, getBody)) {
      if (!docsApiServiceDisabled) {
        docsApiServiceDisabled = true;
        console.warn(
          '[GDoc] Google Docs API が GCP で無効です（チェックリストのネイティブ化をスキップ）。' +
            ' 有効化: https://console.developers.google.com/apis/library/docs.googleapis.com'
        );
      }
      return false;
    }
    console.warn('[GDoc] documents.get failed', getRes.status, getBody);
    return false;
  }

  const doc = JSON.parse(getBody);
  const structural = [];
  walkStructuralElements(doc.body?.content, structural);

  /** @type {{ firstIdx: number, seEnd: number, deleteLen: number }[]} */
  const candidates = [];
  /** 変換前の段落インデックス（structural 内）— ☑ 行は後段で取り消し線 */
  const checkedParagraphIndices = [];

  for (let j = 0; j < structural.length; j++) {
    const se = structural[j];
    const p = se.paragraph;
    if (!p?.elements?.length) continue;
    const text = paragraphPlainText(p);
    // インデントが別 TextRun（タブ等）のとき elements[0] は ☐ を含まない → 連結テキスト上で位置を解決
    const leadMatch = text.match(/^[\t \u00a0\u2009\u3000]*/);
    const leadLen = leadMatch ? leadMatch[0].length : 0;
    const afterLead = text.slice(leadLen);
    let marker = null;
    if (afterLead.startsWith(UNCHECKED)) marker = UNCHECKED;
    else if (afterLead.startsWith(CHECKED)) marker = CHECKED;
    else continue;
    const afterBox = afterLead.slice(marker.length);
    if (afterBox.length === 0) continue;
    if (!isSpaceAfterCheckbox(afterBox[0])) continue;

    const deleteLen = 2; // マーカー + 直後1文字（BMP 想定）
    const deleteStart = mapUtf16OffsetToDocumentIndex(p, leadLen);
    if (deleteStart == null || se.endIndex == null) continue;
    if (se.endIndex - deleteStart <= deleteLen) continue;

    candidates.push({ firstIdx: deleteStart, seEnd: se.endIndex, deleteLen });
    if (marker === CHECKED) checkedParagraphIndices.push(j);
  }

  if (candidates.length === 0) return true;

  candidates.sort((a, b) => b.firstIdx - a.firstIdx);

  const requests = [];
  for (const c of candidates) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: c.firstIdx, endIndex: c.firstIdx + c.deleteLen },
      },
    });
    requests.push({
      createParagraphBullets: {
        range: { startIndex: c.firstIdx, endIndex: c.seEnd - c.deleteLen },
        bulletPreset: 'BULLET_CHECKBOX',
      },
    });
  }

  const batchRes = await fetch(
    `https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requests }),
    }
  );

  const batchBody = await batchRes.text();
  if (!batchRes.ok) {
    if (isDocsApiServiceDisabled(batchRes.status, batchBody)) {
      if (!docsApiServiceDisabled) {
        docsApiServiceDisabled = true;
        console.warn(
          '[GDoc] Google Docs API が GCP で無効です（チェックリストのネイティブ化をスキップ）。' +
            ' 有効化: https://console.developers.google.com/apis/library/docs.googleapis.com'
        );
      }
      return false;
    }
    console.warn('[GDoc] batchUpdate failed', batchRes.status, batchBody);
    return false;
  }

  // ☑ 行: ネイティブの「チェック済み」状態は API 未対応のため、ラベルに取り消し線を付ける
  if (checkedParagraphIndices.length === 0) return true;

  const get2 = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const get2Body = await get2.text();
  if (!get2.ok) {
    console.warn('[GDoc] documents.get (after checklist) failed', get2.status, get2Body);
    return true;
  }
  const doc2 = JSON.parse(get2Body);
  const structural2 = [];
  walkStructuralElements(doc2.body?.content, structural2);
  if (structural2.length !== structural.length) {
    console.warn('[GDoc] paragraph count changed after checklist batch; skip strikethrough');
    return true;
  }

  const strikeRequests = [];
  for (const idx of checkedParagraphIndices) {
    const se = structural2[idx];
    const p = se?.paragraph;
    const els = p?.elements;
    if (!els?.length) continue;
    const startIdx = els[0].startIndex;
    const endIdx = els[els.length - 1].endIndex;
    if (startIdx == null || endIdx == null || endIdx <= startIdx) continue;
    strikeRequests.push({
      updateTextStyle: {
        range: { startIndex: startIdx, endIndex: endIdx },
        textStyle: { strikethrough: true },
        fields: 'strikethrough',
      },
    });
  }
  if (strikeRequests.length === 0) return true;

  const strikeRes = await fetch(
    `https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requests: strikeRequests }),
    }
  );
  if (!strikeRes.ok) {
    const err = await strikeRes.text();
    console.warn('[GDoc] batchUpdate (strikethrough for checked tasks) failed', strikeRes.status, err);
  }
  return true;
}

export { UNCHECKED, CHECKED };
