const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const VICA_GREEN = rgb(0.447, 0.722, 0.267);
const VICA_BLUE = rgb(0.082, 0.596, 0.812);
const DARK = rgb(0.082, 0.212, 0.29);
const MUTED = rgb(0.36, 0.45, 0.49);
const VICA_LOGO_PATH = path.join(__dirname, '..', 'assets', 'vica-logo.svg');

let cachedLogoPaths = null;

function qrDataUrlToPngBuffer(qrDataUrl) {
  const match = String(qrDataUrl || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    const error = new Error('No se pudo generar el QR de verificacion');
    error.status = 500;
    throw error;
  }
  return Buffer.from(match[1], 'base64');
}

function drawCenteredText(page, text, y, font, size, color) {
  const width = page.getWidth();
  const textWidth = font.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: Math.max(32, (width - textWidth) / 2),
    y,
    size,
    font,
    color,
  });
}

function hexToRgb(hexColor) {
  const match = String(hexColor || '').trim().match(/^#([0-9a-f]{6})$/i);
  if (!match) return null;

  const value = match[1];
  return rgb(
    parseInt(value.slice(0, 2), 16) / 255,
    parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255
  );
}

function getVicaLogoPaths() {
  if (cachedLogoPaths) return cachedLogoPaths;

  const svg = fs.readFileSync(VICA_LOGO_PATH, 'utf8');
  const styles = new Map();

  for (const styleMatch of svg.matchAll(/\.([\w-]+)\s*\{[^}]*fill:\s*(#[0-9a-f]{6})\s*;?[^}]*\}/gi)) {
    styles.set(styleMatch[1], hexToRgb(styleMatch[2]));
  }

  cachedLogoPaths = [...svg.matchAll(/<path\b([^>]*)>/gi)]
    .map(([, attributes]) => {
      const d = attributes.match(/\bd="([^"]+)"/i)?.[1];
      const className = attributes.match(/\bclass="([^"]+)"/i)?.[1];
      const fill = attributes.match(/\bfill="([^"]+)"/i)?.[1];
      const color = hexToRgb(fill) || styles.get(className) || VICA_BLUE;
      return d ? { d, color } : null;
    })
    .filter(Boolean);

  return cachedLogoPaths;
}

function drawVicaLogo(page, { x, y, scale }) {
  for (const logoPath of getVicaLogoPaths()) {
    page.drawSvgPath(logoPath.d, {
      x,
      y,
      scale,
      color: logoPath.color,
    });
  }
}

async function agregarPaginaVerificacionPdf(pdfBuffer, {
  qrBase64,
  viewerUrl,
  uuid,
  folio = '',
  paciente = '',
  estudio = '',
  telefono = '+52 1 55 7465 8297',
}) {
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: false });
  const qrImage = await pdfDoc.embedPng(qrDataUrlToPngBuffer(qrBase64));
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const page = pdfDoc.addPage([612, 792]);
  const width = page.getWidth();
  const height = page.getHeight();

  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(0.957, 0.98, 0.961) });
  page.drawRectangle({ x: 44, y: 52, width: width - 88, height: height - 104, color: rgb(1, 1, 1), borderColor: rgb(0.847, 0.918, 0.816), borderWidth: 1.5 });

  const logoScale = 1.45;
  const logoWidth = 163.99 * logoScale;
  drawVicaLogo(page, {
    x: (width - logoWidth) / 2,
    y: height - 98,
    scale: logoScale,
  });

  drawCenteredText(page, 'Verificacion digital de resultado', height - 220, fontBold, 22, DARK);
  drawCenteredText(page, 'Escanea el codigo QR para consultar la copia digital del resultado.', height - 248, font, 11, MUTED);

  const qrSize = 190;
  page.drawImage(qrImage, {
    x: (width - qrSize) / 2,
    y: height - 475,
    width: qrSize,
    height: qrSize,
  });

  const left = 104;
  let y = height - 525;
  const rows = [
    ['Folio', folio || 'No especificado'],
    ['Paciente', paciente || 'No especificado'],
    ['Estudio', estudio || 'Resultado de orden'],
    ['ID de verificacion', uuid],
    ['Contacto', telefono],
  ];

  for (const [label, value] of rows) {
    page.drawText(`${label}:`, { x: left, y, size: 10, font: fontBold, color: DARK });
    page.drawText(String(value || '').slice(0, 110), { x: left + 118, y, size: 10, font, color: MUTED });
    y -= 22;
  }

  page.drawText('Aviso de confidencialidad', { x: left, y: 158, size: 10, font: fontBold, color: DARK });
  page.drawText('Este documento contiene informacion de salud y es confidencial. Su uso esta limitado', { x: left, y: 139, size: 9, font, color: MUTED });
  page.drawText('al paciente, medico tratante o personal autorizado. Si recibiste este resultado por error,', { x: left, y: 125, size: 9, font, color: MUTED });
  page.drawText('no lo compartas y contacta al laboratorio.', { x: left, y: 111, size: 9, font, color: MUTED });

  page.drawText(String(viewerUrl || '').slice(0, 120), { x: left, y: 82, size: 8, font, color: VICA_BLUE });

  return Buffer.from(await pdfDoc.save());
}

module.exports = {
  agregarPaginaVerificacionPdf,
};
