const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const { requirePermission } = require('../middlewares/permissionsMiddleware');
const service = require('../services/resultados.service');
const resultadosController = require('../controllers/resultados.controller');

const router = express.Router();

router.get('/api/resultados/pendientes', authMiddleware, requirePermission('resultados.view'), service.get_resultados_pendientes);
router.get('/api/resultados/completados', authMiddleware, requirePermission('resultados.view'), service.get_resultados_completados);
router.get('/api/resultados/orden/:folio', authMiddleware, requirePermission('resultados.view'), service.get_resultados_orden_by_folio);
router.get('/api/resultados/ver/:filename', authMiddleware, requirePermission('resultados.view'), service.get_resultados_ver_by_filename);
router.post(
  '/api/resultados/subir',
  authMiddleware,
  requirePermission('resultados.upload'),
  resultadosController.uploadResultadoPdfMiddleware,
  resultadosController.uploadResultadosToR2
);
router.delete('/api/resultados/archivo/:id', authMiddleware, requirePermission('resultados.delete'), service.delete_resultados_archivo_by_id);
router.post('/api/resultados/completar/:ordenId', authMiddleware, requirePermission('resultados.upload'), service.post_resultados_completar_by_ordenId);
router.post('/api/resultados/reabrir/:ordenId', authMiddleware, requirePermission('resultados.upload'), service.post_resultados_reabrir_by_ordenId);

module.exports = router;
