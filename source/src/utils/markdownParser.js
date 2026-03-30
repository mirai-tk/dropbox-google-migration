import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle, ImageRun, ExternalHyperlink } from 'docx';
import { marked } from 'marked';

/**
 * Dropbox Paper特有の冗長な Markdown 記号をクリーニングし、構造を補正する
 */
export const cleanMarkdown = (markdown) => {
  if (!markdown) return '';

  // 1. 基本的なクリーンアップ
  let processed = markdown
    .replace(/\*{4,}/g, '')
    .replace(/\*\*(\s*)\*\*/g, '$1');

  // 2. リストの継続性修正 (List Healing)
  const lines = processed.split('\n');
  const resultLines = [];
  let currentListIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s/);
    const isImage = trimmed.match(/^!\[.*\]\(.*\)$/);

    if (listMatch) {
      currentListIndent = listMatch[1].length;
      resultLines.push(line);
    } else if (isImage && currentListIndent >= 0) {
      resultLines.push(' '.repeat(currentListIndent + 4) + trimmed);
    } else if (trimmed !== '' && !line.startsWith(' ') && !line.startsWith('\t')) {
      currentListIndent = -1;
      resultLines.push(line);
    } else {
      resultLines.push(line);
    }
  }
  processed = resultLines.join('\n');

  // 3. テーブルの補正 (表の直前に空行がないと表として認識されないため、空行を強制挿入する)
  processed = processed.replace(/([^\n|])\n\|/g, '$1\n\n|');

  // 4. Dropbox Paperのチェックリスト対応
  processed = processed.replace(/^\|\s*([^|]+)\s*\|$/gm, (match, content) => {
    if (content.match(/\[[ xX]\]/)) {
      let multiLine = content.replace(/<br>\s*(?:-\s*)?(\[[ xX]\])/g, '\n- $1');
      multiLine = multiLine.replace(/<br>/g, '\n');
      return multiLine;
    }
    return match;
  });

  return processed;
};

/**
 * HTML生成ロジック (構造保護 + プロフェッショナル仕様)
 */
export const generateHtmlContent = (title, markdown) => {
  const cleanedMarkdown = cleanMarkdown(markdown);

  // ライブラリの標準パースのみ実行
  let htmlBody = marked.parse(cleanedMarkdown, { gfm: true, breaks: true });

  // 画像の巨大化対策
  htmlBody = htmlBody.replace(/<img\b([^>]*)>/gi, '<img $1 width="650" style="max-width: 100%; height: auto; border-radius: 8px;">');

  // 巨大テーブル対策 (tableタグを個別で包む)
  htmlBody = htmlBody.replace(/<table(?=[ >])/gi, '<div class="table-wrapper"><table');
  htmlBody = htmlBody.replace(/<\/table>/gi, '</table></div>');

  return `
    <html>
    <head>
      <meta charset='utf-8'>
      <title>${title}</title>
      <style>
        /* レイアウトと可読性の設定 (フォントサイズはドキュメント標準) */
        body {
          font-family: 'Hiragino Kaku Gothic ProN', 'Meiryo', sans-serif;
          line-height: 1.8;
          padding: 40px 20px;
          max-width: 850px;
          margin: 0 auto;
          color: #333;
        }

        /* 改行の空間を確保 */
        h1, h2, h3, p, ul, ol, blockquote, pre { margin-top: 0; margin-bottom: 1.2em; }

        /* 見出しデザイン (サイズはデフォルト) */
        h1 { color: #1a73e8; border-bottom: 2px solid #1a73e8; padding-bottom: 10px; }
        h2 { color: #202124; border-left: 6px solid #1a73e8; padding-left: 15px; }
        h3 { color: #5f6368; }

        /* 巨大テーブル対策 (横スクロール + ヘッダー崩れ防止) */
        .table-wrapper { overflow-x: auto; max-width: 100%; margin: 20px 0; border: 1px solid #dfe1e5; }
        table { border-collapse: collapse; width: 100%; min-width: 600px; table-layout: auto; margin-bottom: 0; border: none; }
        th, td { border: 1px solid #dfe1e5; padding: 12px; text-align: left; min-width: 100px; }
        th { background-color: #f8f9fa; font-weight: bold; white-space: nowrap; }

        /* その他 */
        blockquote { border-left: 4px solid #dfe1e5; padding-left: 16px; color: #5f6368; font-style: italic; }
        pre { background-color: #f8f9fa; padding: 16px; border-radius: 8px; border: 1px solid #dfe1e5; overflow-x: auto; }
        code { background-color: #f1f3f4; padding: 2px 4px; border-radius: 4px; font-family: monospace; }
        a { color: #1a73e8; text-decoration: underline; }
        input[type="checkbox"] { margin-right: 8px; vertical-align: middle; }
      </style>
    </head>
    <body>
      ${htmlBody}
    </body>
    </html>
  `;
};

/**
 * Word (.docx) 生成ロジック
 */
export const generateDocxBlob = async (title, markdown, dbToken = null) => {
  const cleanedMarkdown = cleanMarkdown(markdown);
  const lines = cleanedMarkdown.split('\n');
  const children = [];



  const parseInline = (text) => {
    const parts = [];
    // リンク: [alt](url)
    // 太字: **text** または __text__ (単語境界等を考慮して中身の_を誤爆させない)
    // 斜体: *text* または _text_ (単語境界 \b や \B を用いて、2021_2_2 のような文字間アンダーバーを無視する)
    const regex = /\[([^\]]+)\]\(([^)]+)\)|(\*\*|__)(?!\s)(.*?)(?!\s)\3|(?:\b|_)\*(?!\s)(.*?)(?!\s)\*(?:\b|_)|(?:\b|_)_(?!\s)(.*?)(?!\s)_(?:\b|_)/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(new TextRun(text.substring(lastIndex, match.index)));
      }

      if (match[1] && match[2]) {
        // Link
        parts.push(
          new ExternalHyperlink({
            children: [
              new TextRun({
                text: match[1],
                color: '1a73e8',
                underline: { type: 'single' },
              }),
            ],
            link: match[2],
          })
        );
      } else if (match[3] && match[4]) {
        // Bold: match[3] is ** or __, match[4] is the text
        parts.push(new TextRun({ text: match[4], bold: true }));
      } else if (match[5]) {
        // Italic with *: match[5] is the text
        parts.push(new TextRun({ text: match[5], italics: true }));
      } else if (match[6]) {
        // Italic with _: match[6] is the text
        parts.push(new TextRun({ text: match[6], italics: true }));
      }
      lastIndex = regex.lastIndex;
    }

    if (lastIndex < text.length) {
      parts.push(new TextRun(text.substring(lastIndex)));
    }

    return parts.length > 0 ? parts : [new TextRun(text)];
  };

  let tableRowsBuffer = [];
  let inTable = false;

  // docx の w:sz は 1/8 pt。1 だと ~0.125pt で GDoc 取り込み後ほぼ見えないため 8〜12 程度にする
  const TABLE_BORDER = { style: BorderStyle.SINGLE, size: 12, color: 'DFE1E5' };
  const TABLE_HEADER_FILL = 'E8F0FE';

  const flushTableDocx = () => {
    if (tableRowsBuffer.length < 2) {
      tableRowsBuffer.forEach(row => {
        children.push(new Paragraph({ children: parseInline(row) }));
      });
    } else {
      const tableRows = [];
      const parsedRows = tableRowsBuffer
        .filter(row => !row.trim().match(/^\|?\s*[:\-]+\s*(\|\s*[:\-]+\s*)*\|?$/))
        .map(row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|'));

      if (parsedRows.length > 0) {
        const expectedCols = parsedRows[0].length;
        parsedRows.forEach((cells, idx) => {
          let normalizedCells = [...cells];
          while (normalizedCells.length < expectedCols) normalizedCells.push("");
          if (normalizedCells.length > expectedCols) normalizedCells = normalizedCells.slice(0, expectedCols);

          const isHeaderRow = idx === 0;
          const tableCells = normalizedCells.map(cell => {
            return new TableCell({
              children: [
                new Paragraph({
                  children: parseInline(cell.trim()),
                  ...(isHeaderRow ? { run: { bold: true } } : {}),
                }),
              ],
              shading: isHeaderRow ? { fill: TABLE_HEADER_FILL, color: '000000' } : undefined,
              borders: {
                top: TABLE_BORDER,
                bottom: TABLE_BORDER,
                left: TABLE_BORDER,
                right: TABLE_BORDER,
              },
              verticalAlign: 'center',
              margins: { top: 100, bottom: 100, left: 120, right: 120 },
            });
          });
          tableRows.push(new TableRow({ children: tableCells }));
        });
      }

      if (tableRows.length > 0) {
        children.push(
          new Table({
            rows: tableRows,
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: {
              top: TABLE_BORDER,
              bottom: TABLE_BORDER,
              left: TABLE_BORDER,
              right: TABLE_BORDER,
              insideHorizontal: TABLE_BORDER,
              insideVertical: TABLE_BORDER,
            },
          })
        );
      }
    }
    tableRowsBuffer = [];
    inTable = false;
  };

  for (const line of lines) {
    const isTableLine = line.trim().startsWith('|');
    if (isTableLine) {
      inTable = true;
      tableRowsBuffer.push(line);
    } else {
      if (inTable) flushTableDocx();
      const trimmedLine = line.trim();
      if (!trimmedLine) {
        children.push(new Paragraph({ text: "" }));
        continue;
      }
      const imgMatch = trimmedLine.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (imgMatch) {
        try {
          const imgUrl = imgMatch[2];
          const isDropboxPaperImage = imgUrl.includes('paper-attachments.dropbox.com') || imgUrl.includes('paper-attachments.dropboxusercontent.com');
          const proxyUrl = isDropboxPaperImage
            ? imgUrl.replace(/^https:\/\/paper-attachments\.dropbox(?:usercontent)?\.com/, '/proxy/dropbox-image')
            : `/api/proxy-image?url=${encodeURIComponent(imgUrl)}`;

          const fetchOptions = (isDropboxPaperImage && dbToken)
            ? { headers: { 'Authorization': `Bearer ${dbToken}` } }
            : {};
          const response = await fetch(proxyUrl, fetchOptions);
          if (response.ok) {
            const buffer = await response.arrayBuffer();
            children.push(new Paragraph({
              children: [
                new ImageRun({
                  data: buffer,
                  transformation: { width: 500, height: 300 },
                }),
              ],
              alignment: "center",
              spacing: { before: 200, after: 200 }
            }));
            continue;
          }
        } catch (err) {
          console.error('Failed to fetch image for docx:', err);
          children.push(new Paragraph({ text: `[画像取得失敗: ${imgMatch[2]}]`, spacing: { before: 120, after: 120 } }));
          continue;
        }
      }

      if (line.startsWith('# ')) {
        children.push(new Paragraph({
          children: parseInline(line.replace('# ', '')),
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 400, after: 200 }
        }));
      } else if (line.startsWith('## ')) {
        children.push(new Paragraph({
          children: parseInline(line.replace('## ', '')),
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 300, after: 150 }
        }));
      } else if (line.startsWith('### ')) {
        children.push(new Paragraph({
          children: parseInline(line.replace('### ', '')),
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 200, after: 100 }
        }));
      } else if (line.trim().match(/^-{3,}$/)) {
        children.push(new Paragraph({
          thematicBreak: true
        }));
      } else if (/^\s*(?:[-*+]\s+|\d+\.\s+)?\[\s*([xX]?)\s*\]\s*(.*)$/.test(line)) {
        // GFM タスク: - [ ] / * [x] / 1. [ ] 等。括弧内は空=未チェック、x/X=チェック済み
        // ☐/☑ はアップロード後に googleDocsChecklist.js が Docs API でネイティブ化（☑ は API 制約で取り消し線）。
        const checkMatch = line.match(/^\s*(?:[-*+]\s+|\d+\.\s+)?\[\s*([xX]?)\s*\]\s*(.*)$/);
        const checked = (checkMatch[1] || '').toLowerCase() === 'x';
        const label = checkMatch[2] ?? '';
        const indentMatch = line.match(/^(\s*)/);
        const indentLevel = Math.floor(indentMatch[1].length / 4);
        const glyph = checked ? '\u2611 ' : '\u2610 ';
        children.push(new Paragraph({
          children: [new TextRun({ text: glyph }), ...parseInline(label)],
          indent: indentLevel > 0 ? { left: indentLevel * 720 } : undefined,
          spacing: { before: 60, after: 60 }
        }));
      } else if (line.match(/^\s*[-*] /)) {
        const indentMatch = line.match(/^(\s*)/);
        const indentLevel = Math.floor(indentMatch[1].length / 4);
        children.push(new Paragraph({
          children: parseInline(line.replace(/^\s*[-*] /, '')),
          bullet: { level: indentLevel }
        }));
      } else {
        children.push(new Paragraph({
          children: parseInline(line),
          spacing: { before: 120, after: 120 }
        }));
      }
    }
  }

  if (inTable) flushTableDocx();

  const doc = new Document({
    sections: [{ children: children }],
  });

  return await Packer.toBlob(doc);
};
