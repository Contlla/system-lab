const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const { requirePermission } = require('../middlewares/permissionsMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const service = require('../services/estadisticas.service');

const router = express.Router();

router.get('/api/estadisticas/resumen', authMiddleware, requirePermission('dashboard.view'), asyncHandler(async (req, res) => {
  const range = service.resolveRange(req.query);
  const resumen = await service.getResumen(range);
  res.json({ range, resumen });
}));

router.get('/api/estadisticas/estudios', authMiddleware, requirePermission('dashboard.view'), asyncHandler(async (req, res) => {
  const range = service.resolveRange(req.query);
  const estudios = await service.getEstudios(range, req.query.limit);
  res.json({ range, estudios });
}));

router.get('/api/estadisticas/ventas-dia', authMiddleware, requirePermission('dashboard.view'), asyncHandler(async (req, res) => {
  const range = service.resolveRange(req.query);
  const ventasDia = await service.getVentasDia(range);
  res.json({ range, ventasDia });
}));

router.get('/api/estadisticas/categorias', authMiddleware, requirePermission('dashboard.view'), asyncHandler(async (req, res) => {
  const range = service.resolveRange(req.query);
  const categorias = await service.getCategorias(range);
  res.json({ range, categorias });
}));

router.get('/api/estadisticas/sucursales', authMiddleware, requirePermission('dashboard.view'), asyncHandler(async (_req, res) => {
  const rows = await service.getSucursales();
  res.json(rows.map((row) => row.sucursal));
}));

module.exports = router;
