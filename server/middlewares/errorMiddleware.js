function normalizeStatus(err) {
  const status = Number(err?.status || err?.statusCode || 500);
  return status >= 400 && status <= 599 ? status : 500;
}

function errorMiddleware(err, _req, res, next) {
  const status = normalizeStatus(err);
  const message = status < 500
    ? (err.message || 'Solicitud invalida')
    : 'Error interno del servidor';

  if (status >= 500) {
    console.error(err);
  }

  if (res.headersSent) return next(err);

  res.status(status).json({ error: message });
}

module.exports = { errorMiddleware };
