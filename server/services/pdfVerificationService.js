const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const VICA_GREEN = rgb(0.447, 0.722, 0.267);
const VICA_BLUE = rgb(0.082, 0.596, 0.812);
const DARK = rgb(0.082, 0.212, 0.29);
const MUTED = rgb(0.36, 0.45, 0.49);

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

  drawCenteredText(page, 'VICA', height - 136, fontBold, 58, VICA_GREEN);
  drawCenteredText(page, 'Laboratorio', height - 160, font, 18, VICA_BLUE);
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
