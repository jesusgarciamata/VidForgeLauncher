# VidForgeLauncher

Dashboard web mínimo para crear jobs de VidForge a partir de registros de NocoDB.

## Flujo implementado

1. El usuario inicia sesión y selecciona `Energy`.
2. La aplicación busca el primer registro con `Status = Ready`, ordenado por `Id` ascendente.
3. Construye el payload de VidForge usando:
   - `Title` como `videoTitle`.
   - `Script` como `customScript`.
   - `Thumb Reference URL` como `referenceThumbnailUrl`.
4. Envía `POST /api/v1/jobs`.
5. Si VidForge devuelve un `jobId`, actualiza NocoDB:
   - `Status = Processing`
   - `VidForgeJobId = <jobId>`
6. Consulta `GET /api/v1/jobs/:id` cada cinco minutos.
7. Si el estado es `completed`, guarda `Status = Done DD/MM` y toma el siguiente `Ready`.
8. Si el estado es `failed` o `canceled`, guarda `Status = Failed`, detiene la cola y no procesa el siguiente registro.

El estado operativo se guarda en `./data/state.json`. Si el contenedor se reinicia durante un job, la aplicación recupera el `VidForgeJobId` y continúa vigilándolo. No guarda claves en ese archivo.

## Requisitos

- Docker Engine con Docker Compose v2.
- Token de NocoDB con permiso de lectura y actualización de registros.
- Clave `vf_live_` de VidForge con permisos `jobs:read` y `jobs:write`.
- Un proxy HTTPS delante de la aplicación para producción.

## Configuración

Crea el archivo local de variables:

```bash
cp .env.example .env
```

Edita `.env` y reemplaza todos los valores de ejemplo. Para generar el secreto de sesión:

```bash
openssl rand -hex 32
```

Variables principales:

| Variable | Uso |
| --- | --- |
| `DASHBOARD_USERNAME` | Usuario del dashboard |
| `DASHBOARD_PASSWORD` | Contraseña del dashboard |
| `SESSION_SECRET` | Firma de sesiones, mínimo 32 caracteres |
| `NOCODB_BASE_URL` | URL base de NocoDB, sin `/` final |
| `NOCODB_API_TOKEN` | Token enviado en el header `xc-token` |
| `NOCODB_API_VERSION` | `v2` de forma predeterminada; admite `v3` |
| `NOCODB_BASE_ID` | `ppoykmwtf0y84pc`; obligatorio para v3 |
| `NOCODB_TABLE_ID` | `ma5ngj90aoavswq` |
| `VIDFORGE_BASE_URL` | URL base de VidForge |
| `VIDFORGE_API_KEY` | Clave Bearer `vf_live_` |
| `POLL_INTERVAL_MS` | `300000`, equivalente a cinco minutos |
| `COOKIE_SECURE` | Debe ser `true` cuando el navegador usa HTTPS |

El archivo de ejemplo usa la IP pública indicada:

```env
NOCODB_BASE_URL=http://5.78.183.239:8008
```

Ese endpoint transmite el token y los datos sin cifrado. Si el dominio está operativo, la configuración más segura es:

```env
NOCODB_BASE_URL=https://nocodb.n8ngsus.uk
VIDFORGE_BASE_URL=https://vidforge.n8ngsus.uk
COOKIE_SECURE=true
```

Para una prueba local por HTTP, usa temporalmente `COOKIE_SECURE=false`. No lo mantengas así en producción.

## Inicio con Docker

```bash
docker compose up -d --build
```

La interfaz queda disponible en:

```text
http://SERVIDOR:3000
```

Comandos útiles:

```bash
docker compose logs -f vidforge-launcher
docker compose ps
docker compose down
```

El endpoint público de salud es `GET /health`.

## Pruebas

No hay dependencias de npm. Con Node.js 22 o superior:

```bash
npm test
npm run check
```

Las pruebas comprueban el payload, el filtro y actualización de NocoDB, el formato `Done DD/MM`, la continuación después de `completed` y la detención después de `failed`.

## Decisiones del payload

El payload conserva el preset solicitado para formato, voz, carpeta y modelo. Se omite `videoLengthMinutes` porque la API de VidForge indica que no debe enviarse junto con `customScript`. También se omiten controles exclusivos de la interfaz, como `customScriptEnabled` y `referenceVideoEnabled`.

## Reintentos

No existen reintentos automáticos de un job fallido. El botón `Reintentar` requiere una acción explícita:

- Para un job `failed`, llama a `POST /api/v1/jobs/:id/retry` y conserva el mismo `VidForgeJobId`.
- Para una interrupción de red o autenticación, reanuda la consulta del mismo job.
- Para un envío que no llegó a devolver `jobId` o un job cancelado, devuelve el registro a `Ready` y crea un job nuevo. Esto puede duplicar trabajo si VidForge recibió una solicitud cuya respuesta se perdió, por lo que la interfaz solicita confirmación.

## Seguridad

- Las claves solo se leen desde variables de entorno.
- `.env` está excluido de Git y de la imagen Docker.
- La cookie de sesión es `HttpOnly`, `SameSite=Strict` y `Secure` por defecto.
- El contenedor se ejecuta como usuario sin privilegios.
- La autenticación debe utilizarse detrás de HTTPS.
