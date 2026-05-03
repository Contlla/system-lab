const express = require('express');
const authRoutes = require('./auth.routes');
const cajaRoutes = require('./caja.routes');
const ordenesRoutes = require('./ordenes.routes');
const agendaRoutes = require('./agenda.routes');
const resultadosRoutes = require('./resultados.routes');

const router = express.Router();

router.use(authRoutes);
router.use(cajaRoutes);
router.use(ordenesRoutes);
router.use(agendaRoutes);
router.use(resultadosRoutes);

module.exports = router;
