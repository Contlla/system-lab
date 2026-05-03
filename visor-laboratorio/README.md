# Visor Laboratorio

Aplicacion Next.js separada para consultar PDFs de resultados medicos desde una
ruta dinamica:

```txt
/resultado/[id]
```

Ejemplo:

```txt
https://mi-visor-lab.vercel.app/resultado/uuid-123
```

## Variables de entorno

Crea `.env.local` en desarrollo o configura estas variables en Vercel:

```bash
NEXT_PUBLIC_R2_URL=https://tu-bucket-publico.r2.dev
NEXT_PUBLIC_R2_OBJECT_TEMPLATE=resultado-{id}.pdf
```

El visor construye la URL final reemplazando `{id}` con el UUID de la ruta. Con
la configuracion anterior, `/resultado/uuid-123` abre:

```txt
https://tu-bucket-publico.r2.dev/resultado-uuid-123.pdf
```

## Desarrollo local

```bash
npm install
npm run dev
```

Abre:

```txt
http://localhost:3000/resultado/demo
```

## Deploy en Vercel

1. Sube esta carpeta a un repositorio de GitHub.
2. En Vercel, selecciona Add New > Project.
3. Importa el repositorio.
4. Configura `NEXT_PUBLIC_R2_URL` y, si cambias el patron de nombre, tambien
   `NEXT_PUBLIC_R2_OBJECT_TEMPLATE`.
5. Ejecuta Deploy.

## Nota para el backend

El backend debe subir cada PDF con un nombre compatible con el patron del visor.
Por defecto:

```txt
resultado-[UUID].pdf
```

Si el backend usa otro key de R2, ajusta `NEXT_PUBLIC_R2_OBJECT_TEMPLATE`.
