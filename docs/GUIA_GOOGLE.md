# Configurar Google Cloud (Calendar, Drive y Docs)

Esta guía crea el cliente OAuth que usa la app. No incluyas nunca el secreto del cliente en el
código ni en `config.json`: se guarda en el llavero con `reuniones secrets set google.clientSecret`.

## 1. Proyecto y APIs

1. Abre <https://console.cloud.google.com> y crea un proyecto, por ejemplo `reuniones-app-personal`.
2. En **APIs y servicios → Biblioteca**, habilita:
   - Google Calendar API
   - Google Drive API
   - Google Docs API

## 2. Pantalla de consentimiento de OAuth

1. **Google Auth Platform → Público/Branding**: nombre de la app y correo de soporte.
2. **Audiencia**: tipo *Externo* para una cuenta personal, o *Interno* si usas Google Workspace
   de tu organización.
3. Mientras la app esté en modo *Prueba*, añade tu cuenta en **Usuarios de prueba**. Los
   tokens de usuarios de prueba caducan a los 7 días; para uso continuado publica la app.
4. **Acceso a datos (scopes)**: añade exactamente estos scopes:

| Scope | Para qué |
|---|---|
| `openid`, `email` | Identificar la cuenta conectada |
| `https://www.googleapis.com/auth/calendar.calendarlist.readonly` | Listar calendarios |
| `https://www.googleapis.com/auth/calendar.events.readonly` | Leer eventos |
| `https://www.googleapis.com/auth/drive.file` | Crear la carpeta y los documentos de la app |

No se pide ningún permiso de escritura en el calendario ni de acceso al Drive completo.

## 3. Cliente OAuth

1. **Clientes → Crear cliente → Aplicación de escritorio**.
2. Copia el **ID de cliente** en `config.json` (`google.clientId`).
3. Si Google te muestra un secreto de cliente, guárdalo en el llavero:
   `echo -n "EL_SECRETO" | reuniones secrets set google.clientSecret`.

## 4. Primera conexión

```bash
npm run build
node dist/src/cli/main.js connect google --login-hint tu.correo@gmail.com
```

La CLI muestra una URL. Ábrela, elige la cuenta, acepta los permisos y el navegador volverá a
`http://127.0.0.1:<puerto>/callback`, que la app escucha solo durante la autorización.

## Limitación conocida: carpeta «reuniones grabadas»

Con `drive.file`, la app solo ve las carpetas que ella crea. Si ya tienes una carpeta con ese
nombre creada a mano, la app creará una nueva en lugar de reutilizarla, salvo que indiques su
ID:

```bash
node dist/src/cli/main.js settings set driveFolderId '"ID_DE_LA_CARPETA"'
```

Si la app no puede acceder a esa carpeta, lo indica en lugar de crear un duplicado. Ver
`docs/LIMITACIONES.md`.
