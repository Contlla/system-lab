const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const { requirePermission } = require('../middlewares/permissionsMiddleware');
const service = require('../services/estadisticas.service');

const router = express.Router();

function handleError(res, err) {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Error al cargar estadisticas' });
}

router.get('/api/estadisticas/resumen', authMiddleware, requirePermission('dashboard.view'), async (req, res) => {
  try {
    const range = service.resolveRange(req.query);
    const resumen = await service.getResumen(range);
    res.json({ range, resumen });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/api/estadisticas/estudios', authMiddleware, requirePermission('dashboard.view'), async (req, res) => {
  try {
    const range = service.resolveRange(req.query);
    const estudios = await service.getEstudios(range, req.query.limit);
    res.json({ range, estudios });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/api/estadisticas/ventas-dia', authMiddleware, requirePermission('dashboard.view'), async (req, res) => {
  try {
    const range = service.resolveRange(req.query);
    const ventasDia = await service.getVentasDia(range);
    res.json({ range, ventasDia });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/api/estadisticas/categorias', authMiddleware, requirePermission('dashboard.view'), async (req, res) => {
  try {
    const range = service.resolveRange(req.query);
    const categorias = await service.getCategorias(range);
    res.json({ range, categorias });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/api/estadisticas/sucursales', authMiddleware, requirePermission('dashboard.view'), async (_req, res) => {
  try {
    const rows = await service.getSucursales();
    res.json(rows.map((row) => row.sucursal));
  } catch (err) {
    handleError(res, err);
  }
});

module.exports = router;
