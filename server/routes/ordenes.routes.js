const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const { requirePermission } = require('../middlewares/permissionsMiddleware');
const service = require('../services/ordenes.service');

const router = express.Router();

router.get('/api/estudios', authMiddleware, requirePermission('ordenes.view'), service.get_estudios);
router.post('/api/estudios', authMiddleware, requirePermission('estudios.manage'), service.post_estudios);
router.put('/api/estudios/:id', authMiddleware, requirePermission('estudios.manage'), service.put_estudios_by_id);
router.delete('/api/estudios/:id', authMiddleware, requirePermission('estudios.manage'), service.delete_estudios_by_id);
router.post('/api/orden', authMiddleware, requirePermission('ordenes.create'), service.post_orden);
router.get('/api/orden/:folio/etiquetas', authMiddleware, requirePermission('ordenes.view'), service.get_orden_by_folio_etiquetas);
router.post('/api/orden/:folio/etiquetas/registrar-impresion', authMiddleware, requirePermission('ordenes.view'), service.post_orden_by_folio_etiquetas_registrar_impresion);
router.get('/api/orden/:folio', authMiddleware, requirePermission('ordenes.view'), service.get_orden_by_folio);
router.patch('/api/orden/:folio/estado', authMiddleware, requirePermission('ordenes.change_status'), service.patch_orden_by_folio_estado);
router.post('/api/orden/:folio/estudios', authMiddleware, requirePermission('ordenes.edit'), service.post_orden_by_folio_estudios);
router.delete('/api/orden/:folio/estudio/:estudioId', authMiddleware, requirePermission('ordenes.edit'), service.delete_orden_by_folio_estudio_by_estudioId);
router.get('/api/empresa', authMiddleware, requirePermission('dashboard.view'), service.get_empresa);
router.put('/api/empresa', authMiddleware, requirePermission('empresa.manage'), service.put_empresa);
router.get('/api/ordenes/buscar', authMiddleware, requirePermission('ordenes.view'), service.get_ordenes_buscar);
router.get('/api/dashboard', authMiddleware, requirePermission('dashboard.view'), service.get_dashboard);
router.get('/api/pacientes', authMiddleware, requirePermission('pacientes.view'), service.get_pacientes);
router.post('/api/pacientes', authMiddleware, requirePermission('pacientes.manage'), service.post_pacientes);
router.get('/api/pacientes/siguiente-registro', authMiddleware, requirePermission('pacientes.view'), service.get_pacientes_siguiente_registro);
router.put('/api/pacientes/:id', authMiddleware, requirePermission('pacientes.manage'), service.put_pacientes_by_id);
router.delete('/api/pacientes/:id', authMiddleware, requirePermission('pacientes.delete'), service.delete_pacientes_by_id);
router.get('/api/pacientes/:id/detalle', authMiddleware, requirePermission('pacientes.view'), service.get_pacientes_by_id_detalle);

module.exports = router;
