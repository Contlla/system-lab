const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const { requirePermission } = require('../middlewares/permissionsMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const service = require('../services/agenda.service');

const router = express.Router();

router.get('/api/agenda/tecnicos', authMiddleware, requirePermission('agenda.view'), asyncHandler(service.get_agenda_tecnicos));
router.post('/api/agenda/tecnicos', authMiddleware, requirePermission('agenda.tech.manage'), asyncHandler(service.post_agenda_tecnicos));
router.delete('/api/agenda/tecnicos/:id', authMiddleware, requirePermission('agenda.tech.manage'), asyncHandler(service.delete_agenda_tecnicos_by_id));
router.get('/api/agenda/disponibilidad', authMiddleware, requirePermission('agenda.view'), asyncHandler(service.get_agenda_disponibilidad));
router.get('/api/agenda/citas', authMiddleware, requirePermission('agenda.view'), asyncHandler(service.get_agenda_citas));
router.post('/api/agenda/citas', authMiddleware, requirePermission('agenda.manage'), asyncHandler(service.post_agenda_citas));
router.patch('/api/agenda/citas/:id/estado', authMiddleware, requirePermission('agenda.manage'), asyncHandler(service.patch_agenda_citas_by_id_estado));
router.put('/api/agenda/citas/:id', authMiddleware, requirePermission('agenda.manage'), asyncHandler(service.put_agenda_citas_by_id));
router.delete('/api/agenda/citas/:id', authMiddleware, requirePermission('agenda.manage'), asyncHandler(service.delete_agenda_citas_by_id));
router.post('/api/agenda/citas/:id/orden', authMiddleware, requirePermission('ordenes.create'), asyncHandler(service.post_agenda_citas_by_id_orden));
router.get('/api/agenda/bloqueos', authMiddleware, requirePermission('agenda.view'), asyncHandler(service.get_agenda_bloqueos));
router.post('/api/agenda/bloqueos', authMiddleware, requirePermission('agenda.block'), asyncHandler(service.post_agenda_bloqueos));
router.delete('/api/agenda/bloqueos/:id', authMiddleware, requirePermission('agenda.block'), asyncHandler(service.delete_agenda_bloqueos_by_id));

module.exports = router;
