const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const { requirePermission } = require('../middlewares/permissionsMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const service = require('../services/caja.service');

const router = express.Router();

router.get('/api/caja/orden/:folio', authMiddleware, requirePermission('caja.view'), asyncHandler(service.get_caja_orden_by_folio));
router.get('/api/caja/sesion-activa', authMiddleware, requirePermission('caja.view'), asyncHandler(service.get_caja_sesion_activa));
router.post('/api/caja/sesion/abrir', authMiddleware, requirePermission('caja.pay'), asyncHandler(service.post_caja_sesion_abrir));
router.post('/api/caja/pago', authMiddleware, requirePermission('caja.pay'), asyncHandler(service.post_caja_pago));
router.get('/api/caja/historial', authMiddleware, requirePermission('caja.view'), asyncHandler(service.get_caja_historial));
router.post('/api/caja/corte', authMiddleware, requirePermission('caja.cut'), asyncHandler(service.post_caja_corte));
router.get('/api/caja/cortes', authMiddleware, requirePermission('caja.history'), asyncHandler(service.get_caja_cortes));
router.get('/api/caja/cortes/:id', authMiddleware, requirePermission('caja.history'), asyncHandler(service.get_caja_cortes_by_id));
router.get('/api/caja/comparativa', authMiddleware, requirePermission('caja.analytics'), asyncHandler(service.get_caja_comparativa));

module.exports = router;
