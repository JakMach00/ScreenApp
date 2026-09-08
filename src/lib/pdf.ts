import { jsPDF } from 'jspdf';
import type { Shot } from '../types';
import { loadImage } from './capture';

const MARGIN = 36; // points

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(blob);
  });
}

async function toJpeg(blob: Blob, quality: number): Promise<string> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D context available.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface PdfOptions {
  title: string;
  /** Re-encode screenshots as JPEG to keep the PDF small. */
  compress: boolean;
}

export async function buildPdf(shots: Shot[], options: PdfOptions): Promise<Uint8Array> {
  // Screenshots only. Recordings are exported as their own files, and the
  // pages carry no headers or timestamps so the document is just the images.
  const pages = shots.filter((s) => s.kind === 'image');

  if (pages.length === 0) throw new Error('There are no screenshots to put in the PDF.');

  const firstLandscape = pages[0].width >= pages[0].height;
  const doc = new jsPDF({
    unit: 'pt',
    format: 'a4',
    orientation: firstLandscape ? 'landscape' : 'portrait',
    compress: true,
  });

  for (let i = 0; i < pages.length; i += 1) {
    const shot = pages[i];
    const landscape = shot.width >= shot.height;
    if (i > 0) doc.addPage('a4', landscape ? 'landscape' : 'portrait');

    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const availW = pageW - MARGIN * 2;
    const availH = pageH - MARGIN * 2;

    const dataUrl = options.compress
      ? await toJpeg(shot.blob, 0.85)
      : await blobToDataUrl(shot.blob);
    const format = dataUrl.startsWith('data:image/png') ? 'PNG' : 'JPEG';

    const ratio = Math.min(availW / shot.width, availH / shot.height);
    const drawW = shot.width * ratio;
    const drawH = shot.height * ratio;
    const x = MARGIN + (availW - drawW) / 2;
    const y = MARGIN + (availH - drawH) / 2;

    doc.addImage(dataUrl, format, x, y, drawW, drawH, undefined, 'FAST');
  }

  doc.setProperties({ title: options.title, creator: 'ScreenApp' });
  const buffer = doc.output('arraybuffer');
  return new Uint8Array(buffer);
}
