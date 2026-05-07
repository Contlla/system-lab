const ROLES = Object.freeze(['admin', 'laboratorio', 'recepcion']);

const PERMISSIONS = Object.freeze([
  'dashboard.view',
  'ordenes.view',
  'ordenes.create',
  'ordenes.edit',
  'ordenes.change_status',
  'ordenes.discount',
  'pacientes.view',
  'pacientes.manage',
  'pacientes.delete',
  'resultados.view',
  'resultados.upload',
  'resultados.delete',
  'caja.view',
  'caja.pay',
  'caja.cut',
  'caja.history',
  'caja.analytics',
  'agenda.view',
  'agenda.manage',
  'agenda.block',
  'agenda.tech.manage',
  'estudios.manage',
  'empresa.manage',
  'usuarios.manage',
]);

const ROLE_PERMISSIONS = Object.freeze({
  admin: PERMISSIONS.slice(),
  recepcion: [
    'dashboard.view',
    'ordenes.view',
    'ordenes.create',
    'ordenes.edit',
    'ordenes.change_status',
    'pacientes.view',
    'pacientes.manage',
    'caja.view',
    'caja.pay',
    'caja.cut',
    'agenda.view',
    'agenda.manage',
    'agenda.block',
  ],
  laboratorio: [
    'dashboard.view',
    'ordenes.view',
    'resultados.view',
    'resultados.upload',
    'resultados.delete',
    'agenda.view',
  ],
});

function isValidRole(role) {
  return ROLES.includes(String(role || '').trim());
}

function normalizePermissions(input) {
  const seen = new Set();
  const list = Array.isArray(input) ? input : [];
  for (const permission of list) {
    const value = String(permission || '').trim();
    if (PERMISSIONS.includes(value)) seen.add(value);
  }
  return Array.from(seen).sort();
}

function getPermissionsForRole(role) {
  return normalizePermissions(ROLE_PERMISSIONS[String(role || '').trim()] || []);
}

function parseStoredPermissions(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return normalizePermissions(parsed);
  } catch {
    return null;
  }
}

function resolveUserPermissions(user = {}) {
  const custom = parseStoredPermissions(user.permissions);
  return custom && custom.length ? custom : getPermissionsForRole(user.role);
}

function serializePermissions(permissions) {
  const normalized = normalizePermissions(permissions);
  return normalized.length ? JSON.stringify(normalized) : null;
}

function buildAuthUser(user = {}) {
  return {
    id: user.id,
    usuario: user.usuario,
    role: user.role,
    permissions: resolveUserPermissions(user),
  };
}

function hasPermission(user, permission) {
  return resolveUserPermissions(user).includes(permission);
}

function hasAnyPermission(user, permissions = []) {
  return permissions.some((permission) => hasPermission(user, permission));
}

module.exports = {
  ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  isValidRole,
  normalizePermissions,
  getPermissionsForRole,
  resolveUserPermissions,
  serializePermissions,
  buildAuthUser,
  hasPermission,
  hasAnyPermission,
};
