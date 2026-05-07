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
RESULTADOS_API_BASE_URL=https://tu-backend-lab.example.com
```

Si `RESULTADOS_API_BASE_URL` esta configurado, el visor primero consulta:

```txt
https://tu-backend-lab.example.com/api/public/resultados/uuid-123
```

Ese endpoint permite abrir resultados historicos backfilleados aunque el PDF no
viva en R2. Si el backend no esta configurado o no conoce el UUID, el visor cae
al modo R2 anterior y construye la URL final reemplazando `{id}` con el UUID de
la ruta. Con la configuracion anterior, `/resultado/uuid-123` abre:

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
http://localhost:3000/resultado/00000000-0000-4000-8000-000000000000
```

## Deploy en Vercel

1. Sube esta carpeta a un repositorio de GitHub.
2. En Vercel, selecciona Add New > Project.
3. Importa el repositorio.
4. Configura `RESULTADOS_API_BASE_URL`. Mantén `NEXT_PUBLIC_R2_URL` y, si
   cambias el patron de nombre, tambien `NEXT_PUBLIC_R2_OBJECT_TEMPLATE` como
   fallback para resultados subidos directo a R2.
5. Ejecuta Deploy.

## Nota para el backend

El backend expone resultados por UUID en:

```txt
/api/public/resultados/[resultado_uuid]
/api/public/resultados/[resultado_uuid]/pdf
```

Los registros historicos de `resultado_archivos` se backfillean con
`resultado_uuid` y `qr_base64` al iniciar el backend. El enlace publico queda en
la forma:

```txt
https://tu-visor.vercel.app/resultado/[resultado_uuid]
```

Para cargas nuevas en R2, el backend tambien sube cada PDF con un nombre
compatible con el patron del visor. Por defecto:

```txt
resultado-[UUID].pdf
```

Si el backend usa otro key de R2, ajusta `NEXT_PUBLIC_R2_OBJECT_TEMPLATE`.

## Seguridad pendiente recomendada

La ruta del backend ya permite servir el PDF mediante un endpoint controlado. El
siguiente paso recomendado es mantener el bucket R2 privado y servir tambien las
cargas nuevas mediante `/api/public/resultados/[resultado_uuid]/pdf`.
