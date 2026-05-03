const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const { requirePermission } = require('../middlewares/permissionsMiddleware');
const service = require('../services/auth.service');

const router = express.Router();

router.post('/api/login', service.post_login);
router.get('/api/bootstrap/status', service.get_bootstrap_status);
router.post('/api/bootstrap-admin', service.post_bootstrap_admin);
router.get('/api/usuarios/meta', authMiddleware, requirePermission('usuarios.manage'), service.get_usuarios_meta);
router.get('/api/usuarios', authMiddleware, requirePermission('usuarios.manage'), service.get_usuarios);
router.post('/api/usuarios', authMiddleware, requirePermission('usuarios.manage'), service.post_usuarios);
router.put('/api/usuarios/:id', authMiddleware, requirePermission('usuarios.manage'), service.put_usuarios_by_id);
router.delete('/api/usuarios/:id', authMiddleware, requirePermission('usuarios.manage'), service.delete_usuarios_by_id);

module.exports = router;
