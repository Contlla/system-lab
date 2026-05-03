const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const { requirePermission } = require('../middlewares/permissionsMiddleware');
const service = require('../services/agenda.service');

const router = express.Router();

router.get('/api/agenda/tecnicos', authMiddleware, requirePermission('agenda.view'), service.get_agenda_tecnicos);
router.post('/api/agenda/tecnicos', authMiddleware, requirePermission('agenda.tech.manage'), service.post_agenda_tecnicos);
router.delete('/api/agenda/tecnicos/:id', authMiddleware, requirePermission('agenda.tech.manage'), service.delete_agenda_tecnicos_by_id);
router.get('/api/agenda/disponibilidad', authMiddleware, requirePermission('agenda.view'), service.get_agenda_disponibilidad);
router.get('/api/agenda/citas', authMiddleware, requirePermission('agenda.view'), service.get_agenda_citas);
router.post('/api/agenda/citas', authMiddleware, requirePermission('agenda.manage'), service.post_agenda_citas);
router.patch('/api/agenda/citas/:id/estado', authMiddleware, requirePermission('agenda.manage'), service.patch_agenda_citas_by_id_estado);
router.put('/api/agenda/citas/:id', authMiddleware, requirePermission('agenda.manage'), service.put_agenda_citas_by_id);
router.delete('/api/agenda/citas/:id', authMiddleware, requirePermission('agenda.manage'), service.delete_agenda_citas_by_id);
router.post('/api/agenda/citas/:id/orden', authMiddleware, requirePermission('ordenes.create'), service.post_agenda_citas_by_id_orden);
router.get('/api/agenda/bloqueos', authMiddleware, requirePermission('agenda.view'), service.get_agenda_bloqueos);
router.post('/api/agenda/bloqueos', authMiddleware, requirePermission('agenda.block'), service.post_agenda_bloqueos);
router.delete('/api/agenda/bloqueos/:id', authMiddleware, requirePermission('agenda.block'), service.delete_agenda_bloqueos_by_id);

module.exports = router;
